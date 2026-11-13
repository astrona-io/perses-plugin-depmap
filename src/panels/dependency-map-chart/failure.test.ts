import { estateModel } from "../../test-utils/estate";
import {
  evaluateFailure,
  evaluateHa,
  hardWiredClients,
  loseOneServer,
  needsOf,
} from "./failure";
import { DepEdge, DepModel, ServiceNode } from "./model";

function node(
  p: Partial<ServiceNode> & { id: string; hosts: string[] },
): ServiceNode {
  const { hosts, ...rest } = p;
  return {
    name: p.id,
    wave: 0,
    kind: "internal",
    ha: "single",
    minUp: 1,
    instances: hosts.map((h, i) => ({ host: h, ip: `10.0.0.${i + 1}` })),
    ...rest,
  };
}

function edge(
  source: string,
  target: string,
  pins: Record<string, string> = {},
): DepEdge {
  return {
    id: `${source}->${target}:1`,
    source,
    target,
    port: 1,
    hoursSeen: 1,
    share: 1,
    frequency: "constantly",
    lastSeen: 0,
    pairs: {},
    pins,
    processes: [],
    crosses: [],
  };
}

function model(nodes: ServiceNode[], edges: DepEdge[]): DepModel {
  return {
    nodes,
    edges,
    byId: new Map(nodes.map((n) => [n.id, n])),
    windowHours: 1,
  };
}

describe("evaluateHa", () => {
  it("single: any instance down is down", () => {
    expect(evaluateHa(node({ id: "s", hosts: ["a"] }), new Set(["a"]))).toEqual(
      {
        state: "down",
        reason: "a is down",
      },
    );
    expect(evaluateHa(node({ id: "s", hosts: ["a"] }), new Set()).state).toBe(
      "ok",
    );
  });

  it("active-passive: standby down, primary down, both down", () => {
    const n = node({ id: "db", ha: "active-passive", hosts: ["db01", "db02"] });
    expect(evaluateHa(n, new Set(["db02"]))).toEqual({
      state: "reduced",
      reason: "standby db02 down, no failover left",
    });
    expect(evaluateHa(n, new Set(["db01"]))).toEqual({
      state: "failover",
      reason: "fails over to db02",
    });
    expect(evaluateHa(n, new Set(["db01", "db02"]))).toEqual({
      state: "down",
      reason: "primary and standby down",
    });
  });

  it("active-active: reduced with load, overload past 100%, unknown load, minUp", () => {
    const n = node({
      id: "web",
      ha: "active-active",
      load: 65,
      hosts: ["a", "b"],
    });
    expect(evaluateHa(n, new Set(["a"]))).toEqual({
      state: "overload",
      reason: "1 of 2 up, needs 130% capacity",
    });
    const three = node({
      id: "web",
      ha: "active-active",
      load: 40,
      hosts: ["a", "b", "c"],
    });
    expect(evaluateHa(three, new Set(["a"]))).toEqual({
      state: "reduced",
      reason: "2 of 3 up, 60% load",
    });
    expect(evaluateHa({ ...three, load: undefined }, new Set(["a"]))).toEqual({
      state: "reduced",
      reason: "2 of 3 up, load unknown",
    });
    expect(evaluateHa(three, new Set(["a", "b", "c"]))).toEqual({
      state: "down",
      reason: "all nodes down",
    });
    expect(evaluateHa({ ...three, minUp: 2 }, new Set(["a", "b"]))).toEqual({
      state: "down",
      reason: "only 1 of 3 up, needs 2",
    });
  });

  it("quorum: majority kept or lost", () => {
    const n = node({ id: "ldap", ha: "quorum", hosts: ["l1", "l2", "l3"] });
    expect(evaluateHa(n, new Set(["l1"]))).toEqual({
      state: "reduced",
      reason: "2 of 3 up, quorum kept",
    });
    expect(evaluateHa(n, new Set(["l1", "l2"]))).toEqual({
      state: "down",
      reason: "quorum lost (1 of 3)",
    });
    const four = node({ id: "q", ha: "quorum", hosts: ["a", "b", "c", "d"] });
    expect(evaluateHa(four, new Set(["a", "b"])).state).toBe("down");
  });

  it("a service without instances (external) never goes down", () => {
    expect(
      evaluateHa(node({ id: "x", kind: "external", hosts: [] }), new Set(["a"]))
        .state,
    ).toBe("ok");
  });
});

describe("evaluateFailure on small graphs", () => {
  it("propagates transitively: needs, then via", () => {
    const m = model(
      [
        node({ id: "a", hosts: ["a1"] }),
        node({ id: "b", hosts: ["b1"] }),
        node({ id: "c", hosts: ["c1"] }),
      ],
      [edge("a", "b"), edge("b", "c")],
    );
    const r = evaluateFailure(m, ["c1"]);
    expect(r.services.get("c")).toMatchObject({ state: "down" });
    expect(r.services.get("b")).toMatchObject({
      state: "broken",
      reason: "needs c",
    });
    expect(r.services.get("a")).toMatchObject({
      state: "brokenvia",
      reason: "via b",
    });
    expect(r.outages).toEqual(["c", "b", "a"]);
    expect(r.edges.get("a->b:1")).toBe("cut");
  });

  it("terminates on cycles", () => {
    const m = model(
      [node({ id: "a", hosts: ["a1"] }), node({ id: "b", hosts: ["b1"] })],
      [edge("a", "b"), edge("b", "a")],
    );
    const r = evaluateFailure(m, ["a1"]);
    expect(r.services.get("a")!.state).toBe("down");
    expect(r.services.get("b")!.state).toBe("broken");
  });

  it("puts callers of a failing-over or overloaded service at risk, without breaking them", () => {
    const m = model(
      [
        node({ id: "app", hosts: ["x"] }),
        node({ id: "db", ha: "active-passive", hosts: ["db01", "db02"] }),
        node({ id: "web", ha: "active-active", load: 80, hosts: ["w1", "w2"] }),
        node({ id: "lb", hosts: ["l"] }),
      ],
      [edge("app", "db"), edge("lb", "web")],
    );
    const r = evaluateFailure(m, ["db01", "w1"]);
    expect(r.services.get("db")!.state).toBe("failover");
    expect(r.services.get("app")).toMatchObject({
      state: "risk",
      reason: "db is failing over",
    });
    expect(r.services.get("web")!.state).toBe("overload");
    expect(r.services.get("lb")).toMatchObject({
      state: "risk",
      reason: "web is overloaded",
    });
    expect(r.outages).toEqual([]);
    expect(r.edges.get("app->db:1")).toBe("risk");
  });

  it("a hard-wired caller breaks although its callee fails over", () => {
    const m = model(
      [
        node({ id: "erp", hosts: ["win05"] }),
        node({ id: "db", ha: "active-passive", hosts: ["db01", "db02"] }),
      ],
      [edge("erp", "db", { win05: "db01" })],
    );
    const r = evaluateFailure(m, ["db01"]);
    expect(r.services.get("erp")).toMatchObject({
      state: "broken",
      reason: "hard-wired to db01, failover can't help",
      lostInstances: ["win05"],
    });
    expect(r.edges.get("erp->db:1")).toBe("pinlost");
    // Down the standby instead: the pinned caller does not care.
    expect(evaluateFailure(m, ["db02"]).services.get("erp")!.state).toBe("ok");
  });

  it("one of two pinned instances lost degrades or overloads the caller", () => {
    const nodes = [
      node({ id: "web", ha: "active-active", load: 40, hosts: ["w1", "w2"] }),
      node({ id: "ldap", ha: "quorum", hosts: ["l1", "l2", "l3"] }),
    ];
    const m = model(nodes, [edge("web", "ldap", { w1: "l1" })]);
    const r = evaluateFailure(m, ["l1"]);
    expect(r.services.get("ldap")!.state).toBe("reduced");
    expect(r.services.get("web")).toMatchObject({
      state: "degraded",
      reason: "w1 hard-wired to l1; 1 of 2 up, 80% load",
    });
    nodes[0]!.load = 70;
    expect(evaluateFailure(m, ["l1"]).services.get("web")).toMatchObject({
      state: "overload",
      reason: "w1 hard-wired to l1; 1 of 2 up, needs 140% capacity",
    });
  });

  it("follows chains of hard-wired callers to a fixpoint", () => {
    const m = model(
      [
        node({ id: "a", ha: "active-passive", hosts: ["a1", "a2"] }),
        node({ id: "b", ha: "active-passive", hosts: ["b1", "b2"] }),
        node({ id: "c", ha: "active-passive", hosts: ["c1", "c2"] }),
      ],
      [
        edge("a", "b", { a1: "b1", a2: "b1" }),
        edge("b", "c", { b1: "c1", b2: "c1" }),
      ],
    );
    const r = evaluateFailure(m, ["c1"]);
    expect(r.services.get("c")!.state).toBe("failover");
    expect(r.services.get("b")).toMatchObject({
      state: "broken",
      lostInstances: ["b1", "b2"],
    });
    expect(r.services.get("a")!.state).toBe("broken");
    expect(r.services.get("a")!.lostInstances).toEqual(["a1", "a2"]);
  });

  it("several instances down at once combine", () => {
    const m = model(
      [
        node({ id: "app", hosts: ["x"] }),
        node({ id: "db", ha: "active-passive", hosts: ["db01", "db02"] }),
        node({ id: "mq", hosts: ["mq01"] }),
      ],
      [edge("app", "db"), edge("app", "mq")],
    );
    const r = evaluateFailure(m, ["db01", "db02", "mq01"]);
    expect(r.services.get("db")!.state).toBe("down");
    expect(r.services.get("mq")!.state).toBe("down");
    expect(r.services.get("app")!.state).toBe("broken");
    expect(r.counts.down).toBe(2);
    expect(r.counts.broken).toBe(1);
  });

  it("nothing down, everything ok", () => {
    const r = evaluateFailure(estateModel(), []);
    expect(r.outages).toEqual([]);
    expect([...r.services.values()].every((s) => s.state === "ok")).toBe(true);
  });
});

describe("evaluateFailure on the example estate (the concept's presets)", () => {
  const m = estateModel();
  const state = (down: string[]): Record<string, string> =>
    Object.fromEntries(
      [...evaluateFailure(m, down).services].map(([id, s]) => [id, s.state]),
    );

  it("db01: oracle fails over, erp-sync is hard-wired and breaks, oracle's other callers at risk", () => {
    const r = evaluateFailure(m, ["db01"]);
    expect(r.services.get("oracle")).toMatchObject({
      state: "failover",
      reason: "fails over to db02",
    });
    expect(r.services.get("erp")).toMatchObject({
      state: "broken",
      reason: "hard-wired to db01, failover can't help",
    });
    expect(state(["db01"])).toMatchObject({
      billing: "risk",
      reports: "risk",
      import: "risk",
      portal: "ok",
    });
    expect(r.outages).toEqual(["erp"]);
  });

  it("ldap01 + ldap02: quorum lost, portal and erp-sync break, everything in front breaks via them", () => {
    const r = evaluateFailure(m, ["ldap01", "ldap02"]);
    expect(r.services.get("ldap")).toMatchObject({
      state: "down",
      reason: "quorum lost (1 of 3)",
    });
    expect(r.services.get("erp")).toMatchObject({
      state: "broken",
      reason: "needs ldap",
    });
    expect(r.services.get("portal")!.state).toBe("broken");
    expect(r.services.get("api")).toMatchObject({
      state: "brokenvia",
      reason: "via portal",
    });
    expect(r.services.get("lb")).toMatchObject({
      state: "brokenvia",
      reason: "via api-gw",
    });
    expect(new Set(r.outages)).toEqual(
      new Set(["ldap", "portal", "erp", "api", "lb"]),
    );
  });

  it("ldap01 alone: quorum kept, but portal is hard-wired to it and breaks", () => {
    const r = evaluateFailure(m, ["ldap01"]);
    expect(r.services.get("ldap")!.state).toBe("reduced");
    expect(r.services.get("portal")).toMatchObject({
      state: "broken",
      reason: "hard-wired to ldap01, failover can't help",
    });
    expect(r.services.get("erp")!.state).toBe("ok");
  });

  it("app01: portal on one node needs 130% and overloads; api-gw at risk", () => {
    const r = evaluateFailure(m, ["app01"]);
    expect(r.services.get("portal")).toMatchObject({
      state: "overload",
      reason: "1 of 2 up, needs 130% capacity",
    });
    expect(r.services.get("api")).toMatchObject({
      state: "risk",
      reason: "portal is overloaded",
    });
    expect(r.outages).toEqual([]);
  });

  it("nfs01: portal and file-import break, api-gw and the load balancer via portal", () => {
    expect(state(["nfs01"])).toMatchObject({
      nfs: "down",
      portal: "broken",
      import: "broken",
      api: "brokenvia",
      lb: "brokenvia",
      billing: "ok",
    });
  });

  it("the unknown address behind oracle takes nearly everything down", () => {
    const r = evaluateFailure(m, ["10.1.7.22"]);
    expect(r.services.get("oracle")).toMatchObject({
      state: "broken",
      reason: "needs 10.1.7.22",
    });
    expect(r.services.get("lb")!.state).toBe("brokenvia");
  });
});

describe("lose one server", () => {
  const m = estateModel();
  const spofs = loseOneServer(m);
  const hosts = spofs.map((s) => s.host);

  it("finds every single point of failure, worst first", () => {
    for (const h of [
      "ldap01",
      "db01",
      "nfs01",
      "app02",
      "10.1.7.22",
      "mq01",
      "app03",
      "win05",
      "smtp01",
    ])
      expect(hosts).toContain(h);
    // HA members whose loss is absorbed are not single points of failure.
    for (const h of [
      "edge01",
      "edge02",
      "app01",
      "app04",
      "db02",
      "ldap02",
      "ldap03",
    ])
      expect(hosts).not.toContain(h);
    const counts = spofs.map((s) => s.outages.length);
    expect([...counts].sort((a, b) => b - a)).toEqual(counts);
    expect(spofs[0]!.host).toBe("10.1.7.22");
  });

  it("finds both hard-wired clients", () => {
    expect(spofs.find((s) => s.host === "db01")!.outages).toEqual(["erp"]);
    expect(spofs.find((s) => s.host === "ldap01")!.outages).toEqual(
      expect.arrayContaining(["portal", "api", "lb"]),
    );
    expect(
      hardWiredClients(m).map((c) => `${c.callerHost}->${c.calleeHost}`),
    ).toEqual(
      expect.arrayContaining([
        "win05->db01",
        "app01->ldap01",
        "app04->ldap01",
        "app03->perses-plugin-depmap-worker2",
      ]),
    );
    expect(hardWiredClients(m)).toHaveLength(4);
  });
});

describe("needsOf", () => {
  it("lists transitive callees", () => {
    const needs = needsOf(estateModel(), "lb");
    expect(needs).toEqual(
      new Set([
        "api",
        "portal",
        "billing",
        "ldap",
        "nfs",
        "oracle",
        "orders",
        "mq",
        "ext:bank-api.example.com",
        "ip:10.1.7.22",
      ]),
    );
    expect(needsOf(estateModel(), "smtp").size).toBe(0);
  });
});

import {
  CLUSTER,
  HYBRID_YAML,
  hybridMapping,
  hybridModel,
  hybridSamples,
} from "../../test-utils/hybrid";
import { DEFAULT_THRESHOLDS } from "./dependency-map-chart-types";
import {
  evaluateFailure,
  expandDown,
  hopChains,
  loseOneServer,
} from "./failure";
import {
  firewallRulesForCluster,
  firewallRulesForWave,
  formatRule,
  wavesOf,
} from "./firewall";
import { laneSpecs, layoutGraph } from "./layout";
import { buildModel } from "./model";

const PRICING = `k8s:${CLUSTER}/shop/pricing`;
const NAT = `nat:${CLUSTER}:worker2`;

describe("hybrid estate: model", () => {
  const m = hybridModel();

  it("VMs, mapped and automatic workloads and the unexplained SNAT as one graph", () => {
    expect(m.nodes.map((n) => n.id).sort()).toEqual(
      ["billing", "oracle", "orders", PRICING, NAT].sort(),
    );
    expect(m.stitch).toEqual({
      snatMatched: 1,
      snatUnknown: 1,
      serviceFolded: 1,
      nodeToPod: 2,
      plumbing: 2,
    });
  });

  it("an edge lists the named ranges (OBI src_cidr / dst_cidr) it crosses", () => {
    const samples = hybridSamples().map((x) =>
      x.src === "10.244.1.4" && x.dst === "10.1.2.10"
        ? { ...x, srcCidr: "pods", dstCidr: "old-dc" }
        : x,
    );
    const e = hybridModel(samples).edges.find(
      (x) => x.source === "orders" && x.target === "oracle",
    )!;
    expect(e.crosses).toEqual(["pods -> old-dc"]);
    expect(m.edges.find((x) => x.source === "billing")!.crosses).toEqual([]);
  });

  it("a mapped workload: its pods as instances on their nodes, HA from replicas", () => {
    const orders = m.byId.get("orders")!;
    expect(orders.ha).toBe("active-active");
    expect(orders.replicas).toBe(2);
    expect(orders.k8s).toMatchObject({
      cluster: CLUSTER,
      type: "workload",
      namespace: "shop",
      workload: "orders",
    });
    expect(orders.instances.map((i) => [i.host, i.node]).sort()).toEqual([
      ["orders-7d9f-a", "worker"],
      ["orders-7d9f-b", "worker2"],
    ]);
  });

  it("an unmapped workload is grouped by namespace and owner, active-active when more than one pod", () => {
    const p = m.byId.get(PRICING)!;
    expect(p.ha).toBe("active-active");
    expect(p.instances).toHaveLength(2);
    expect(p.k8s?.type).toBe("workload");
  });

  it("the VM -> NodePort -> pod -> VM chain is connected", () => {
    const ids = m.edges.map((e) => `${e.source}->${e.target}:${e.port}`).sort();
    expect(ids).toEqual(
      [
        "billing->orders:30080",
        `${NAT}->oracle:1521`,
        `orders->${PRICING}:8080`,
        "orders->oracle:1521",
      ].sort(),
    );
    const np = m.edges.find((e) => e.source === "billing")!;
    expect(np.pairs).toEqual({ app03: ["worker2"] });
    // One node of a multi-node cluster: the VM is pinned to it.
    expect(np.pins).toEqual({ app03: "worker2" });
    const db = m.edges.find(
      (e) => e.source === "orders" && e.target === "oracle",
    )!;
    expect(db.pairs).toEqual({ "orders-7d9f-a": ["vip"] });
  });

  it("unexplained SNAT stays visible, as a node of its own with the node address", () => {
    const nat = m.byId.get(NAT)!;
    expect(nat.name).toBe("via node worker2 (NAT, pod unknown)");
    expect(nat.instances).toEqual([
      expect.objectContaining({ host: "worker2", ip: "10.1.8.12" }),
    ]);
    const e = m.edges.find((x) => x.source === NAT)!;
    expect(e.hoursSeen).toBe(6);
  });

  it("knows the cluster and its node addresses", () => {
    expect(m.clusters?.get(CLUSTER)?.nodes).toEqual([
      { name: "control-plane", ip: "10.1.8.10" },
      { name: "worker", ip: "10.1.8.11" },
      { name: "worker2", ip: "10.1.8.12" },
    ]);
  });

  it("v0.1 mappings and VM-only samples build the same model as before", () => {
    const vmOnly = hybridSamples().filter(
      (s) => !s.srcK8s && !s.dstK8s && !s.src.startsWith("10.1.8."),
    );
    const text = HYBRID_YAML.split("kubernetes:")[0]!;
    const r = buildModel(hybridMapping(text), vmOnly, DEFAULT_THRESHOLDS, 24);
    expect(r.nodes.some((n) => n.k8s)).toBe(false);
    expect(r.stitch).toEqual({
      snatMatched: 0,
      snatUnknown: 0,
      serviceFolded: 0,
      nodeToPod: 0,
      plumbing: 0,
    });
  });
});

describe("hybrid estate: failure across the boundary", () => {
  const m = hybridModel();

  it("a node down takes its pods with it", () => {
    const down = expandDown(m, ["worker2"]);
    expect(down.has("orders-7d9f-b")).toBe(true);
    expect(down.has("pricing-5c6b-b")).toBe(true);
    expect(down.has("orders-7d9f-a")).toBe(false);
  });

  it("worker2 down: the VM pinned to its NodePort breaks, the workloads run reduced", () => {
    const r = evaluateFailure(m, ["worker2"]);
    expect(r.services.get("billing")?.state).toBe("broken");
    expect(r.services.get("billing")?.reason).toContain("worker2");
    expect(r.services.get("orders")?.state).toBe("reduced");
    expect(r.services.get("orders")?.reason).toContain(
      "Kubernetes reschedules",
    );
    expect(r.services.get(PRICING)?.state).toBe("reduced");
    expect(r.services.get(NAT)?.state).toBe("down");
    expect(r.services.get("oracle")?.state).toBe("ok");
  });

  it("losing one server lists each node once and finds the pinned NodePort", () => {
    const spofs = loseOneServer(m);
    const hosts = spofs.map((s) => s.host);
    expect(new Set(hosts).size).toBe(hosts.length);
    expect(hosts).toContain("worker2");
  });

  it("the hop chain through a workload runs from the VM caller to the VM it calls", () => {
    const c = hopChains(m, "orders");
    expect([...c.nodes].sort()).toEqual(
      ["billing", "oracle", "orders", PRICING].sort(),
    );
    const ids = new Set(
      m.edges
        .filter((e) => c.edges.has(e.id))
        .map((e) => `${e.source}->${e.target}`),
    );
    expect(ids).toEqual(
      new Set(["billing->orders", `orders->${PRICING}`, "orders->oracle"]),
    );
  });
});

describe("hybrid estate: firewall at the cluster boundary", () => {
  const m = hybridModel();

  it("Kubernetes is not a wave", () => {
    expect(wavesOf(m)).toEqual([2]);
  });

  it("VM -> NodePort goes to the node it is pinned to; pod -> VM leaves from the node addresses", () => {
    const lines = firewallRulesForCluster(m, CLUSTER).map(formatRule);
    expect(lines).toContain(
      "app03 (10.1.1.13) -> worker2 (10.1.8.12):30080/tcp",
    );
    for (const node of [
      "control-plane (10.1.8.10)",
      "worker (10.1.8.11)",
      "worker2 (10.1.8.12)",
    ]) {
      expect(lines).toContain(`${node} -> db01 (10.1.2.11):1521/tcp`);
      expect(lines).toContain(`${node} -> oracle vip (10.1.2.10):1521/tcp`);
    }
    expect(lines.some((l) => l.includes("10.244."))).toBe(false);
  });

  it("an egress gateway replaces the node addresses as source", () => {
    const text = HYBRID_YAML.replace(
      "      nodes:",
      "      egressIps: [10.1.8.100]\n      nodes:",
    );
    const mm = buildModel(
      hybridMapping(text),
      hybridSamples(),
      DEFAULT_THRESHOLDS,
      24,
    );
    const lines = firewallRulesForCluster(mm, CLUSTER).map(formatRule);
    const out = lines.filter((l) => l.includes(":1521/"));
    expect(out.some((l) => l.includes("(10.1.8.100) ->"))).toBe(true);
    expect(out.some((l) => l.startsWith("worker (10.1.8.11)"))).toBe(false);
  });

  it("the wave a VM moves in includes its rules to and from the cluster", () => {
    const lines = firewallRulesForWave(m, 2).map(formatRule);
    expect(lines).toContain(
      "app03 (10.1.1.13) -> worker2 (10.1.8.12):30080/tcp",
    );
  });
});

describe("hybrid estate: layout", () => {
  it("a Kubernetes lane per cluster between the waves and what stays", () => {
    const m = hybridModel();
    const labels = {
      waveLabels: {},
      stayLabel: "Stays",
      externalLabel: "Outside",
    };
    expect(laneSpecs(m.nodes, labels).map((l) => l.label)).toEqual([
      "Wave 2",
      `Kubernetes · ${CLUSTER}`,
      "Stays",
    ]);
    const l = layoutGraph(m.nodes, m.edges, laneSpecs(m.nodes, labels));
    const lane = (id: string): string => l.nodes.get(id)!.lane;
    expect(lane("orders")).toBe(`k8s:${CLUSTER}`);
    expect(lane(NAT)).toBe(`k8s:${CLUSTER}`);
    expect(lane("oracle")).toBe("stay");
  });
});

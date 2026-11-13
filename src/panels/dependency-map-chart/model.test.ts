import {
  END_HOUR,
  WINDOW_HOURS,
  estateModel,
  estateSamples,
} from "../../test-utils/estate";
import { DEFAULT_THRESHOLDS } from "./dependency-map-chart-types";
import { parseMapping } from "./mapping";
import {
  buildModel,
  cidrContains,
  classifyFrequency,
  commonPin,
  isPinned,
} from "./model";

describe("classifyFrequency", () => {
  it.each([
    [1, "constantly"],
    [0.9, "constantly"],
    [0.5, "hourly"],
    [1 / 24, "daily"],
    [1 / 168, "weekly"],
    [1 / 720, "monthly"],
    [0, "monthly"],
  ])("share %p is %s", (share, expected) => {
    expect(classifyFrequency(share, DEFAULT_THRESHOLDS)).toBe(expected);
  });
});

describe("cidrContains", () => {
  it("matches IPv4 ranges and exact IPv6", () => {
    expect(cidrContains("10.1.0.0/16", "10.1.200.3")).toBe(true);
    expect(cidrContains("10.1.0.0/16", "10.2.0.1")).toBe(false);
    expect(cidrContains("0.0.0.0/0", "192.0.2.1")).toBe(true);
    expect(cidrContains("198.51.100.43/32", "198.51.100.43")).toBe(true);
    expect(cidrContains("2001:db8::1/128", "2001:db8::1")).toBe(true);
  });
});

describe("buildModel on the example estate", () => {
  const m = estateModel();
  const edge = (id: string) => m.edges.find((e) => e.id === id)!;

  it("maps IPs to services, VIPs to the service, externals and unknowns to their own nodes", () => {
    expect(m.nodes.map((n) => n.id)).toEqual(
      expect.arrayContaining([
        "lb",
        "oracle",
        "ext:bank-api.example.com",
        "ext:ftp.partner.example.com",
        "ip:10.1.7.22",
      ]),
    );
    expect(m.byId.get("ip:10.1.7.22")).toMatchObject({
      kind: "unknown",
      wave: -1,
    });
    expect(edge("billing->oracle:1521").pairs).toEqual({ app03: ["vip"] });
  });

  it("classifies every edge by how often it was seen", () => {
    expect(edge("lb->api:443").frequency).toBe("constantly");
    expect(edge("billing->ext:bank-api.example.com:443").frequency).toBe(
      "hourly",
    );
    expect(edge("erp->ldap:636").frequency).toBe("hourly");
    expect(edge("reports->oracle:1521").frequency).toBe("daily");
    expect(edge("reports->ext:ftp.partner.example.com:21").frequency).toBe(
      "monthly",
    );
    expect(edge("oracle->ip:10.1.7.22:1521").frequency).toBe("daily");
  });

  it("unions the hours of the instances that make up an edge (erp-sync rotates over the ldap members)", () => {
    expect(edge("erp->ldap:636").hoursSeen).toBe(WINDOW_HOURS / 2);
    expect(edge("erp->ldap:636").pairs).toEqual({
      win05: ["ldap01", "ldap02", "ldap03"],
    });
    expect(isPinned(edge("erp->ldap:636"))).toBe(false);
  });

  it("finds hard-wired callers: one member of an HA service, never the VIP", () => {
    expect(edge("erp->oracle:1521").pins).toEqual({ win05: "db01" });
    expect(edge("portal->ldap:636").pins).toEqual({
      app01: "ldap01",
      app04: "ldap01",
    });
    expect(commonPin(edge("portal->ldap:636"))).toBe("ldap01");
    expect(isPinned(edge("billing->oracle:1521"))).toBe(false);
    // A single-instance service cannot be pinned.
    expect(edge("portal->nfs:2049").pins).toEqual({});
  });

  it("records the last sighting and the caller process", () => {
    expect(edge("lb->api:443").lastSeen).toBe(END_HOUR * 3600);
    expect(edge("lb->api:443").processes).toEqual(["haproxy"]);
  });
});

describe("buildModel details", () => {
  const { mapping } = parseMapping(`
services:
  - id: a
    instances: [{ host: a1, ip: 10.0.0.1 }, { host: a2, ip: 10.0.0.2 }]
    ha: active-active
  - id: b
    instances: [{ host: b1, ip: 10.0.1.1 }]
external:
  - { match: 192.0.2.0/24, name: partner }
  - { match: "*.example.com", name: saas }
`);

  it("drops traffic inside a service, keeps bytes per second, matches CIDRs and names", () => {
    const m = buildModel(
      mapping,
      [
        {
          src: "10.0.0.1",
          dst: "10.0.0.2",
          port: 7000,
          hours: [1],
          lastSeen: 3600,
        },
        {
          src: "10.0.0.1",
          dst: "10.0.1.1",
          port: 80,
          hours: [1, 2],
          bytes: 4800,
          lastSeen: 7200,
        },
        {
          src: "10.0.0.2",
          dst: "10.0.1.1",
          port: 80,
          hours: [2, 3],
          bytes: 0,
          lastSeen: 10800,
        },
        {
          src: "10.0.1.1",
          dst: "192.0.2.9",
          port: 443,
          hours: [1],
          lastSeen: 3600,
        },
        {
          src: "10.0.1.1",
          dst: "203.0.113.5",
          dstName: "api.example.com",
          port: 443,
          hours: [1],
          lastSeen: 3600,
        },
        {
          src: "10.0.1.1",
          dst: "203.0.113.77",
          port: 443,
          hours: [1],
          lastSeen: 3600,
        },
      ],
      DEFAULT_THRESHOLDS,
      48,
    );
    expect(m.edges.map((e) => e.id)).toEqual([
      "a->b:80",
      "b->ext:partner:443",
      "b->ext:saas:443",
      "b->ip:203.0.113.77:443",
    ]);
    expect(m.edges[0]).toMatchObject({
      hoursSeen: 3,
      lastSeen: 10800,
    });
    expect(m.edges[0]!.bytesPerSecond).toBeCloseTo(2400 / 86400);
    expect(m.edges[1]!.bytesPerSecond).toBeUndefined();
  });

  it("adds volume from a separate query", () => {
    const m = buildModel(
      mapping,
      [
        {
          src: "10.0.0.1",
          dst: "10.0.1.1",
          port: 80,
          hours: [1],
          lastSeen: 3600,
        },
      ],
      DEFAULT_THRESHOLDS,
      24,
      {
        volume: [
          {
            src: "10.0.0.1",
            dst: "10.0.1.1",
            port: 80,
            hours: [1],
            bytes: 1000,
            lastSeen: 3600,
          },
        ],
      },
    );
    expect(m.edges[0]!.bytesPerSecond).toBeCloseTo(1000 / 86400);
  });

  it("takes load from a load query over the mapping", () => {
    const m = buildModel(
      {
        services: [
          {
            id: "a",
            ha: "active-active",
            load: 10,
            instances: [
              { host: "a1", ip: "10.0.0.1" },
              { host: "a2", ip: "10.0.0.2" },
            ],
          },
        ],
        external: [],
      },
      [],
      DEFAULT_THRESHOLDS,
      24,
      { loads: { a: 55 } },
    );
    expect(m.byId.get("a")!.load).toBe(55);
  });

  it("orders an active-passive service primary first", () => {
    const m = buildModel(
      {
        services: [
          {
            id: "db",
            ha: "active-passive",
            instances: [
              { host: "s", ip: "10.0.0.1", role: "standby" },
              { host: "p", ip: "10.0.0.2", role: "primary" },
            ],
          },
        ],
        external: [],
      },
      [],
      DEFAULT_THRESHOLDS,
      24,
    );
    expect(m.byId.get("db")!.instances.map((i) => i.host)).toEqual(["p", "s"]);
  });

  it("handles an empty estate and a window of zero", () => {
    const m = buildModel(
      { services: [], external: [] },
      estateSamples(24),
      DEFAULT_THRESHOLDS,
      0,
    );
    expect(m.windowHours).toBe(1);
    expect(
      m.nodes.every((n) => n.kind === "unknown" || n.kind === "external"),
    ).toBe(true);
  });
});

import {
  CLUSTER,
  HYBRID_YAML,
  hybridMapping,
  hybridModel,
  hybridSamples,
} from "../../test-utils/hybrid";
import { DEFAULT_THRESHOLDS } from "./dependency-map-chart-types";
import {
  firewallRulesForCluster,
  firewallRulesForWave,
  formatRule,
  wavesOf,
} from "./firewall";
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

import {
  CLUSTER,
  ORDERS_A,
  hybridMapping,
  hybridSamples,
  node,
  pod,
  sample,
  service,
} from "../../test-utils/hybrid";
import {
  UNNAMED_CLUSTER,
  buildInventory,
  globMatch,
  resolveEndpoint,
  serviceIdOf,
} from "./resolve";

describe("buildInventory", () => {
  const mapping = hybridMapping();
  const inv = buildInventory(mapping, hybridSamples());

  it("learns pods, Services and nodes from OBI's decoration, and nodes from the mapping", () => {
    expect(inv.defaultCluster).toBe(CLUSTER);
    expect(inv.pods.get("10.244.1.4")).toEqual({
      cluster: CLUSTER,
      namespace: "shop",
      workload: "orders",
      pod: "orders-7d9f-a",
      node: "worker",
    });
    expect(inv.services.get("10.96.96.223")).toEqual({
      cluster: CLUSTER,
      namespace: "shop",
      name: "pricing",
    });
    expect(inv.nodes.get("10.1.8.12")).toEqual({
      cluster: CLUSTER,
      node: "worker2",
    });
    expect(inv.nodes.get("10.89.0.14")).toEqual({
      cluster: CLUSTER,
      node: "worker2",
    });
    // The mapping's `ip` is the address rules use, not the internal one OBI also saw.
    expect(inv.nodeIp.get("worker2")).toBe("10.1.8.12");
    expect(inv.workloads.has(`${CLUSTER}/shop/pricing`)).toBe(true);
  });

  it("names the cluster after OBI when the mapping has none, else a fixed name", () => {
    const bare = { services: [], external: [] };
    expect(buildInventory(bare, hybridSamples()).defaultCluster).toBe(CLUSTER);
    expect(buildInventory(bare, []).defaultCluster).toBe(UNNAMED_CLUSTER);
  });
});

describe("resolveEndpoint", () => {
  const mapping = hybridMapping();
  const inv = buildInventory(mapping, hybridSamples());

  it("a pod by its decoration, grouped into its workload", () => {
    expect(resolveEndpoint(mapping, inv, "10.244.1.4", ORDERS_A)).toEqual({
      kind: "pod",
      cluster: CLUSTER,
      namespace: "shop",
      workload: "orders",
      pod: "orders-7d9f-a",
      node: "worker",
    });
  });

  it("a pod address seen without decoration (a collector outside the cluster) through the inventory", () => {
    expect(
      resolveEndpoint(mapping, inv, "10.244.3.5", undefined),
    ).toMatchObject({
      kind: "pod",
      workload: "pricing",
      pod: "pricing-5c6b-b",
    });
  });

  it("a Service address", () => {
    expect(
      resolveEndpoint(mapping, inv, "10.96.96.223", service("pricing")),
    ).toEqual({
      kind: "service",
      cluster: CLUSTER,
      namespace: "shop",
      name: "pricing",
    });
  });

  it("a node address, and a node address on a mapped NodePort", () => {
    expect(resolveEndpoint(mapping, inv, "10.1.8.11", undefined)).toEqual({
      kind: "node",
      cluster: CLUSTER,
      node: "worker",
    });
    expect(
      resolveEndpoint(mapping, inv, "10.1.8.12", node("worker2"), 30080),
    ).toMatchObject({ kind: "nodeport", node: "worker2" });
    expect(
      resolveEndpoint(mapping, inv, "10.1.8.12", undefined, 22),
    ).toMatchObject({ kind: "node", node: "worker2" });
  });

  it("hides kube-system and leaves everything else to the model", () => {
    expect(
      resolveEndpoint(mapping, inv, "10.244.0.3", {
        type: "Pod",
        namespace: "kube-system",
        name: "coredns-1",
        owner: "coredns",
      }),
    ).toEqual({ kind: "hidden" });
    expect(resolveEndpoint(mapping, inv, "10.1.1.13", undefined)).toEqual({
      kind: "other",
    });
  });
});

describe("serviceIdOf", () => {
  const mapping = hybridMapping();
  const inv = buildInventory(mapping, hybridSamples());
  const id = (
    ip: string,
    ref = undefined as Parameters<typeof resolveEndpoint>[3],
    port?: number,
  ) => serviceIdOf(mapping, inv, resolveEndpoint(mapping, inv, ip, ref, port));

  it("mapped workloads by id, others grouped by cluster, namespace and workload", () => {
    expect(id("10.244.1.4", ORDERS_A)).toBe("orders");
    expect(id("10.244.3.5")).toBe(`k8s:${CLUSTER}/shop/pricing`);
  });

  it("a Service belongs to the workload of the same name; a NodePort to its workload", () => {
    expect(id("10.96.96.223", service("pricing"))).toBe(
      `k8s:${CLUSTER}/shop/pricing`,
    );
    expect(id("10.96.0.50", service("legacy-gw"))).toBe(
      `k8s:${CLUSTER}/shop/svc:legacy-gw`,
    );
    expect(id("10.1.8.12", undefined, 30080)).toBe("orders");
    expect(id("10.1.8.12", undefined, 22)).toBe(`k8s:${CLUSTER}`);
  });

  it("workload globs", () => {
    expect(globMatch("orders-*", "orders-v2")).toBe(true);
    expect(globMatch("orders-*", "orders")).toBe(false);
    expect(globMatch("a.b", "axb")).toBe(false);
  });
});

describe("pod range gateways", () => {
  const mapping = hybridMapping();

  it("the .1 of a node's pod /24 is that node (bridge CNI SNAT for hairpin and probes)", () => {
    const inv = buildInventory(mapping, hybridSamples());
    expect(inv.podGateways.get("10.244.1.1")).toEqual({
      cluster: CLUSTER,
      node: "worker",
    });
    expect(resolveEndpoint(mapping, inv, "10.244.3.1", undefined)).toEqual({
      kind: "node",
      cluster: CLUSTER,
      node: "worker2",
    });
    // Not a gateway address, and a decorated side is never overridden.
    expect(resolveEndpoint(mapping, inv, "10.244.3.9", undefined).kind).toBe(
      "other",
    );
  });

  it("ignores /24s shared by pods of two nodes, and host-network pods on node addresses", () => {
    const inv = buildInventory(mapping, [
      sample("10.244.7.4", "10.1.2.10", 1521, {
        src: pod("a-1", "a", "worker", "10.89.0.16"),
      }),
      sample("10.244.7.5", "10.1.2.10", 1521, {
        src: pod("b-1", "b", "worker2", "10.89.0.14"),
      }),
      sample("10.89.0.14", "10.1.2.10", 1521, {
        src: pod("kube-proxy-x", "kube-proxy", "worker2", "10.89.0.14"),
      }),
    ]);
    expect(inv.podGateways.has("10.244.7.1")).toBe(false);
    expect(inv.podGateways.has("10.89.0.1")).toBe(false);
  });
});

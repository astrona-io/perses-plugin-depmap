import { DEFAULT_THRESHOLDS } from "../panels/dependency-map-chart/dependency-map-chart-types";
import { Mapping, parseMapping } from "../panels/dependency-map-chart/mapping";
import {
  DepModel,
  EdgeSample,
  K8sRef,
  buildModel,
} from "../panels/dependency-map-chart/model";

/**
 * A small hybrid estate for the unit tests: two VMs and a three-node cluster. The label sets are the
 * ones OBI v1.0.0 reported in dev/ (kind cluster, OBI in each node's network namespace): a pod side
 * carries type Pod, its top owner and its node; a Service side type Service and owner Service; a node
 * side type Node with the node name as its name and no namespace.
 *
 *   billing (VM 10.1.1.13) -> node worker2 10.1.8.12:30080 (NodePort of orders)
 *   orders pods -> pricing Service 10.96.96.223:80, and after DNAT -> pricing pod :8080
 *   orders pod on worker -> oracle VIP 10.1.2.10:1521, and the same flow SNATed: worker -> oracle
 *   worker2 -> oracle in hours no pod-side flow explains (OBI was off there): NAT, pod unknown
 */

export const CLUSTER = "example-cluster";
export const HOURS = Array.from({ length: 24 }, (_, i) => 490000 + i);
export const LAST = (HOURS[HOURS.length - 1]! + 1) * 3600 - 60;

export const HYBRID_YAML = `
services:
  - id: billing
    wave: 2
    instances:
      - { host: app03, ip: 10.1.1.13 }
  - id: oracle
    ha: active-passive
    vip: 10.1.2.10
    instances:
      - { host: db01, ip: 10.1.2.11, role: primary }
      - { host: db02, ip: 10.1.2.12, role: standby }
external: []
kubernetes:
  clusters:
    - name: ${CLUSTER}
      nodes:
        - { name: control-plane, ip: 10.1.8.10, addresses: [10.89.0.15] }
        - { name: worker, ip: 10.1.8.11, addresses: [10.89.0.16] }
        - { name: worker2, ip: 10.1.8.12, addresses: [10.89.0.14] }
  services:
    - id: orders
      namespace: shop
      replicas: 2
      nodePorts: [30080]
`;

export function hybridMapping(text = HYBRID_YAML): Mapping {
  const r = parseMapping(text);
  if (r.errors.length) throw new Error(r.errors.join("\n"));
  return r.mapping;
}

export const pod = (
  name: string,
  owner: string,
  node: string,
  nodeIp: string,
  namespace = "shop",
): K8sRef => ({
  type: "Pod",
  cluster: CLUSTER,
  namespace,
  name,
  owner,
  ownerType: "Deployment",
  node,
  nodeIp,
});
export const service = (name: string, namespace = "shop"): K8sRef => ({
  type: "Service",
  cluster: CLUSTER,
  namespace,
  name,
  owner: name,
  ownerType: "Service",
});
export const node = (name: string): K8sRef => ({
  type: "Node",
  cluster: CLUSTER,
  name,
  owner: name,
  ownerType: "Node",
});

export const ORDERS_A = pod("orders-7d9f-a", "orders", "worker", "10.89.0.16");
export const ORDERS_B = pod("orders-7d9f-b", "orders", "worker2", "10.89.0.14");
export const PRICING_A = pod(
  "pricing-5c6b-a",
  "pricing",
  "worker",
  "10.89.0.16",
);
export const PRICING_B = pod(
  "pricing-5c6b-b",
  "pricing",
  "worker2",
  "10.89.0.14",
);

export function sample(
  src: string,
  dst: string,
  port: number,
  refs: { src?: K8sRef; dst?: K8sRef } = {},
  hours: number[] = HOURS,
  bytes = 1000 * hours.length,
): EdgeSample {
  const s: EdgeSample = {
    src,
    dst,
    port,
    hours,
    bytes,
    lastSeen: (hours[hours.length - 1]! + 1) * 3600 - 60,
  };
  if (refs.src) s.srcK8s = refs.src;
  if (refs.dst) s.dstK8s = refs.dst;
  return s;
}

export function hybridSamples(): EdgeSample[] {
  return [
    // VM -> NodePort, seen by OBI on the node (decorated) and on the VM (not decorated).
    sample("10.1.1.13", "10.1.8.12", 30080, { dst: node("worker2") }),
    sample("10.1.1.13", "10.1.8.12", 30080),
    // kube-proxy forwards it: node -> pod, SNATed to the node address (externalTrafficPolicy Cluster).
    sample("10.89.0.14", "10.244.3.4", 8080, {
      src: node("worker2"),
      dst: ORDERS_B,
    }),
    // Pod -> ClusterIP, and the same connection after DNAT.
    sample("10.244.1.4", "10.96.96.223", 80, {
      src: ORDERS_A,
      dst: service("pricing"),
    }),
    sample("10.244.1.4", "10.244.3.5", 8080, {
      src: ORDERS_A,
      dst: PRICING_B,
    }),
    sample("10.244.3.4", "10.244.1.5", 8080, {
      src: ORDERS_B,
      dst: PRICING_A,
    }),
    // Pod -> VM, before SNAT and after it (same node, same destination, same hours).
    sample("10.244.1.4", "10.1.2.10", 1521, { src: ORDERS_A }),
    sample("10.1.8.11", "10.1.2.10", 1521, { src: node("worker") }),
    // SNATed traffic from worker2 that no pod-side flow explains, in the first 6 hours.
    sample("10.1.8.12", "10.1.2.10", 1521, {}, HOURS.slice(0, 6)),
    // Plumbing: kubelet probes, kube-system, pod -> its node.
    sample("10.89.0.16", "10.244.1.5", 8080, {
      src: node("worker"),
      dst: PRICING_A,
    }),
    sample("10.244.0.3", "10.89.0.15", 6443, {
      src: pod(
        "coredns-1",
        "coredns",
        "control-plane",
        "10.89.0.15",
        "kube-system",
      ),
      dst: node("control-plane"),
    }),
    sample("10.244.3.4", "10.89.0.14", 10250, {
      src: ORDERS_B,
      dst: node("worker2"),
    }),
  ];
}

export function hybridModel(samples = hybridSamples()): DepModel {
  return buildModel(hybridMapping(), samples, DEFAULT_THRESHOLDS, HOURS.length);
}

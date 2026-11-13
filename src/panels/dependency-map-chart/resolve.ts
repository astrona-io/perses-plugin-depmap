import {
  DEFAULT_HIDDEN_NAMESPACES,
  Mapping,
  MappingCluster,
  MappingWorkload,
} from "./mapping";
import { EdgeSample, K8sRef } from "./model";

/**
 * Who an address is, on the Kubernetes side of a hybrid estate. Pure: the mapping and the samples in,
 * an inventory and a resolver out; no React, no ECharts.
 *
 * Kubernetes addresses come and go, so the mapping never lists pod addresses. What a pod, Service or
 * node is comes from OBI's Kubernetes decoration on the samples themselves (k8s_src_* / k8s_dst_*).
 * The inventory built from all samples covers the sides that carry no decoration: a flow seen by a
 * collector outside the cluster (OBI on a VM, the fallback script) still names a pod IP that OBI on
 * the node decorated in another sample. Node addresses come from the mapping and from the samples.
 */

export type Resolved =
  /** A pod, grouped into its workload. */
  | {
      kind: "pod";
      cluster: string;
      namespace: string;
      workload: string;
      pod: string;
      node?: string;
    }
  /** A Kubernetes Service address (ClusterIP), before kube-proxy picks a pod. */
  | { kind: "service"; cluster: string; namespace: string; name: string }
  /** A node's own address: SNATed pod traffic, kubelet, the node itself. */
  | { kind: "node"; cluster: string; node: string }
  /** A node address on a NodePort the mapping assigns to a workload. */
  | {
      kind: "nodeport";
      cluster: string;
      node: string;
      workload: MappingWorkload;
    }
  /**
   * Pod traffic that left a node SNATed to the node's address and could not be matched to the pod
   * that sent it (set by the stitching, never by the resolver).
   */
  | { kind: "nat"; cluster: string; node: string }
  /** In a namespace left off the map (kube-system by default). */
  | { kind: "hidden" }
  /** Anything else: mapped VMs, VIPs, externals and unknowns, which the model resolves as before. */
  | { kind: "other" };

export interface PodInfo {
  cluster: string;
  namespace: string;
  workload: string;
  pod: string;
  node?: string;
}

export interface Inventory {
  clusters: Map<string, MappingCluster>;
  /** Node address -> cluster and node name. */
  nodes: Map<string, { cluster: string; node: string }>;
  /** Node names per cluster, mapping and samples together. */
  nodeNames: Map<string, Set<string>>;
  /** Node name -> the address firewall rules use (mapping ip, else the one seen). */
  nodeIp: Map<string, string>;
  pods: Map<string, PodInfo>;
  services: Map<string, { cluster: string; namespace: string; name: string }>;
  /** Workloads seen in pods, as `cluster/namespace/workload`. */
  workloads: Set<string>;
  defaultCluster: string;
}

/** Cluster name when neither the mapping nor OBI names one (OTEL_EBPF_KUBE_CLUSTER_NAME unset). */
export const UNNAMED_CLUSTER = "kubernetes";

function clusterOf(
  ref: K8sRef | undefined,
  inv: Pick<Inventory, "defaultCluster">,
): string {
  return ref?.cluster || inv.defaultCluster;
}

/** Workload name of a pod: its top owner, or the pod itself when it has none. */
export function workloadOf(ref: K8sRef): string {
  return ref.owner || ref.name || "";
}

function addNode(
  inv: Inventory,
  cluster: string,
  node: string,
  ip?: string,
): void {
  const names = inv.nodeNames.get(cluster) ?? new Set<string>();
  names.add(node);
  inv.nodeNames.set(cluster, names);
  if (ip) {
    if (!inv.nodes.has(ip)) inv.nodes.set(ip, { cluster, node });
    if (!inv.nodeIp.has(node)) inv.nodeIp.set(node, ip);
  }
}

export function buildInventory(
  mapping: Mapping,
  samples: EdgeSample[],
): Inventory {
  const k = mapping.kubernetes;
  const inv: Inventory = {
    clusters: new Map((k?.clusters ?? []).map((c) => [c.name, c])),
    nodes: new Map(),
    nodeNames: new Map(),
    nodeIp: new Map(),
    pods: new Map(),
    services: new Map(),
    workloads: new Set(),
    defaultCluster: k?.clusters.length === 1 ? k.clusters[0]!.name : "",
  };
  if (!inv.defaultCluster) {
    const named = new Set(
      samples.flatMap((s) =>
        [s.srcK8s?.cluster, s.dstK8s?.cluster].filter((c): c is string => !!c),
      ),
    );
    inv.defaultCluster = named.size === 1 ? [...named][0]! : UNNAMED_CLUSTER;
  }
  for (const c of k?.clusters ?? [])
    for (const n of c.nodes) {
      addNode(inv, c.name, n.name, n.ip);
      for (const a of n.addresses ?? []) addNode(inv, c.name, n.name, a);
    }
  const learn = (ip: string, ref: K8sRef | undefined): void => {
    if (!ref) return;
    const cluster = clusterOf(ref, inv);
    if (ref.type === "Pod" && ref.namespace && workloadOf(ref)) {
      inv.workloads.add(`${cluster}/${ref.namespace}/${workloadOf(ref)}`);
      if (!inv.pods.has(ip))
        inv.pods.set(ip, {
          cluster,
          namespace: ref.namespace,
          workload: workloadOf(ref),
          pod: ref.name || ip,
          node: ref.node,
        });
      if (ref.node) addNode(inv, cluster, ref.node, ref.nodeIp);
    } else if (ref.type === "Service" && ref.namespace && ref.name) {
      if (!inv.services.has(ip))
        inv.services.set(ip, {
          cluster,
          namespace: ref.namespace,
          name: ref.name,
        });
    } else if (ref.type === "Node" && ref.name) {
      addNode(inv, cluster, ref.name, ip);
    }
  };
  for (const s of samples) {
    learn(s.src, s.srcK8s);
    learn(s.dst, s.dstK8s);
  }
  return inv;
}

function hidden(inv: Inventory, cluster: string, namespace: string): boolean {
  const list =
    inv.clusters.get(cluster)?.hideNamespaces ?? DEFAULT_HIDDEN_NAMESPACES;
  return list.includes(namespace);
}

/** `*` matches any run of characters; everything else literally. */
export function globMatch(pattern: string, value: string): boolean {
  const re = new RegExp(
    `^${pattern
      .split("*")
      .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
  );
  return re.test(value);
}

/** The mapped workload service a pod's workload belongs to, if any. */
export function mappedWorkload(
  mapping: Mapping,
  inv: Pick<Inventory, "defaultCluster">,
  cluster: string,
  namespace: string,
  workload: string,
): MappingWorkload | undefined {
  return mapping.kubernetes?.services.find(
    (w) =>
      (w.cluster ?? inv.defaultCluster) === cluster &&
      w.namespace === namespace &&
      globMatch(w.workload ?? w.id, workload),
  );
}

/** Kubernetes Service names a mapped workload sits behind. */
export function serviceNamesOf(w: MappingWorkload): string[] {
  if (w.services) return w.services;
  const name = w.workload ?? w.id;
  return name.includes("*") ? [] : [name];
}

/** One side of a sample. `port` is the server port, used for NodePorts on the callee side. */
export function resolveEndpoint(
  mapping: Mapping,
  inv: Inventory,
  ip: string,
  ref: K8sRef | undefined,
  port?: number,
): Resolved {
  let pod: PodInfo | undefined;
  if (ref?.type === "Pod" && ref.namespace && workloadOf(ref))
    pod = {
      cluster: clusterOf(ref, inv),
      namespace: ref.namespace,
      workload: workloadOf(ref),
      pod: ref.name || ip,
      node: ref.node,
    };
  else if (!ref || ref.type === "Pod") pod = inv.pods.get(ip);
  if (pod) {
    if (hidden(inv, pod.cluster, pod.namespace)) return { kind: "hidden" };
    return { kind: "pod", ...pod };
  }
  let svc = inv.services.get(ip);
  if (ref?.type === "Service" && ref.namespace && ref.name)
    svc = {
      cluster: clusterOf(ref, inv),
      namespace: ref.namespace,
      name: ref.name,
    };
  if (svc) {
    if (hidden(inv, svc.cluster, svc.namespace)) return { kind: "hidden" };
    return { kind: "service", ...svc };
  }
  let node = inv.nodes.get(ip);
  if (!node && ref?.type === "Node" && ref.name)
    node = { cluster: clusterOf(ref, inv), node: ref.name };
  if (node) {
    if (port !== undefined) {
      const w = mapping.kubernetes?.services.find(
        (x) =>
          (x.cluster ?? inv.defaultCluster) === node!.cluster &&
          x.nodePorts?.includes(port),
      );
      if (w) return { kind: "nodeport", ...node, workload: w };
    }
    return { kind: "node", ...node };
  }
  if (ref && ref.namespace && hidden(inv, clusterOf(ref, inv), ref.namespace))
    return { kind: "hidden" };
  return { kind: "other" };
}

/** The cluster a resolved endpoint belongs to, if it is a Kubernetes one. */
export function clusterOfResolved(r: Resolved): string | undefined {
  return r.kind === "pod" ||
    r.kind === "service" ||
    r.kind === "node" ||
    r.kind === "nodeport" ||
    r.kind === "nat"
    ? r.cluster
    : undefined;
}

/** Id of the map node of the per-cluster node group (the nodes themselves are its instances). */
export const nodesId = (cluster: string): string => `k8s:${cluster}`;
/** Id of the map node standing for SNATed traffic of one node whose pod is unknown. */
export const natId = (cluster: string, node: string): string =>
  `nat:${cluster}:${node}`;
/** Id of an unmapped workload, grouped automatically. */
export const autoWorkloadId = (
  cluster: string,
  namespace: string,
  workload: string,
): string => `k8s:${cluster}/${namespace}/${workload}`;

/**
 * The map node a Kubernetes endpoint belongs to: the mapped service of its workload, else a workload
 * grouped automatically by cluster, namespace and owner. A Service address belongs to the workload
 * behind it (mapped `services`, or an unmapped workload of the same name), else to a node of its own.
 */
export function serviceIdOf(
  mapping: Mapping,
  inv: Inventory,
  r: Resolved,
): string | undefined {
  switch (r.kind) {
    case "pod":
      return (
        mappedWorkload(mapping, inv, r.cluster, r.namespace, r.workload)?.id ??
        autoWorkloadId(r.cluster, r.namespace, r.workload)
      );
    case "service": {
      const w = mapping.kubernetes?.services.find(
        (x) =>
          (x.cluster ?? inv.defaultCluster) === r.cluster &&
          x.namespace === r.namespace &&
          serviceNamesOf(x).includes(r.name),
      );
      if (w) return w.id;
      if (inv.workloads.has(`${r.cluster}/${r.namespace}/${r.name}`)) {
        const m = mappedWorkload(mapping, inv, r.cluster, r.namespace, r.name);
        return m?.id ?? autoWorkloadId(r.cluster, r.namespace, r.name);
      }
      return autoWorkloadId(r.cluster, r.namespace, `svc:${r.name}`);
    }
    case "nodeport":
      return r.workload.id;
    case "node":
      return nodesId(r.cluster);
    case "nat":
      return natId(r.cluster, r.node);
    default:
      return undefined;
  }
}

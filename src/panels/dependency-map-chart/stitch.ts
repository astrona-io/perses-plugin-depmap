import { Mapping } from "./mapping";
import { EdgeSample } from "./model";
import {
  Inventory,
  Resolved,
  clusterOfResolved,
  resolveEndpoint,
  serviceIdOf,
} from "./resolve";

/**
 * Stitching: one connection across the cluster boundary is seen more than once, under different
 * addresses, and has to become one path on the map.
 *
 * - Egress SNAT. A pod calling a VM leaves its node with the node's address. OBI on the node sees the
 *   flow twice: pod -> VM before SNAT and node -> VM after it; the VM side (OBI on the VM, the fallback
 *   script) sees only node -> VM. A node-sourced sample is matched to pod-sourced samples from the same
 *   node to the same address and port in the same hours. Matched hours are dropped (the pod-side
 *   sample already draws the edge). Hours no pod-side sample explains stay, as a call from
 *   "via node X (NAT, pod unknown)": the cluster has no OBI, or not on that node, or it was off then.
 * - ClusterIP. kube-proxy rewrites the Service address to a pod's, so a pod-to-Service call shows as
 *   pod -> Service:port and pod -> pod:targetPort. The Service sample is dropped when the same caller
 *   reached a pod of the same workload in the same hours; otherwise it stays, as an edge to the
 *   workload on the Service port.
 * - Inbound NodePort. A VM calling node:nodePort is kept (it names the client) and becomes a call to
 *   the workload behind it, through that node. The node -> pod leg behind it (kube-proxy's SNAT with
 *   externalTrafficPolicy Cluster) cannot be told from kubelet health probes, and names no client, so
 *   node -> pod samples inside one cluster are dropped.
 * - Node plumbing (node <-> node, pod -> its node, kube-system) is dropped.
 *
 * Granularity is the query step (one hour): two flows in the same hour to the same address and port
 * from the same node are taken to be the same connection. Pure; unit-tested.
 */

export interface ResolvedSample {
  sample: EdgeSample;
  src: Resolved;
  dst: Resolved;
}

export interface StitchStats {
  /** Node-sourced samples (or hours of them) explained by a pod on that node. */
  snatMatched: number;
  /** Node-sourced samples left as "via node X (NAT, pod unknown)". */
  snatUnknown: number;
  /** Pod -> Service samples folded into the pod -> pod flow behind them. */
  serviceFolded: number;
  /** Node -> pod samples inside a cluster (kube-proxy SNAT, kubelet probes). */
  nodeToPod: number;
  /** Node <-> node and pod -> node plumbing, and hidden namespaces. */
  plumbing: number;
}

export interface StitchResult {
  samples: ResolvedSample[];
  stats: StitchStats;
}

function overlap(a: Set<number>, hours: number[]): boolean {
  return hours.some((h) => a.has(h));
}

export function resolveSamples(
  mapping: Mapping,
  inv: Inventory,
  samples: EdgeSample[],
): ResolvedSample[] {
  return samples.map((s) => ({
    sample: s,
    src: resolveEndpoint(mapping, inv, s.src, s.srcK8s),
    dst: resolveEndpoint(mapping, inv, s.dst, s.dstK8s, s.port),
  }));
}

export function stitch(
  mapping: Mapping,
  inv: Inventory,
  samples: EdgeSample[],
): StitchResult {
  const stats: StitchStats = {
    snatMatched: 0,
    snatUnknown: 0,
    serviceFolded: 0,
    nodeToPod: 0,
    plumbing: 0,
  };
  const all = resolveSamples(mapping, inv, samples);

  // 1. Plumbing.
  const kept: ResolvedSample[] = [];
  for (const r of all) {
    if (r.src.kind === "hidden" || r.dst.kind === "hidden") {
      stats.plumbing += 1;
      continue;
    }
    const sc = clusterOfResolved(r.src);
    const dc = clusterOfResolved(r.dst);
    const sameCluster = sc !== undefined && sc === dc;
    if (sameCluster && r.src.kind === "node") {
      if (r.dst.kind === "node" || r.dst.kind === "nodeport")
        stats.plumbing += 1;
      else stats.nodeToPod += 1;
      continue;
    }
    if (sameCluster && r.src.kind === "pod" && r.dst.kind === "node") {
      stats.plumbing += 1;
      continue;
    }
    kept.push(r);
  }

  // 2. ClusterIP: pod -> Service folded into pod -> pod of the same workload.
  const callerKey = (r: ResolvedSample): string =>
    r.src.kind === "pod" ? `pod:${r.src.pod}` : `ip:${r.sample.src}`;
  const podCalls = new Map<string, Set<number>>();
  for (const r of kept) {
    if (r.dst.kind !== "pod") continue;
    const key = `${callerKey(r)}>${serviceIdOf(mapping, inv, r.dst)}`;
    const set = podCalls.get(key) ?? new Set<number>();
    for (const h of r.sample.hours) set.add(h);
    podCalls.set(key, set);
  }
  const afterServices: ResolvedSample[] = [];
  for (const r of kept) {
    if (r.dst.kind === "service") {
      const hours = podCalls.get(
        `${callerKey(r)}>${serviceIdOf(mapping, inv, r.dst)}`,
      );
      if (hours && overlap(hours, r.sample.hours)) {
        stats.serviceFolded += 1;
        continue;
      }
    }
    afterServices.push(r);
  }

  // 3. Egress SNAT: node -> outside matched to pod -> outside from the same node.
  const podEgress = new Map<string, Set<number>>();
  const egressKey = (cluster: string, node: string, s: EdgeSample): string =>
    `${cluster}|${node}|${s.dst}|${s.port}`;
  for (const r of afterServices) {
    if (r.src.kind !== "pod") continue;
    if (clusterOfResolved(r.dst) === r.src.cluster) continue;
    // A pod whose node OBI did not report (k8s_src_node_name not selected) may be on any node: "?".
    const key = egressKey(r.src.cluster, r.src.node ?? "?", r.sample);
    const set = podEgress.get(key) ?? new Set<number>();
    for (const h of r.sample.hours) set.add(h);
    podEgress.set(key, set);
  }
  const out: ResolvedSample[] = [];
  for (const r of afterServices) {
    if (r.src.kind !== "node" || clusterOfResolved(r.dst) === r.src.cluster) {
      out.push(r);
      continue;
    }
    const covered = new Set<number>([
      ...(podEgress.get(egressKey(r.src.cluster, r.src.node, r.sample)) ?? []),
      ...(podEgress.get(egressKey(r.src.cluster, "?", r.sample)) ?? []),
    ]);
    const residual = r.sample.hours.filter((h) => !covered.has(h));
    if (residual.length < r.sample.hours.length) stats.snatMatched += 1;
    if (residual.length === 0) continue;
    stats.snatUnknown += 1;
    const share = residual.length / r.sample.hours.length;
    out.push({
      sample: {
        ...r.sample,
        hours: residual,
        bytes:
          r.sample.bytes === undefined ? undefined : r.sample.bytes * share,
      },
      src: { kind: "nat", cluster: r.src.cluster, node: r.src.node },
      dst: r.dst,
    });
  }
  return { samples: out, stats };
}

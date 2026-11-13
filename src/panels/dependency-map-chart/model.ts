import {
  FREQUENCIES,
  Frequency,
  FrequencyThresholds,
} from "./dependency-map-chart-types";
import {
  Resolved,
  buildInventory,
  natId,
  nodesId,
  serviceIdOf,
} from "./resolve";
import { ResolvedSample, StitchStats, resolveSamples, stitch } from "./stitch";
import {
  HaType,
  InstanceRole,
  Mapping,
  MappingExternal,
  isCidr,
  isIp,
} from "./mapping";

/**
 * What OBI's Kubernetes decoration says one side of a flow is. `type` is OBI's k8s.*.type: "Pod",
 * "Service", "Node", ...; `owner` the top owner (Deployment, StatefulSet, DaemonSet, ...).
 */
export interface K8sRef {
  type: string;
  cluster?: string;
  namespace?: string;
  /** Pod, Service or node name. */
  name?: string;
  owner?: string;
  ownerType?: string;
  /** The node a pod runs on. */
  node?: string;
  nodeIp?: string;
}

/** One caller → callee connection as the collectors saw it, before it is mapped to services. */
export interface EdgeSample {
  /** Caller IP. */
  src: string;
  /** Callee IP. */
  dst: string;
  /** Callee (server) port. */
  port: number;
  srcProcess?: string;
  /** Callee name, when the collector reports one (OBI's dst_name). */
  dstName?: string;
  /** Hours (unix seconds / 3600, floored) in which the connection was seen. */
  hours: number[];
  /** Bytes over the window, when the collector measures them (OBI). */
  bytes?: number;
  /** Unix seconds of the last sighting. */
  lastSeen: number;
  srcK8s?: K8sRef;
  dstK8s?: K8sRef;
  /** OBI's named range (network.cidrs) each side is in. */
  srcCidr?: string;
  dstCidr?: string;
}

export type NodeKind = "internal" | "external" | "unknown";

export interface Instance {
  host: string;
  ip: string;
  role?: InstanceRole;
  /** Kubernetes: the node a pod runs on (a node's own instance carries its own name). */
  node?: string;
}

/** Where a map node sits on the Kubernetes side of the estate. */
export interface K8sPlace {
  cluster: string;
  /**
   * workload: pods grouped by namespace and workload; service: a Service address no workload was seen
   * behind; nodes: the cluster's nodes themselves; nat: SNATed traffic of one node whose pod is unknown.
   */
  type: "workload" | "service" | "nodes" | "nat";
  namespace?: string;
  workload?: string;
  /** nat: the node the traffic left. */
  node?: string;
}

export interface ClusterInfo {
  name: string;
  nodes: Array<{ name: string; ip: string }>;
  egressIps?: string[];
}

export interface ServiceNode {
  id: string;
  name: string;
  owner?: string;
  /** 0 = stays in old DC, 1..n = wave, -1 = external or unknown (no wave). */
  wave: number;
  kind: NodeKind;
  ha: HaType;
  instances: Instance[];
  vip?: string;
  minUp: number;
  /** Load as % of the total capacity of all instances. */
  load?: number;
  process?: string;
  k8s?: K8sPlace;
  /** Kubernetes: desired replicas, when the mapping gives them; HA is judged against these. */
  replicas?: number;
}

export interface DepEdge {
  id: string;
  source: string;
  target: string;
  port: number;
  hoursSeen: number;
  /** hoursSeen / window hours, 0..1. */
  share: number;
  frequency: Frequency;
  /** Average bytes per day over the window, when bytes are known. */
  bytesPerDay?: number;
  lastSeen: number;
  /** Per caller instance, the callee instances (hosts) it connected to; "vip" for the service address. */
  pairs: Record<string, string[]>;
  /** Caller instances that only ever connected to one instance of an HA callee: caller host → callee host. */
  pins: Record<string, string>;
  processes: string[];
}

export interface DepModel {
  nodes: ServiceNode[];
  edges: DepEdge[];
  byId: Map<string, ServiceNode>;
  windowHours: number;
  /** Kubernetes clusters, with node addresses (for firewall rules across the cluster boundary). */
  clusters?: Map<string, ClusterInfo>;
  /** What the stitching folded or kept as "pod unknown" (see stitch.ts). */
  stitch?: StitchStats;
}

export const VIP = "vip";

export function classifyFrequency(
  share: number,
  t: FrequencyThresholds,
): Frequency {
  if (share >= t.constantly) return "constantly";
  if (share >= t.hourly) return "hourly";
  if (share >= t.daily) return "daily";
  if (share >= t.weekly) return "weekly";
  return "monthly";
}

function ipv4ToInt(ip: string): number | undefined {
  const parts = ip.split(".");
  if (parts.length !== 4) return undefined;
  let n = 0;
  for (const p of parts) {
    const v = Number(p);
    if (!/^\d+$/.test(p) || v > 255) return undefined;
    n = n * 256 + v;
  }
  return n;
}

/** IPv4 CIDRs are matched numerically; IPv6 only as an exact address. */
export function cidrContains(cidr: string, ip: string): boolean {
  const [base, bitsRaw] = cidr.split("/");
  const bits = Number(bitsRaw);
  const a = ipv4ToInt(base ?? "");
  const b = ipv4ToInt(ip);
  if (a === undefined || b === undefined) return base === ip;
  if (bits === 0) return true;
  const mask = bits >= 32 ? 0xffffffff : (0xffffffff << (32 - bits)) >>> 0;
  return (a & mask) >>> 0 === (b & mask) >>> 0;
}

function externalMatches(
  e: MappingExternal,
  ip: string,
  name?: string,
): boolean {
  const m = e.match;
  if (isCidr(m)) return cidrContains(m, ip);
  if (isIp(m)) return m === ip;
  if (!name) return false;
  if (m.startsWith("*.")) return name.endsWith(m.slice(1));
  return m === name;
}

interface Endpoint {
  node: ServiceNode;
  /** Instance host, VIP, or (Kubernetes) the pod or node name. */
  instance: string;
}

/** Pods not seen for this long before the newest sample are left out of the instances. */
export const POD_RECENT_SECONDS = 2 * 3600;

/**
 * Turns collector samples into the service graph: IPs become instances of mapped services, VIPs become
 * the service itself, matches of `external` become external nodes, and anything else an unknown node
 * per IP. Kubernetes endpoints are resolved and stitched first (resolve.ts, stitch.ts): pods become
 * instances of their workload, NodePorts and LoadBalancer addresses lead to the workload behind them,
 * and SNATed traffic no pod explains comes from "via node X (NAT, pod unknown)". Edges between
 * instances of the same service (replication, cluster traffic) are dropped.
 */
export function buildModel(
  mapping: Mapping,
  samples: EdgeSample[],
  thresholds: FrequencyThresholds,
  windowHours: number,
  options: {
    volume?: EdgeSample[];
    loads?: Record<string, number>;
  } = {},
): DepModel {
  const nodes: ServiceNode[] = [];
  const byId = new Map<string, ServiceNode>();
  const byIp = new Map<string, Endpoint>();
  const add = (n: ServiceNode): ServiceNode => {
    nodes.push(n);
    byId.set(n.id, n);
    return n;
  };

  for (const s of mapping.services) {
    const ha = s.ha ?? "single";
    const node = add({
      id: s.id,
      name: s.name ?? s.id,
      owner: s.owner,
      wave: s.wave ?? 0,
      kind: "internal",
      ha,
      instances: orderInstances(ha, s.instances),
      vip: s.vip,
      minUp: s.minUp ?? 1,
      load: options.loads?.[s.id] ?? s.load,
      process: s.process,
    });
    for (const i of node.instances) byIp.set(i.ip, { node, instance: i.host });
    if (s.vip) byIp.set(s.vip, { node, instance: VIP });
  }

  // Kubernetes: inventory, stitching, the mapped workloads, the clusters.
  const inv = buildInventory(mapping, [...samples, ...(options.volume ?? [])]);
  const stitched = stitch(mapping, inv, samples);
  const clusters = new Map<string, ClusterInfo>();
  const clusterNames = new Set<string>([
    ...inv.nodeNames.keys(),
    ...inv.clusters.keys(),
  ]);
  for (const c of clusterNames) {
    const mapped = inv.clusters.get(c);
    clusters.set(c, {
      name: c,
      nodes: [...(inv.nodeNames.get(c) ?? [])].sort().map((n) => ({
        name: n,
        ip: inv.nodeIp.get(n) ?? "",
      })),
      egressIps: mapped?.egressIps,
    });
  }
  for (const w of mapping.kubernetes?.services ?? []) {
    const cluster = w.cluster ?? inv.defaultCluster;
    const node = add({
      id: w.id,
      name: w.name ?? w.workload ?? w.id,
      owner: w.owner,
      wave: 0,
      kind: "internal",
      ha: w.ha ?? ((w.replicas ?? 1) > 1 ? "active-active" : "single"),
      instances: [],
      vip: w.loadBalancerIp,
      minUp: w.minUp ?? 1,
      load: options.loads?.[w.id] ?? w.load,
      process: w.process,
      k8s: {
        cluster,
        type: "workload",
        namespace: w.namespace,
        workload: w.workload ?? w.id,
      },
      replicas: w.replicas,
    });
    if (w.loadBalancerIp) byIp.set(w.loadBalancerIp, { node, instance: VIP });
  }

  // Pods seen recently are the instances of their workload.
  const newest = samples.reduce((m, s) => Math.max(m, s.lastSeen), 0);
  const podSeen = new Map<string, { ip: string; lastSeen: number }>();
  for (const r of stitched.samples)
    for (const [side, ip] of [
      [r.src, r.sample.src],
      [r.dst, r.sample.dst],
    ] as const)
      if (side.kind === "pod") {
        const cur = podSeen.get(side.pod);
        if (!cur || cur.lastSeen < r.sample.lastSeen)
          podSeen.set(side.pod, { ip, lastSeen: r.sample.lastSeen });
      }

  const ensureK8s = (
    id: string,
    name: string,
    place: K8sPlace,
    ha: HaType = "single",
  ): ServiceNode =>
    byId.get(id) ??
    add({
      id,
      name,
      wave: 0,
      kind: "internal",
      ha,
      instances: [],
      minUp: 1,
      k8s: place,
    });
  const nodeInstances = (cluster: string): Instance[] =>
    (clusters.get(cluster)?.nodes ?? []).map((n) => ({
      host: n.name,
      ip: n.ip,
      node: n.name,
    }));

  const k8sEndpoint = (r: Resolved, ip: string): Endpoint | undefined => {
    switch (r.kind) {
      case "pod": {
        const id = serviceIdOf(mapping, inv, r)!;
        const node = ensureK8s(id, r.workload, {
          cluster: r.cluster,
          type: "workload",
          namespace: r.namespace,
          workload: r.workload,
        });
        const seen = podSeen.get(r.pod);
        if (
          seen &&
          seen.lastSeen >= newest - POD_RECENT_SECONDS &&
          !node.instances.some((i) => i.host === r.pod)
        ) {
          node.instances.push({ host: r.pod, ip: seen.ip, node: r.node });
          node.instances.sort((a, b) => (a.host < b.host ? -1 : 1));
          if (
            !node.replicas &&
            node.instances.length > 1 &&
            node.ha === "single"
          )
            node.ha = "active-active";
        }
        return { node, instance: r.pod };
      }
      case "service": {
        const id = serviceIdOf(mapping, inv, r)!;
        const node = ensureK8s(id, r.name, {
          cluster: r.cluster,
          type: byId.has(id) ? "workload" : "service",
          namespace: r.namespace,
          workload: r.name,
        });
        if (!node.vip) node.vip = ip;
        return { node, instance: VIP };
      }
      case "nodeport": {
        const node = byId.get(r.workload.id)!;
        return { node, instance: r.node };
      }
      case "node": {
        const node = ensureK8s(
          nodesId(r.cluster),
          `${r.cluster} nodes`,
          { cluster: r.cluster, type: "nodes" },
          "active-active",
        );
        if (node.instances.length === 0)
          node.instances = nodeInstances(r.cluster);
        return { node, instance: r.node };
      }
      case "nat": {
        const node = ensureK8s(
          natId(r.cluster, r.node),
          `via node ${r.node} (NAT, pod unknown)`,
          { cluster: r.cluster, type: "nat", node: r.node },
        );
        if (node.instances.length === 0)
          node.instances = [
            {
              host: r.node,
              ip:
                clusters.get(r.cluster)?.nodes.find((n) => n.name === r.node)
                  ?.ip ?? "",
              node: r.node,
            },
          ];
        return { node, instance: r.node };
      }
      default:
        return undefined;
    }
  };

  const resolve = (ip: string, name?: string): Endpoint => {
    const known = byIp.get(ip);
    if (known) return known;
    const ext = mapping.external.find((e) => externalMatches(e, ip, name));
    if (ext) {
      const label = ext.name ?? ext.match;
      const id = `ext:${label}`;
      const node =
        byId.get(id) ??
        add({
          id,
          name: label,
          owner: ext.owner,
          wave: -1,
          kind: "external",
          ha: "single",
          instances: [],
          minUp: 1,
        });
      return { node, instance: ip };
    }
    const id = `ip:${ip}`;
    const node =
      byId.get(id) ??
      add({
        id,
        name: ip,
        wave: -1,
        kind: "unknown",
        ha: "single",
        instances: [{ host: ip, ip }],
        minUp: 1,
      });
    byIp.set(ip, { node, instance: ip });
    return { node, instance: ip };
  };

  interface Acc {
    source: string;
    target: string;
    port: number;
    hours: Set<number>;
    bytes: number;
    hasBytes: boolean;
    lastSeen: number;
    pairs: Map<string, Set<string>>;
    processes: Set<string>;
  }
  const acc = new Map<string, Acc>();
  const keyFor = (
    r: ResolvedSample,
  ): [string, Endpoint, Endpoint] | undefined => {
    const s = r.sample;
    const a = k8sEndpoint(r.src, s.src) ?? resolve(s.src);
    const b = k8sEndpoint(r.dst, s.dst) ?? resolve(s.dst, s.dstName);
    if (a.node.id === b.node.id) return undefined;
    return [`${a.node.id}\u0000${b.node.id}\u0000${s.port}`, a, b];
  };

  for (const r of stitched.samples) {
    const s = r.sample;
    if (!s.src || !s.dst || !Number.isFinite(s.port)) continue;
    const k = keyFor(r);
    if (!k) continue;
    const [key, a, b] = k;
    let e = acc.get(key);
    if (!e) {
      e = {
        source: a.node.id,
        target: b.node.id,
        port: s.port,
        hours: new Set(),
        bytes: 0,
        hasBytes: false,
        lastSeen: 0,
        pairs: new Map(),
        processes: new Set(),
      };
      acc.set(key, e);
    }
    for (const h of s.hours) e.hours.add(h);
    if (s.bytes !== undefined && Number.isFinite(s.bytes)) {
      e.bytes += s.bytes;
      e.hasBytes = true;
    }
    e.lastSeen = Math.max(e.lastSeen, s.lastSeen);
    if (s.srcProcess) e.processes.add(s.srcProcess);
    const set = e.pairs.get(a.instance) ?? new Set<string>();
    set.add(b.instance);
    e.pairs.set(a.instance, set);
  }
  for (const r of resolveSamples(mapping, inv, options.volume ?? [])) {
    const k = keyFor(r);
    if (!k) continue;
    const e = acc.get(k[0]);
    const s = r.sample;
    if (!e || s.bytes === undefined || !Number.isFinite(s.bytes)) continue;
    if (!e.hasBytes) e.bytes = 0;
    e.bytes += s.bytes;
    e.hasBytes = true;
  }

  const hours = Math.max(1, windowHours);
  const edges: DepEdge[] = [];
  for (const e of acc.values()) {
    const target = byId.get(e.target)!;
    const share = Math.min(1, e.hours.size / hours);
    const pairs: Record<string, string[]> = {};
    const pins: Record<string, string> = {};
    for (const [caller, callees] of e.pairs) {
      pairs[caller] = [...callees].sort();
      if (pinned(target, callees, clusters)) pins[caller] = [...callees][0]!;
    }
    edges.push({
      id: `${e.source}->${e.target}:${e.port}`,
      source: e.source,
      target: e.target,
      port: e.port,
      hoursSeen: e.hours.size,
      share,
      frequency: classifyFrequency(share, thresholds),
      bytesPerDay: e.hasBytes ? e.bytes / (hours / 24) : undefined,
      lastSeen: e.lastSeen,
      pairs,
      pins,
      processes: [...e.processes].sort(),
    });
  }
  edges.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  return {
    nodes,
    edges,
    byId,
    windowHours: hours,
    clusters,
    stitch: stitched.stats,
  };
}

/**
 * Hard-wired: an HA service, and this caller only ever reached one of its members, never the VIP. On
 * Kubernetes only a node counts as a member here (a NodePort called on one node address): pods are
 * picked by kube-proxy, so a caller reaching one pod is chance, not wiring, and a single-node cluster
 * has nothing to fail over to.
 */
function pinned(
  target: ServiceNode,
  callees: Set<string>,
  clusters: Map<string, ClusterInfo>,
): boolean {
  if (callees.size !== 1 || callees.has(VIP)) return false;
  if (target.k8s) {
    const nodes = clusters.get(target.k8s.cluster)?.nodes ?? [];
    const callee = [...callees][0]!;
    return (
      target.k8s.type !== "nat" &&
      nodes.length > 1 &&
      nodes.some((n) => n.name === callee)
    );
  }
  return (
    target.kind === "internal" &&
    target.ha !== "single" &&
    target.instances.length > 1
  );
}

/** Active-passive lists the primary first (role primary, else the first listed). */
function orderInstances(
  ha: HaType,
  instances: Array<{ host: string; ip: string; role?: InstanceRole }>,
): Instance[] {
  const list = instances.map((i) => ({ ...i }));
  if (ha !== "active-passive") return list;
  const p = list.findIndex((i) => i.role === "primary");
  if (p > 0) list.unshift(...list.splice(p, 1));
  return list;
}

/** The pinned callee instance, when every pinned caller instance of the edge is pinned to the same one. */
export function commonPin(e: DepEdge): string | undefined {
  const values = new Set(Object.values(e.pins));
  return values.size === 1 ? [...values][0] : undefined;
}

export function isPinned(e: DepEdge): boolean {
  return Object.keys(e.pins).length > 0;
}

export function frequencyRank(f: Frequency): number {
  return FREQUENCIES.indexOf(f);
}

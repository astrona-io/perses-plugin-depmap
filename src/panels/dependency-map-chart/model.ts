import {
  FREQUENCIES,
  Frequency,
  FrequencyThresholds,
} from "./dependency-map-chart-types";
import {
  HaType,
  InstanceRole,
  Mapping,
  MappingExternal,
  isCidr,
  isIp,
} from "./mapping";

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
}

export type NodeKind = "internal" | "external" | "unknown";

export interface Instance {
  host: string;
  ip: string;
  role?: InstanceRole;
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
  /** Instance host, or VIP. */
  instance: string;
}

/**
 * Turns collector samples into the service graph: IPs become instances of mapped services, VIPs become
 * the service itself, matches of `external` become external nodes, and anything else an unknown node
 * per IP. Edges between instances of the same service (replication, cluster traffic) are dropped.
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
  const keyFor = (s: EdgeSample): [string, Endpoint, Endpoint] | undefined => {
    const a = resolve(s.src);
    const b = resolve(s.dst, s.dstName);
    if (a.node.id === b.node.id) return undefined;
    return [`${a.node.id}\u0000${b.node.id}\u0000${s.port}`, a, b];
  };

  for (const s of samples) {
    if (!s.src || !s.dst || !Number.isFinite(s.port)) continue;
    const k = keyFor(s);
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
  for (const s of options.volume ?? []) {
    const k = keyFor(s);
    if (!k) continue;
    const e = acc.get(k[0]);
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
      // Hard-wired: an HA service, and this caller only ever reached one of its members, never the VIP.
      if (
        target.kind === "internal" &&
        target.ha !== "single" &&
        target.instances.length > 1 &&
        callees.size === 1 &&
        !callees.has(VIP)
      )
        pins[caller] = [...callees][0]!;
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
  return { nodes, edges, byId, windowHours: hours };
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

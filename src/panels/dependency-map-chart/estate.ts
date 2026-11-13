import { DepEdge, DepModel, ServiceNode, VIP } from "./model";
import { Mapping } from "./mapping";
import {
  CLIENTS_ID,
  OTHER_INTERNET_ID,
  PRIVATE_ID,
  Place,
  SERVERS_ID,
  builtinPlace,
  isPrivateIp,
  mappedPlaces,
  placeOfIp,
} from "./places";

/**
 * The estate view's data: where every flow starts and ends (a machine of a cluster, a place, the
 * servers), derived from the model. Pure: no React.
 *
 * A model edge joins two services; its `pairs` say which caller instance reached which callee instance.
 * Each pair becomes one hop between two locations. Bytes are known per edge only, so an edge's rate is
 * divided evenly over its pairs: the split between machines is an estimate, the totals are not.
 */

export interface Machine {
  id: string;
  cluster: string;
  name: string;
  ip: string;
  /** Seen serving the Kubernetes API (6443) or etcd (2379, 2380), or named like a control-plane node. */
  controlPlane: boolean;
}

export interface ClusterBlock {
  name: string;
  machines: Machine[];
}

export interface Hop {
  edge: DepEdge;
  /** Locations: a machine id, a place id, or SERVERS_ID. */
  from: string;
  to: string;
  /** Bytes per second; undefined when the edge carries no bytes. */
  bps?: number;
  /** The callee address when the callee is an external or unknown node. */
  ip?: string;
}

export interface Estate {
  clusters: ClusterBlock[];
  machines: Map<string, Machine>;
  /** Every place id that a location or node can have, mapped and built-in. */
  places: Map<string, Place>;
  /** Mapped places in match order (load balancers, storage, LANs, internet providers). */
  mapped: Place[];
  /** External and unknown node -> the place it is in. */
  nodePlace: Map<string, string>;
  hops: Hop[];
  /** Workload, Service and node-group nodes per location. */
  workloadsAt: Map<string, Set<string>>;
}

export const machineId = (cluster: string, node: string): string =>
  `m:${cluster}/${node}`;

const CONTROL_PLANE_PORTS = new Set([6443, 2379, 2380]);
const CONTROL_PLANE_NAME = /control-?plane|master|(^|[-_.])cp\d*($|[-_.])/i;

/** The estate group a location belongs to: its cluster for machines and cluster places, else itself. */
export function estateGroup(estate: Estate, loc: string): string {
  const m = estate.machines.get(loc);
  if (m) return `cluster:${m.cluster}`;
  const p = estate.places.get(loc);
  if (p?.cluster) return `cluster:${p.cluster}`;
  return loc;
}

export function buildEstate(model: DepModel, mapping: Mapping): Estate {
  const mapped = mappedPlaces(mapping);
  const places = new Map<string, Place>(mapped.map((p) => [p.id, p]));
  const machines = new Map<string, Machine>();
  const clusters: ClusterBlock[] = [];
  for (const c of [...(model.clusters?.values() ?? [])].sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const block: ClusterBlock = { name: c.name, machines: [] };
    for (const n of c.nodes) {
      const m: Machine = {
        id: machineId(c.name, n.name),
        cluster: c.name,
        name: n.name,
        ip: n.ip,
        controlPlane: CONTROL_PLANE_NAME.test(n.name),
      };
      machines.set(m.id, m);
      block.machines.push(m);
    }
    clusters.push(block);
  }
  const addBuiltin = (id: string): string => {
    if (!places.has(id)) places.set(id, builtinPlace(id)!);
    return id;
  };

  // External and unknown nodes: the place their addresses are in.
  const ips = new Map<string, Set<string>>();
  const called = new Set<string>();
  const ipsOf = (id: string): Set<string> => {
    const s = ips.get(id) ?? new Set<string>();
    ips.set(id, s);
    return s;
  };
  for (const e of model.edges) {
    called.add(e.target);
    for (const [from, to] of Object.entries(e.pairs)) {
      ipsOf(e.source).add(from);
      for (const t of to) ipsOf(e.target).add(t);
    }
  }
  const nodePlace = new Map<string, string>();
  for (const n of model.nodes) {
    if (n.kind === "internal") continue;
    const all = [
      ...n.instances.map((i) => i.ip),
      ...(ips.get(n.id) ?? []),
    ].filter((ip) => ip && ip !== VIP);
    let place: string | undefined;
    for (const ip of all) {
      const p = placeOfIp(mapped, ip);
      if (p && (p.kind === "lb" || p.kind === "storage")) {
        place = p.id;
        break;
      }
    }
    if (!place && !called.has(n.id)) place = addBuiltin(CLIENTS_ID);
    if (!place)
      for (const ip of all) {
        const p = placeOfIp(mapped, ip);
        if (p) {
          place = p.id;
          break;
        }
      }
    if (!place)
      place = addBuiltin(
        all.some((ip) => !isPrivateIp(ip)) ? OTHER_INTERNET_ID : PRIVATE_ID,
      );
    nodePlace.set(n.id, place);
  }

  const workloadsAt = new Map<string, Set<string>>();
  const at = (loc: string, id: string): void => {
    const s = workloadsAt.get(loc) ?? new Set<string>();
    s.add(id);
    workloadsAt.set(loc, s);
  };
  const locOf = (n: ServiceNode, instance: string): string => {
    const k = n.k8s;
    if (!k) {
      if (n.kind === "internal") return addBuiltin(SERVERS_ID);
      return nodePlace.get(n.id) ?? addBuiltin(PRIVATE_ID);
    }
    if (k.type === "service" || instance === VIP)
      return addBuiltin(`svc:${k.cluster}`);
    if (k.type === "nat" && k.node) return machineId(k.cluster, k.node);
    const direct = machineId(k.cluster, instance);
    if (machines.has(direct)) return direct;
    const node = n.instances.find((i) => i.host === instance)?.node;
    if (node && machines.has(machineId(k.cluster, node)))
      return machineId(k.cluster, node);
    return addBuiltin(`unplaced:${k.cluster}`);
  };

  for (const n of model.nodes) {
    if (!n.k8s) {
      if (n.kind === "internal") at(addBuiltin(SERVERS_ID), n.id);
      continue;
    }
    if (n.k8s.type === "service") at(addBuiltin(`svc:${n.k8s.cluster}`), n.id);
    else for (const i of n.instances) at(locOf(n, i.host), n.id);
  }

  const hops: Hop[] = [];
  for (const e of model.edges) {
    const a = model.byId.get(e.source);
    const b = model.byId.get(e.target);
    if (!a || !b) continue;
    const pairs = Object.entries(e.pairs).flatMap(([from, to]) =>
      to.map((t) => [from, t] as const),
    );
    const bps =
      e.bytesPerSecond !== undefined && pairs.length > 0
        ? e.bytesPerSecond / pairs.length
        : undefined;
    for (const [from, to] of pairs) {
      const h: Hop = { edge: e, from: locOf(a, from), to: locOf(b, to), bps };
      if (b.kind !== "internal") h.ip = to;
      // Pods that are no longer instances (not seen lately) still belong where their flows were.
      if (a.k8s && a.k8s.type !== "service") at(h.from, a.id);
      if (b.k8s && b.k8s.type !== "service" && to !== VIP) at(h.to, b.id);
      hops.push(h);
    }
  }
  for (const h of hops) {
    const m = machines.get(h.to);
    if (m && CONTROL_PLANE_PORTS.has(h.edge.port)) m.controlPlane = true;
  }
  return {
    clusters,
    machines,
    places,
    mapped,
    nodePlace,
    hops,
    workloadsAt,
  };
}

/** Monitoring traffic: either end's namespace or workload matches the pattern. */
export function isMonitoring(
  n: ServiceNode | undefined,
  re: RegExp | undefined,
): boolean {
  if (!n || !re) return false;
  if (n.k8s?.namespace && re.test(n.k8s.namespace)) return true;
  return re.test(n.k8s?.workload ?? n.name);
}

export function monitoringRegex(pattern: string): RegExp | undefined {
  if (!pattern) return undefined;
  try {
    return new RegExp(pattern, "i");
  } catch {
    return undefined;
  }
}

/** One aggregated link between two locations or groups. */
export interface Link {
  a: string;
  b: string;
  bps: number;
  /** False when none of its edges carries bytes. */
  measured: boolean;
  edges: Set<string>;
  ports: Set<number>;
}

/** Sums hops into links between `key(from)` and `key(to)`, dropping self-links and undefined keys. */
export function linksOf(
  hops: Hop[],
  key: (loc: string) => string | undefined,
  directed: boolean,
): Link[] {
  const g = new Map<string, Link>();
  for (const h of hops) {
    let a = key(h.from);
    let b = key(h.to);
    if (!a || !b || a === b) continue;
    if (!directed && b < a) [a, b] = [b, a];
    const k = `${a}\u0000${b}`;
    const l = g.get(k) ?? {
      a,
      b,
      bps: 0,
      measured: false,
      edges: new Set<string>(),
      ports: new Set<number>(),
    };
    if (h.bps !== undefined) {
      l.bps += h.bps;
      l.measured = true;
    }
    l.edges.add(h.edge.id);
    l.ports.add(h.edge.port);
    g.set(k, l);
  }
  return [...g.values()].sort((x, y) => y.bps - x.bps);
}

/**
 * The dependency graph of the estate: services stay themselves, external and unknown nodes become the
 * place they are in, so "GitHub" is one dependency instead of forty addresses.
 */
export interface DepGraph {
  up: Map<string, Neighbour[]>;
  down: Map<string, Neighbour[]>;
}

export interface Neighbour {
  id: string;
  bps: number;
  measured: boolean;
  ports: Set<number>;
}

export function depKey(estate: Estate, nodeId: string): string {
  return estate.nodePlace.get(nodeId) ?? nodeId;
}

export function depGraph(estate: Estate, edges: DepEdge[]): DepGraph {
  const acc = (
    m: Map<string, Map<string, Neighbour>>,
    at: string,
    other: string,
    e: DepEdge,
  ): void => {
    const inner = m.get(at) ?? new Map<string, Neighbour>();
    m.set(at, inner);
    const n = inner.get(other) ?? {
      id: other,
      bps: 0,
      measured: false,
      ports: new Set<number>(),
    };
    if (e.bytesPerSecond !== undefined) {
      n.bps += e.bytesPerSecond;
      n.measured = true;
    }
    n.ports.add(e.port);
    inner.set(other, n);
  };
  const up = new Map<string, Map<string, Neighbour>>();
  const down = new Map<string, Map<string, Neighbour>>();
  for (const e of edges) {
    const s = depKey(estate, e.source);
    const t = depKey(estate, e.target);
    if (s === t) continue;
    acc(down, s, t, e);
    acc(up, t, s, e);
  }
  const sorted = (
    m: Map<string, Map<string, Neighbour>>,
  ): Map<string, Neighbour[]> =>
    new Map(
      [...m].map(([k, v]) => [
        k,
        [...v.values()].sort((a, b) => b.bps - a.bps),
      ]),
    );
  return { up: sorted(up), down: sorted(down) };
}

/** Every id reachable upstream or downstream, with the hop it is first reached at. */
export function closure(
  g: DepGraph,
  id: string,
  dir: "up" | "down",
): Map<string, number> {
  const seen = new Map<string, number>([[id, 0]]);
  const q = [id];
  while (q.length > 0) {
    const c = q.shift()!;
    for (const n of (dir === "up" ? g.up : g.down).get(c) ?? [])
      if (!seen.has(n.id)) {
        seen.set(n.id, seen.get(c)! + 1);
        q.push(n.id);
      }
  }
  seen.delete(id);
  return seen;
}

/**
 * Blast radius of `id`: the services that lose a dependency when it goes down (directly or through
 * other services), and the places it is the only service to reach.
 */
export function blastRadius(
  g: DepGraph,
  id: string,
  isService: (id: string) => boolean,
): { direct: string[]; indirect: string[]; onlyPathTo: Neighbour[] } {
  const up = closure(g, id, "up");
  const services = [...up].filter(([k]) => isService(k));
  const onlyPathTo = (g.down.get(id) ?? []).filter(
    (n) =>
      !isService(n.id) &&
      (g.up.get(n.id) ?? [])
        .filter((c) => isService(c.id))
        .every((c) => c.id === id),
  );
  return {
    direct: services.filter(([, h]) => h === 1).map(([k]) => k),
    indirect: services.filter(([, h]) => h > 1).map(([k]) => k),
    onlyPathTo,
  };
}

import { DepGraph, Estate, Hop, depKey } from "./estate";
import { DepModel } from "./model";

/**
 * "If unreachable": mark units as down and work out, from the measured flows alone, what stops, what
 * loses a dependency and what keeps running on fewer machines. Pure: no React.
 *
 * A unit is anything that can stop answering:
 * - a machine of a cluster (its id, "m:<cluster>/<node>"): the host and every pod on it;
 * - a whole cluster ("cluster:<name>");
 * - a server host ("vm:<host>"): every instance of a mapped service on that host;
 * - a place (load balancer, storage, LAN, internet provider; its place id);
 * - one host of a storage place ("addr:<place id>@<ip>");
 * - one service or workload (its node id).
 *
 * Where a workload runs is inferred from the machines it was seen sending or receiving on, so a replica
 * that never talked in the window is not counted. Nothing reschedules: this is the first few minutes.
 */

export type OutageState =
  "risk" | "reduced" | "via" | "needs" | "gone" | "down";

const SEVERITY: Record<OutageState, number> = {
  risk: 1,
  reduced: 2,
  via: 3,
  needs: 4,
  gone: 5,
  down: 6,
};

export interface Effect {
  s: OutageState;
  why: string;
  /** The dependency it loses (or has with less headroom), when it is not down itself. */
  via?: string;
  /** Bytes per second it sent to `via`. */
  bps: number;
}

export interface Outage {
  /** Per dependency-graph id: services and places. */
  effects: Map<string, Effect>;
  /** Machines that are not down whose host (kubelet, kernel clients) loses a dependency. */
  hosts: Map<string, Effect>;
}

export interface OutageSummary {
  stop: number;
  needs: number;
  via: number;
  reduced: number;
  risk: number;
  hosts: number;
  namespaces: Set<string>;
}

/** What the simulation needs; built once per estate and filter. */
export interface OutageInput {
  model: DepModel;
  estate: Estate;
  graph: DepGraph;
  /** Hops of the edges shown. */
  hops: Hop[];
}

const isHostTraffic = (model: DepModel, id: string): boolean => {
  const t = model.byId.get(id)?.k8s?.type;
  return t === "nodes" || t === "nat";
};

/** Storage place -> the addresses of it seen in the flows, when more than one: each can fail alone. */
export function storageHosts(input: OutageInput): Map<string, string[]> {
  const out = new Map<string, Set<string>>();
  for (const h of input.hops) {
    const p = input.estate.places.get(h.to);
    if (p?.kind !== "storage" || !h.ip) continue;
    const s = out.get(p.id) ?? new Set<string>();
    s.add(h.ip);
    out.set(p.id, s);
  }
  return new Map(
    [...out]
      .filter(([, s]) => s.size > 1)
      .map(([k, s]) => [k, [...s].sort(compareIp)]),
  );
}

function compareIp(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 4; i++)
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return a.localeCompare(b);
}

export const addrUnit = (place: string, ip: string): string =>
  `addr:${place}@${ip}`;

function parseAddr(u: string): { place: string; ip: string } | undefined {
  if (!u.startsWith("addr:")) return undefined;
  const at = u.lastIndexOf("@");
  return at > 5 ? { place: u.slice(5, at), ip: u.slice(at + 1) } : undefined;
}

/** Where each service runs: machine ids for Kubernetes workloads, "vm:<host>" for mapped servers. */
export function spreadOf(input: OutageInput): Map<string, Set<string>> {
  const { model, estate } = input;
  const out = new Map<string, Set<string>>();
  const add = (id: string, at: string): void => {
    const s = out.get(id) ?? new Set<string>();
    s.add(at);
    out.set(id, s);
  };
  for (const [loc, ids] of estate.workloadsAt) {
    if (!estate.machines.has(loc)) continue;
    for (const id of ids)
      if (model.byId.get(id)?.k8s?.type === "workload") add(id, loc);
  }
  for (const n of model.nodes)
    if (n.kind === "internal" && !n.k8s)
      for (const i of n.instances) add(n.id, `vm:${i.host}`);
  return out;
}

/** Whether `u` names something this estate has. */
export function isUnit(input: OutageInput, u: string): boolean {
  const { model, estate } = input;
  if (estate.machines.has(u)) return true;
  if (u.startsWith("cluster:"))
    return estate.clusters.some((c) => c.name === u.slice(8));
  if (u.startsWith("vm:"))
    return model.nodes.some(
      (n) => !n.k8s && n.instances.some((i) => `vm:${i.host}` === u),
    );
  const a = parseAddr(u);
  if (a) return storageHosts(input).get(a.place)?.includes(a.ip) ?? false;
  const p = estate.places.get(u);
  if (p)
    return ["lb", "storage", "lan", "internet", "private"].includes(p.kind);
  return model.byId.get(u)?.kind === "internal";
}

/** Everything worth trying alone, for the ranking: machines, server hosts, places and storage hosts. */
export function candidateUnits(input: OutageInput): string[] {
  const { model, estate, graph } = input;
  const inGraph = (id: string): boolean => graph.up.has(id);
  const vms = new Set<string>();
  for (const n of model.nodes)
    if (n.kind === "internal" && !n.k8s)
      for (const i of n.instances) vms.add(`vm:${i.host}`);
  const places = [...estate.places.values()]
    .filter(
      (p) =>
        ["lb", "storage", "lan", "internet", "private"].includes(p.kind) &&
        inGraph(p.id),
    )
    .map((p) => p.id);
  const addrs = [...storageHosts(input)].flatMap(([p, ips]) =>
    ips.map((ip) => addrUnit(p, ip)),
  );
  return [...estate.machines.keys(), ...[...vms].sort(), ...places, ...addrs];
}

export function simulate(
  input: OutageInput,
  down: Iterable<string>,
  name: (id: string) => string,
): Outage {
  const { model, estate, graph } = input;
  const units = new Set(down);
  const effects = new Map<string, Effect>();
  const set = (id: string, e: Effect): void => {
    const c = effects.get(id);
    if (!c || SEVERITY[e.s] > SEVERITY[c.s]) effects.set(id, e);
  };

  // Machines and server hosts that are gone.
  const lost = new Set<string>();
  for (const u of units) {
    if (estate.machines.has(u) || u.startsWith("vm:")) lost.add(u);
    if (u.startsWith("cluster:")) {
      const cl = u.slice(8);
      for (const m of estate.machines.values())
        if (m.cluster === cl) lost.add(m.id);
      for (const n of model.nodes)
        if (n.k8s?.cluster === cl && !isHostTraffic(model, n.id))
          set(n.id, { s: "down", why: "the cluster is unreachable", bps: 0 });
    }
  }
  for (const u of units)
    if (!lost.has(u) && !u.startsWith("cluster:") && !parseAddr(u))
      set(u, { s: "down", why: "marked unreachable", bps: 0 });

  // Storage that loses some of its hosts.
  const byPlace = new Map<string, number>();
  for (const u of units) {
    const a = parseAddr(u);
    if (a) byPlace.set(a.place, (byPlace.get(a.place) ?? 0) + 1);
  }
  const hostsOf = storageHosts(input);
  for (const [p, n] of byPlace) {
    const all = hostsOf.get(p)?.length ?? n;
    if (n >= all)
      set(p, {
        s: "down",
        why: `every host of ${name(p)} is unreachable`,
        bps: 0,
      });
    else
      set(p, {
        s: "reduced",
        why: `${all - n} of ${all} hosts left`,
        bps: 0,
      });
  }

  // Services on lost machines: gone when every machine they ran on is, else fewer.
  for (const [id, at] of spreadOf(input)) {
    const gone = [...at].filter((m) => lost.has(m));
    if (gone.length === 0) continue;
    const machine = (m: string): string =>
      m.startsWith("vm:") ? m.slice(3) : name(m);
    if (gone.length === at.size)
      set(id, {
        s: "gone",
        why:
          at.size === 1
            ? `ran only on ${machine(gone[0]!)}`
            : `all ${at.size} machines it ran on are unreachable`,
        bps: 0,
      });
    else
      set(id, {
        s: "reduced",
        why: `${at.size - gone.length} of ${at.size} machines left`,
        bps: 0,
      });
  }

  const callers = (
    id: string,
  ): Array<{ id: string; bps: number; ports: Set<number> }> =>
    (graph.up.get(id) ?? []).filter(
      (c) => c.id !== id && !isHostTraffic(model, c.id),
    );
  const portsText = (ps: Set<number>): string => {
    const s = [...ps].sort((a, b) => a - b).slice(0, 2);
    return s.length ? ` on :${s.join(", :")}` : "";
  };
  const directWhy = (target: string, ps: Set<number>): string =>
    estate.places.get(target)?.kind === "lb" && ps.has(6443)
      ? `reaches the Kubernetes API through ${name(target)}`
      : `calls ${name(target)}${portsText(ps)}`;

  // Callers of something that stopped lose a dependency; their callers may break through them.
  const stopped = (s: OutageState): boolean => s === "down" || s === "gone";
  let queue = [...effects].filter(([, e]) => stopped(e.s)).map(([id]) => id);
  const seen = new Set(queue);
  for (let hop = 1; queue.length > 0 && hop <= 4; hop++) {
    const next: string[] = [];
    for (const id of queue)
      for (const c of callers(id)) {
        if (seen.has(c.id)) continue;
        const via = effects.get(id)?.via;
        set(c.id, {
          s: hop === 1 ? "needs" : "via",
          why:
            hop === 1
              ? directWhy(id, c.ports)
              : `calls ${name(id)}, which loses ${name(via ?? id)}`,
          via: id,
          bps: c.bps,
        });
        seen.add(c.id);
        next.push(c.id);
      }
    queue = next;
  }

  // Callers of something that runs on fewer machines: still served, with less headroom.
  for (const [id, e] of [...effects])
    if (e.s === "reduced")
      for (const c of callers(id))
        set(c.id, {
          s: "risk",
          why: `calls ${name(id)}, which has ${e.why}`,
          via: id,
          bps: c.bps,
        });

  // Callers pinned to one instance that is gone lose it, even though others remain.
  const machineOf = (id: string, host: string): string => {
    const cl = model.byId.get(id)?.k8s?.cluster;
    return cl ? `m:${cl}/${host}` : `vm:${host}`;
  };
  for (const edge of model.edges) {
    if (effects.get(edge.target)?.s !== "reduced") continue;
    if (isHostTraffic(model, edge.source)) continue;
    const pinned = Object.values(edge.pins).find((h) =>
      lost.has(machineOf(edge.target, h)),
    );
    if (pinned)
      set(edge.source, {
        s: "needs",
        why: `only ever called ${name(edge.target)} on ${pinned}, which is unreachable`,
        via: edge.target,
        bps: edge.bytesPerSecond ?? 0,
      });
  }

  // The machines themselves: kubelet and kernel clients (storage, the API) talk from the host.
  const hosts = new Map<string, Effect>();
  for (const h of input.hops) {
    if (!isHostTraffic(model, h.edge.source) || lost.has(h.from)) continue;
    if (!estate.machines.has(h.from)) continue;
    const target = depKey(estate, h.edge.target);
    const e = effects.get(target);
    if (!e || !stopped(e.s)) continue;
    const cur = hosts.get(h.from);
    const storage = estate.places.get(target)?.kind === "storage";
    const why = storage
      ? `kernel client of ${name(target)}: volumes mounted here stall`
      : directWhy(target, new Set([h.edge.port]));
    hosts.set(h.from, {
      s: "needs",
      why: cur?.why ?? why,
      via: cur?.via ?? target,
      bps: (cur?.bps ?? 0) + (h.bps ?? 0),
    });
  }
  return { effects, hosts };
}

/** Counts for the side panel; only services count as workloads. */
export function summarize(input: OutageInput, out: Outage): OutageSummary {
  const c: OutageSummary = {
    stop: 0,
    needs: 0,
    via: 0,
    reduced: 0,
    risk: 0,
    hosts: out.hosts.size,
    namespaces: new Set(),
  };
  for (const [id, e] of out.effects) {
    const n = input.model.byId.get(id);
    if (n?.kind !== "internal") continue;
    const k = e.s === "down" || e.s === "gone" ? "stop" : e.s;
    c[k]++;
    if (k === "stop" || k === "needs" || k === "via")
      c.namespaces.add(n.k8s?.namespace ?? n.owner ?? "");
  }
  return c;
}

export const outageScore = (c: OutageSummary): number =>
  c.stop * 3 + c.needs * 2 + c.via + c.hosts * 2;

/** "23 stop", "2 lose a dependency", ...: the non-zero counts, worst first. */
export function summaryParts(c: OutageSummary): string[] {
  return [
    c.stop ? `${c.stop} stop` : "",
    c.needs ? `${c.needs} lose a dependency` : "",
    c.via ? `${c.via} may break` : "",
    c.hosts ? `${c.hosts} machine${c.hosts === 1 ? "" : "s"} affected` : "",
    c.reduced ? `${c.reduced} on fewer machines` : "",
    c.risk ? `${c.risk} with less headroom` : "",
  ].filter(Boolean);
}

/** Every candidate tried alone, worst first. */
export function rankUnits(
  input: OutageInput,
  name: (id: string) => string,
): Array<{ unit: string; summary: OutageSummary }> {
  return candidateUnits(input)
    .map((unit) => ({
      unit,
      summary: summarize(input, simulate(input, [unit], name)),
    }))
    .sort((a, b) => outageScore(b.summary) - outageScore(a.summary));
}

/** The chain of dependencies an effect travels along, nearest first. */
export function chainOf(out: Outage, id: string): string[] {
  const path: string[] = [];
  let e = out.effects.get(id) ?? out.hosts.get(id);
  while (e?.via && path.length < 6 && !path.includes(e.via)) {
    path.push(e.via);
    e = out.effects.get(e.via);
  }
  return path;
}

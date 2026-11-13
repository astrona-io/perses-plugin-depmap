import { DepEdge, DepModel, ServiceNode, VIP } from "./model";

/**
 * What happens when servers go down. Pure: a model and a set of down instance hosts in, a state per
 * service and per edge out. No React, no ECharts, so every rule is unit-tested on its own.
 *
 * Order of evaluation:
 * 1. Each service's own HA rule against the instances that are down.
 * 2. Hard-wired (pinned) callers: a caller instance that only ever reached a down instance is as good
 *    as down itself. Repeated until nothing changes, because a lost caller can pin others in turn.
 * 3. Propagation along the edges, from callee to caller: a caller of a down service breaks ("needs X"),
 *    a caller of a broken service breaks through it ("via X"), transitively; a caller of a service that
 *    is failing over or overloaded is at risk.
 */

export type ServiceState =
  | "ok"
  | "reduced"
  | "failover"
  | "overload"
  | "degraded"
  | "risk"
  | "brokenvia"
  | "broken"
  | "down";

/** Severity, highest first. A service keeps the most severe state any rule gives it. */
export const STATE_ORDER: ServiceState[] = [
  "down",
  "broken",
  "brokenvia",
  "overload",
  "failover",
  "degraded",
  "risk",
  "reduced",
  "ok",
];

export const OUTAGE_STATES: ReadonlySet<ServiceState> = new Set([
  "down",
  "broken",
  "brokenvia",
]);

export function isOutage(s: ServiceState): boolean {
  return OUTAGE_STATES.has(s);
}

function severity(s: ServiceState): number {
  return STATE_ORDER.length - STATE_ORDER.indexOf(s);
}

export interface ServiceResult {
  state: ServiceState;
  reason: string;
  /** Instances counted as down: really down, or lost through a hard-wired dependency. */
  downInstances: string[];
  /** Instances lost only because they are hard-wired to a down instance. */
  lostInstances: string[];
}

export type EdgeEffect = "cut" | "pinlost" | "risk" | "ok";

export interface FailureResult {
  services: Map<string, ServiceResult>;
  edges: Map<string, EdgeEffect>;
  /** Service ids that are down or broken, most severe first. */
  outages: string[];
  counts: Record<ServiceState, number>;
}

interface HaResult {
  state: "ok" | "reduced" | "failover" | "overload" | "down";
  reason: string;
}

/** A service's own HA rule, given which of its instances are down. */
export function evaluateHa(
  node: ServiceNode,
  down: ReadonlySet<string>,
): HaResult {
  const all = node.instances;
  if (all.length === 0) return { state: "ok", reason: "" };
  const dead = all.filter((i) => down.has(i.host));
  if (dead.length === 0) return { state: "ok", reason: "" };
  const up = all.filter((i) => !down.has(i.host));
  const n = all.length;
  switch (node.ha) {
    case "single":
      return {
        state: "down",
        reason: `${dead.map((i) => i.host).join(", ")} is down`,
      };
    case "active-passive": {
      const primary = all[0]!;
      if (up.length === 0)
        return { state: "down", reason: "primary and standby down" };
      if (down.has(primary.host))
        return { state: "failover", reason: `fails over to ${up[0]!.host}` };
      return {
        state: "reduced",
        reason: `standby ${dead.map((i) => i.host).join(", ")} down, no failover left`,
      };
    }
    case "active-active": {
      const minUp = Math.max(1, node.minUp);
      if (up.length < minUp)
        return {
          state: "down",
          reason:
            up.length === 0
              ? "all nodes down"
              : `only ${up.length} of ${n} up, needs ${minUp}`,
        };
      if (node.load === undefined)
        return {
          state: "reduced",
          reason: `${up.length} of ${n} up, load unknown`,
        };
      const per = Math.round((node.load * n) / up.length);
      if (per > 100)
        return {
          state: "overload",
          reason: `${up.length} of ${n} up, needs ${per}% capacity`,
        };
      return {
        state: "reduced",
        reason: `${up.length} of ${n} up, ${per}% load`,
      };
    }
    case "quorum":
      if (up.length * 2 > n)
        return {
          state: "reduced",
          reason: `${up.length} of ${n} up, quorum kept`,
        };
      return { state: "down", reason: `quorum lost (${up.length} of ${n})` };
  }
}

function emptyCounts(): Record<ServiceState, number> {
  return Object.fromEntries(STATE_ORDER.map((s) => [s, 0])) as Record<
    ServiceState,
    number
  >;
}

export function evaluateFailure(
  model: Pick<DepModel, "nodes" | "edges" | "byId">,
  downHosts: Iterable<string>,
): FailureResult {
  const down = new Set(downHosts);
  const { nodes, edges, byId } = model;

  // 2. Hard-wired callers, to a fixpoint. `effective` = really down + lost.
  const effective = new Set(down);
  const lostBy = new Map<string, string>(); // lost caller host -> the callee host it is wired to
  for (let changed = true; changed;) {
    changed = false;
    for (const e of edges) {
      for (const [caller, callee] of Object.entries(e.pins)) {
        if (effective.has(caller) || !effective.has(callee)) continue;
        effective.add(caller);
        lostBy.set(caller, callee);
        changed = true;
      }
    }
  }

  // 1 + 2. Own state per service.
  const services = new Map<string, ServiceResult>();
  for (const node of nodes) {
    const own = evaluateHa(node, down);
    const lost = node.instances.filter(
      (i) => lostBy.has(i.host) && !down.has(i.host),
    );
    const downInstances = node.instances
      .filter((i) => effective.has(i.host))
      .map((i) => i.host);
    const lostInstances = lost.map((i) => i.host);
    if (own.state === "down" || lost.length === 0) {
      services.set(node.id, {
        state: own.state,
        reason: own.reason,
        downInstances,
        lostInstances,
      });
      continue;
    }
    const withLost = evaluateHa(node, effective);
    const wiredTo = [...new Set(lost.map((i) => lostBy.get(i.host)!))].join(
      ", ",
    );
    const pinReason =
      lost.length === node.instances.length || node.instances.length === 1
        ? `hard-wired to ${wiredTo}, failover can't help`
        : `${lostInstances.join(", ")} hard-wired to ${wiredTo}`;
    let state: ServiceState;
    let reason: string;
    if (withLost.state === "down") {
      state = "broken";
      reason =
        lost.length === downInstances.length
          ? pinReason
          : `${pinReason}; ${withLost.reason}`;
    } else if (withLost.state === "overload") {
      state = "overload";
      reason = `${pinReason}; ${withLost.reason}`;
    } else {
      state = "degraded";
      reason = withLost.reason ? `${pinReason}; ${withLost.reason}` : pinReason;
    }
    services.set(node.id, { state, reason, downInstances, lostInstances });
  }

  // 3. Propagation from callee to caller, transitively.
  const callersOf = new Map<string, DepEdge[]>();
  for (const e of edges) {
    const list = callersOf.get(e.target) ?? [];
    list.push(e);
    callersOf.set(e.target, list);
  }
  const raise = (id: string, state: ServiceState, reason: string): boolean => {
    const cur = services.get(id);
    if (!cur) return false;
    if (severity(state) <= severity(cur.state)) return false;
    cur.state = state;
    cur.reason = reason;
    return true;
  };
  const queue = nodes
    .filter((n) => isOutage(services.get(n.id)!.state))
    .map((n) => n.id);
  while (queue.length > 0) {
    const id = queue.shift()!;
    const s = services.get(id)!;
    const name = byId.get(id)?.name ?? id;
    for (const e of callersOf.get(id) ?? []) {
      const next: ServiceState = s.state === "down" ? "broken" : "brokenvia";
      const reason = s.state === "down" ? `needs ${name}` : `via ${name}`;
      if (raise(e.source, next, reason)) queue.push(e.source);
    }
  }
  for (const node of nodes) {
    const s = services.get(node.id)!;
    if (s.state !== "failover" && s.state !== "overload") continue;
    const verb = s.state === "failover" ? "failing over" : "overloaded";
    for (const e of callersOf.get(node.id) ?? [])
      raise(e.source, "risk", `${node.name} is ${verb}`);
  }

  // Edges.
  const edgeFx = new Map<string, EdgeEffect>();
  for (const e of edges) {
    const t = services.get(e.target)!.state;
    let fx: EdgeEffect = "ok";
    if (isOutage(t)) fx = "cut";
    else if (
      Object.entries(e.pins).some(
        ([c, callee]) => effective.has(callee) && lostBy.get(c) === callee,
      )
    )
      fx = "pinlost";
    else if (t === "failover" || t === "overload") fx = "risk";
    edgeFx.set(e.id, fx);
  }

  const counts = emptyCounts();
  for (const s of services.values()) counts[s.state] += 1;
  const outages = nodes
    .map((n) => n.id)
    .filter((id) => isOutage(services.get(id)!.state))
    .sort(
      (a, b) =>
        severity(services.get(b)!.state) - severity(services.get(a)!.state) ||
        (a < b ? -1 : a > b ? 1 : 0),
    );
  return { services, edges: edgeFx, outages, counts };
}

export interface SinglePointOfFailure {
  host: string;
  service: string;
  outages: string[];
}

/** Every instance of an internal or unknown service, alone: which take something down with them. */
export function loseOneServer(
  model: Pick<DepModel, "nodes" | "edges" | "byId">,
): SinglePointOfFailure[] {
  const out: SinglePointOfFailure[] = [];
  for (const node of model.nodes) {
    if (node.kind === "external") continue;
    for (const i of node.instances) {
      const r = evaluateFailure(model, [i.host]);
      if (r.outages.length > 0)
        out.push({ host: i.host, service: node.id, outages: r.outages });
    }
  }
  return out.sort(
    (a, b) =>
      b.outages.length - a.outages.length ||
      (a.host < b.host ? -1 : a.host > b.host ? 1 : 0),
  );
}

export interface HardWiredClient {
  edgeId: string;
  caller: string;
  callerHost: string;
  callee: string;
  calleeHost: string;
}

/** Callers that bypass an HA service's VIP and only ever talk to one member. */
export function hardWiredClients(
  model: Pick<DepModel, "edges">,
): HardWiredClient[] {
  const out: HardWiredClient[] = [];
  for (const e of model.edges)
    for (const [callerHost, calleeHost] of Object.entries(e.pins))
      out.push({
        edgeId: e.id,
        caller: e.source,
        callerHost,
        callee: e.target,
        calleeHost,
      });
  return out.sort((a, b) =>
    a.edgeId + a.callerHost < b.edgeId + b.callerHost ? -1 : 1,
  );
}

/** Everything a service needs, directly or through others (its transitive callees). */
export function needsOf(
  model: Pick<DepModel, "edges">,
  id: string,
): Set<string> {
  const out = new Map<string, string[]>();
  for (const e of model.edges) {
    const list = out.get(e.source) ?? [];
    list.push(e.target);
    out.set(e.source, list);
  }
  const seen = new Set<string>();
  const stack = [...(out.get(id) ?? [])];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (n === id || seen.has(n)) continue;
    seen.add(n);
    stack.push(...(out.get(n) ?? []));
  }
  return seen;
}

/** Every instance host the toggles can take down (VIPs are not instances). */
export function allHosts(model: Pick<DepModel, "nodes">): string[] {
  return model.nodes
    .flatMap((n) => n.instances.map((i) => i.host))
    .filter((h) => h !== VIP);
}

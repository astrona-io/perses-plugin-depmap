import { DepEdge, DepModel, ServiceNode, VIP } from "./model";

/**
 * Firewall openings a migration wave needs. Moving wave w puts the services of waves 1..w in the new
 * data centre; every edge that wave w's services take part in and that now crosses a zone boundary
 * (old DC, new DC, outside) needs a rule. Rules are per instance: hard-wired callers get exactly the
 * member they use, everyone else every member plus the VIP so a failover keeps working.
 */

export type Zone = "old" | "new" | "ext";

export interface Endpoint {
  host: string;
  ip: string;
}

export interface FirewallRule {
  edgeId: string;
  source: string;
  target: string;
  fromZone: Zone;
  toZone: Zone;
  src: Endpoint;
  dst: Endpoint;
  port: number;
  protocol: "tcp";
}

export function zoneOf(node: ServiceNode, wave: number): Zone {
  if (node.kind !== "internal") return "ext";
  if (node.wave > 0 && node.wave <= wave) return "new";
  return "old";
}

function callerEndpoints(node: ServiceNode, e: DepEdge): Endpoint[] {
  if (node.instances.length > 0)
    return node.instances.map((i) => ({ host: i.host, ip: i.ip }));
  // External callers have no instances: use the addresses that were seen.
  return Object.keys(e.pairs).map((ip) => ({ host: node.name, ip }));
}

function calleeEndpoints(node: ServiceNode, e: DepEdge): Endpoint[] {
  if (node.kind === "external") {
    const ips = new Set(Object.values(e.pairs).flat());
    return [...ips].sort().map((ip) => ({ host: node.name, ip }));
  }
  const list = node.instances.map((i) => ({ host: i.host, ip: i.ip }));
  if (node.vip) list.push({ host: `${node.id} ${VIP}`, ip: node.vip });
  return list;
}

export function firewallRulesForWave(
  model: Pick<DepModel, "edges" | "byId">,
  wave: number,
): FirewallRule[] {
  const rules: FirewallRule[] = [];
  const seen = new Set<string>();
  for (const e of model.edges) {
    const a = model.byId.get(e.source);
    const b = model.byId.get(e.target);
    if (!a || !b) continue;
    if (a.wave !== wave && b.wave !== wave) continue;
    const fromZone = zoneOf(a, wave);
    const toZone = zoneOf(b, wave);
    if (fromZone === toZone) continue;
    const all = calleeEndpoints(b, e);
    const pinValues = new Set(Object.values(e.pins));
    // A caller instance that was never seen (an idle standby) is configured like its siblings: when
    // every seen caller is wired to the same member, so is it.
    const common =
      pinValues.size === 1 &&
      Object.keys(e.pins).length === Object.keys(e.pairs).length
        ? [...pinValues][0]
        : undefined;
    for (const src of callerEndpoints(a, e)) {
      const pin = e.pins[src.host] ?? (e.pairs[src.host] ? undefined : common);
      const dsts = pin ? all.filter((d) => d.host === pin) : all;
      for (const dst of dsts) {
        const key = `${src.ip}>${dst.ip}:${e.port}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rules.push({
          edgeId: e.id,
          source: e.source,
          target: e.target,
          fromZone,
          toZone,
          src,
          dst,
          port: e.port,
          protocol: "tcp",
        });
      }
    }
  }
  return rules;
}

export function formatRule(r: FirewallRule): string {
  return `${r.src.host} (${r.src.ip}) -> ${r.dst.host} (${r.dst.ip}):${r.port}/${r.protocol}`;
}

export function formatRules(rules: FirewallRule[]): string {
  return rules.map(formatRule).join("\n");
}

/** Waves that have services, ascending. */
export function wavesOf(model: Pick<DepModel, "nodes">): number[] {
  return [
    ...new Set(
      model.nodes
        .filter((n) => n.kind === "internal" && n.wave > 0)
        .map((n) => n.wave),
    ),
  ].sort((x, y) => x - y);
}

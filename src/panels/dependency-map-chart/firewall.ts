import { ClusterInfo, DepEdge, DepModel, ServiceNode, VIP } from "./model";

/**
 * Firewall openings a migration wave needs. Moving wave w puts the services of waves 1..w in the new
 * data centre; every edge that wave w's services take part in and that now crosses a zone boundary
 * (old DC, new DC, outside) needs a rule. Rules are per instance: hard-wired callers get exactly the
 * member they use, everyone else every member plus the VIP so a failover keeps working.
 *
 * A Kubernetes cluster is a zone of its own ("k8s"). Pods are never addresses in a rule: traffic out of
 * the cluster comes from its egress addresses (mapping `egressIps`, else every node address, because
 * a pod can run on any node); traffic in goes to node addresses on the NodePort (only the pinned node
 * when a caller only ever used one) or to the LoadBalancer address.
 */

export type Zone = "old" | "new" | "ext" | "k8s";

type Model = Pick<DepModel, "edges" | "byId" | "clusters">;

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
  if (node.k8s) return "k8s";
  if (node.kind !== "internal") return "ext";
  if (node.wave > 0 && node.wave <= wave) return "new";
  return "old";
}

function clusterOf(model: Model, node: ServiceNode): ClusterInfo | undefined {
  return node.k8s ? model.clusters?.get(node.k8s.cluster) : undefined;
}

function nodeEndpoints(c: ClusterInfo | undefined): Endpoint[] {
  return (c?.nodes ?? [])
    .filter((n) => n.ip)
    .map((n) => ({ host: n.name, ip: n.ip }));
}

function callerEndpoints(
  model: Model,
  node: ServiceNode,
  e: DepEdge,
): Endpoint[] {
  if (node.k8s) {
    const c = clusterOf(model, node);
    if (node.k8s.type === "nat")
      return node.instances
        .filter((i) => i.ip)
        .map((i) => ({ host: i.host, ip: i.ip }));
    if (c?.egressIps?.length)
      return c.egressIps.map((ip) => ({ host: `${c.name} egress`, ip }));
    return nodeEndpoints(c);
  }
  if (node.instances.length > 0)
    return node.instances.map((i) => ({ host: i.host, ip: i.ip }));
  // External callers have no instances: use the addresses that were seen.
  return Object.keys(e.pairs).map((ip) => ({ host: node.name, ip }));
}

function calleeEndpoints(
  model: Model,
  node: ServiceNode,
  e: DepEdge,
): Endpoint[] {
  if (node.k8s) {
    const list = nodeEndpoints(clusterOf(model, node));
    if (
      node.vip &&
      node.k8s.type === "workload" &&
      Object.values(e.pairs).some((c) => c.includes(VIP))
    )
      list.push({ host: `${node.name} ${VIP}`, ip: node.vip });
    return list;
  }
  if (node.kind === "external") {
    const ips = new Set(Object.values(e.pairs).flat());
    return [...ips].sort().map((ip) => ({ host: node.name, ip }));
  }
  const list = node.instances.map((i) => ({ host: i.host, ip: i.ip }));
  if (node.vip) list.push({ host: `${node.id} ${VIP}`, ip: node.vip });
  return list;
}

export function firewallRulesForWave(
  model: Model,
  wave: number,
): FirewallRule[] {
  return rulesFor(model, wave, (a, b) =>
    !a.k8s && !b.k8s
      ? a.wave === wave || b.wave === wave
      : (a.k8s ? b : a).wave === wave && wave > 0,
  );
}

/** Every opening across one Kubernetes cluster's boundary, in and out, as the estate is today. */
export function firewallRulesForCluster(
  model: Model,
  cluster: string,
): FirewallRule[] {
  return rulesFor(
    model,
    0,
    (a, b) => (a.k8s?.cluster === cluster) !== (b.k8s?.cluster === cluster),
  );
}

function rulesFor(
  model: Model,
  wave: number,
  include: (a: ServiceNode, b: ServiceNode) => boolean,
): FirewallRule[] {
  const rules: FirewallRule[] = [];
  const seen = new Set<string>();
  for (const e of model.edges) {
    const a = model.byId.get(e.source);
    const b = model.byId.get(e.target);
    if (!a || !b) continue;
    if (!include(a, b)) continue;
    const fromZone = zoneOf(a, wave);
    const toZone = zoneOf(b, wave);
    if (fromZone === toZone && a.k8s?.cluster === b.k8s?.cluster) continue;
    const all = calleeEndpoints(model, b, e);
    const pinValues = new Set(Object.values(e.pins));
    // A caller instance that was never seen (an idle standby) is configured like its siblings: when
    // every seen caller is wired to the same member, so is it.
    const common =
      pinValues.size === 1 &&
      Object.keys(e.pins).length === Object.keys(e.pairs).length
        ? [...pinValues][0]
        : undefined;
    for (const src of callerEndpoints(model, a, e)) {
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
        .filter((n) => n.kind === "internal" && !n.k8s && n.wave > 0)
        .map((n) => n.wave),
    ),
  ].sort((x, y) => x - y);
}

import { isMap, isSeq, parseDocument } from "yaml";

/**
 * The mapping file: what traffic cannot tell. Names, owners, migration waves and HA groups per service,
 * plus names for known external endpoints. The same schema is published as collect/mapping.schema.json.
 */

export type HaType = "single" | "active-active" | "active-passive" | "quorum";
export const HA_TYPES: HaType[] = [
  "single",
  "active-active",
  "active-passive",
  "quorum",
];
export type InstanceRole = "primary" | "standby" | "member";

export interface MappingInstance {
  host: string;
  ip: string;
  role?: InstanceRole;
}

export interface MappingService {
  id: string;
  name?: string;
  owner?: string;
  /** 0 = stays in the old DC, 1..n = migration wave. */
  wave?: number;
  ha?: HaType;
  instances: MappingInstance[];
  vip?: string;
  /** active-active: how many instances must be up. Default 1. */
  minUp?: number;
  /** Load as % of the total capacity of all instances, when no loadQuery is given. */
  load?: number;
  /** PromQL returning the load as % of the total capacity of all instances. */
  loadQuery?: string;
  /** Free text, e.g. "tomcat" or "oracle · Data Guard". */
  process?: string;
}

export interface MappingExternal {
  /** An IP, a CIDR, or a name reported by the collector (e.g. OBI's dst_name). */
  match: string;
  name?: string;
  owner?: string;
}

/** A Kubernetes node: its name as the API reports it and the address the rest of the network sees. */
export interface MappingNode {
  name: string;
  /** The node address other networks see (the source of SNATed pod traffic); used in firewall rules. */
  ip: string;
  /** Other addresses of the node (internal IP, other interfaces): recognised, not used in rules. */
  addresses?: string[];
}

export interface MappingCluster {
  /** As OBI reports it in k8s_cluster_name (OTEL_EBPF_KUBE_CLUSTER_NAME). */
  name: string;
  nodes: MappingNode[];
  /** Addresses pod traffic leaves the cluster with, when not the node addresses (egress gateway, NAT). */
  egressIps?: string[];
  /** Namespaces left off the map. Default ["kube-system"]. */
  hideNamespaces?: string[];
}

/**
 * A service made of Kubernetes pods. No addresses: pods are matched by cluster, namespace and workload
 * (the owner OBI reports: Deployment, StatefulSet, DaemonSet, ...), so they can come and go.
 */
export interface MappingWorkload {
  id: string;
  name?: string;
  owner?: string;
  /** Required when the mapping lists more than one cluster. */
  cluster?: string;
  namespace: string;
  /** Workload (owner) name, or a glob with `*`. Default: the id. */
  workload?: string;
  /** Kubernetes Service names in front of it. Default: the workload name, when it is not a glob. */
  services?: string[];
  /** Desired replicas; HA is judged against this, not against the pods that happened to be seen. */
  replicas?: number;
  /** Default active-active when replicas > 1, else single. */
  ha?: HaType;
  minUp?: number;
  /** NodePorts that lead to it: calls to a node address on one of these ports are calls to it. */
  nodePorts?: number[];
  /** LoadBalancer address in front of it. */
  loadBalancerIp?: string;
  load?: number;
  loadQuery?: string;
  process?: string;
}

export interface MappingKubernetes {
  clusters: MappingCluster[];
  services: MappingWorkload[];
}

/** A group of addresses shown as one place on the estate map: a load balancer, storage, a LAN, a provider. */
export interface MappingPlace {
  name: string;
  /** IP addresses and CIDRs in the place. */
  match: string[];
  /** Free text shown under the name, e.g. "HAProxy + keepalived". */
  note?: string;
  /** Storage only: `ceph` names Ceph's port roles (mon on 3300 and 6789, OSD / mgr on 6800-7300). */
  preset?: "ceph";
  /**
   * Load balancers only: clusters (by name) or places it forwards to. When no flow from it to one of
   * them is measured (its host runs no collector), the link is drawn dashed as "not measured".
   */
  forwardsTo?: string[];
}

export type PlaceGroup = "loadBalancers" | "storage" | "lan" | "internet";
export const PLACE_GROUPS: PlaceGroup[] = [
  "loadBalancers",
  "storage",
  "lan",
  "internet",
];

/**
 * Places for the estate view. `internet` lists providers by their published ranges; when it is left
 * out, well-known public ranges are used (see places.ts), and `internet: []` turns them off.
 */
export type MappingPlaces = Partial<Record<PlaceGroup, MappingPlace[]>>;

export interface Mapping {
  services: MappingService[];
  external: MappingExternal[];
  /** Optional; absent in mappings written for v0.1. */
  kubernetes?: MappingKubernetes;
  /** Optional; absent in mappings written before v0.3. */
  places?: MappingPlaces;
}

export interface MappingResult {
  mapping: Mapping;
  errors: string[];
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const IPV6 = /^[0-9a-fA-F:]+:[0-9a-fA-F:.]*$/;

export function isIp(s: string): boolean {
  return IPV4.test(s) || IPV6.test(s);
}

export function isCidr(s: string): boolean {
  const [ip, bits, ...rest] = s.split("/");
  if (rest.length || ip === undefined || bits === undefined) return false;
  const n = Number(bits);
  if (!/^\d+$/.test(bits)) return false;
  if (IPV4.test(ip)) return n >= 0 && n <= 32;
  if (IPV6.test(ip)) return n >= 0 && n <= 128;
  return false;
}

const SERVICE_KEYS = new Set([
  "id",
  "name",
  "owner",
  "wave",
  "ha",
  "instances",
  "vip",
  "minUp",
  "load",
  "loadQuery",
  "process",
]);
const INSTANCE_KEYS = new Set(["host", "ip", "role"]);
const EXTERNAL_KEYS = new Set(["match", "name", "owner"]);
const KUBERNETES_KEYS = new Set(["clusters", "services"]);
const CLUSTER_KEYS = new Set(["name", "nodes", "egressIps", "hideNamespaces"]);
const NODE_KEYS = new Set(["name", "ip", "addresses"]);
const WORKLOAD_KEYS = new Set([
  "id",
  "name",
  "owner",
  "cluster",
  "namespace",
  "workload",
  "services",
  "replicas",
  "ha",
  "minUp",
  "nodePorts",
  "loadBalancerIp",
  "load",
  "loadQuery",
  "process",
]);
export const DEFAULT_HIDDEN_NAMESPACES = ["kube-system"];

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Parses the mapping (YAML, of which JSON is a subset) and checks it against the schema. Every problem
 * is reported with its path; whatever is valid is still returned, so one typo does not blank the map.
 */
export function parseMapping(text: string): MappingResult {
  const errors: string[] = [];
  const empty: Mapping = { services: [], external: [] };
  if (!text.trim()) return { mapping: empty, errors };
  let raw: unknown;
  try {
    const doc = parseDocument(text, { prettyErrors: false });
    if (doc.errors.length > 0) {
      return {
        mapping: empty,
        errors: doc.errors.map((e) => `mapping: ${e.message}`),
      };
    }
    raw = doc.toJS();
  } catch (e) {
    return { mapping: empty, errors: [`mapping: ${(e as Error).message}`] };
  }
  if (raw === null || raw === undefined) return { mapping: empty, errors };
  if (!isObject(raw))
    return { mapping: empty, errors: ["mapping: must be an object"] };
  for (const k of Object.keys(raw))
    if (
      k !== "services" &&
      k !== "external" &&
      k !== "kubernetes" &&
      k !== "places"
    )
      errors.push(`mapping: unknown key "${k}"`);

  const services: MappingService[] = [];
  const ids = new Set<string>();
  const hosts = new Map<string, string>();
  const ips = new Map<string, string>();
  const rawServices = raw.services ?? [];
  if (!Array.isArray(rawServices)) errors.push("services: must be a list");
  else
    rawServices.forEach((s: unknown, i: number) => {
      const p = `services[${i}]`;
      if (!isObject(s)) {
        errors.push(`${p}: must be an object`);
        return;
      }
      for (const k of Object.keys(s))
        if (!SERVICE_KEYS.has(k)) errors.push(`${p}: unknown key "${k}"`);
      const id = s.id;
      if (typeof id !== "string" || !id.trim()) {
        errors.push(`${p}.id: required string`);
        return;
      }
      const at = `services[${id}]`;
      if (ids.has(id)) {
        errors.push(`${at}: duplicate id`);
        return;
      }
      ids.add(id);
      const svc: MappingService = { id, instances: [] };
      for (const k of ["name", "owner", "loadQuery", "process"] as const) {
        const v = s[k];
        if (v === undefined) continue;
        if (typeof v !== "string") errors.push(`${at}.${k}: must be a string`);
        else svc[k] = v;
      }
      if (s.wave !== undefined) {
        if (!Number.isInteger(s.wave) || (s.wave as number) < 0)
          errors.push(`${at}.wave: must be an integer >= 0`);
        else svc.wave = s.wave as number;
      }
      if (s.ha !== undefined) {
        if (!HA_TYPES.includes(s.ha as HaType))
          errors.push(`${at}.ha: must be one of ${HA_TYPES.join(", ")}`);
        else svc.ha = s.ha as HaType;
      }
      if (s.vip !== undefined) {
        if (typeof s.vip !== "string" || !isIp(s.vip))
          errors.push(`${at}.vip: must be an IP address`);
        else {
          svc.vip = s.vip;
          const owner = ips.get(s.vip);
          if (owner)
            errors.push(`${at}.vip: ${s.vip} is already used by ${owner}`);
          else ips.set(s.vip, id);
        }
      }
      if (s.load !== undefined) {
        if (typeof s.load !== "number" || !(s.load >= 0))
          errors.push(`${at}.load: must be a number >= 0 (percent)`);
        else svc.load = s.load;
      }
      const inst = s.instances ?? [];
      if (!Array.isArray(inst)) errors.push(`${at}.instances: must be a list`);
      else
        inst.forEach((x: unknown, j: number) => {
          const ip = `${at}.instances[${j}]`;
          if (!isObject(x)) {
            errors.push(`${ip}: must be an object`);
            return;
          }
          for (const k of Object.keys(x))
            if (!INSTANCE_KEYS.has(k)) errors.push(`${ip}: unknown key "${k}"`);
          if (typeof x.host !== "string" || !x.host.trim()) {
            errors.push(`${ip}.host: required string`);
            return;
          }
          if (typeof x.ip !== "string" || !isIp(x.ip)) {
            errors.push(`${ip}.ip: required IP address`);
            return;
          }
          if (
            x.role !== undefined &&
            x.role !== "primary" &&
            x.role !== "standby" &&
            x.role !== "member"
          ) {
            errors.push(`${ip}.role: must be primary, standby or member`);
            return;
          }
          const hostOwner = hosts.get(x.host);
          if (hostOwner) {
            errors.push(`${ip}.host: ${x.host} is already in ${hostOwner}`);
            return;
          }
          const ipOwner = ips.get(x.ip);
          if (ipOwner) {
            errors.push(`${ip}.ip: ${x.ip} is already used by ${ipOwner}`);
            return;
          }
          hosts.set(x.host, id);
          ips.set(x.ip, id);
          svc.instances.push({
            host: x.host,
            ip: x.ip,
            ...(x.role ? { role: x.role as InstanceRole } : {}),
          });
        });
      if (s.minUp !== undefined) {
        if (!Number.isInteger(s.minUp) || (s.minUp as number) < 1)
          errors.push(`${at}.minUp: must be an integer >= 1`);
        else if ((s.minUp as number) > Math.max(1, svc.instances.length))
          errors.push(
            `${at}.minUp: ${s.minUp} is more than its ${svc.instances.length} instances`,
          );
        else svc.minUp = s.minUp as number;
      }
      const ha = svc.ha ?? "single";
      if (ha !== "single" && svc.instances.length < 2)
        errors.push(`${at}.ha: ${ha} needs at least 2 instances`);
      if (ha === "active-passive") {
        const primaries = svc.instances.filter((x) => x.role === "primary");
        if (primaries.length > 1)
          errors.push(`${at}.instances: only one primary allowed`);
      }
      services.push(svc);
    });

  const external: MappingExternal[] = [];
  const rawExternal = raw.external ?? [];
  if (!Array.isArray(rawExternal)) errors.push("external: must be a list");
  else
    rawExternal.forEach((x: unknown, i: number) => {
      const p = `external[${i}]`;
      if (!isObject(x)) {
        errors.push(`${p}: must be an object`);
        return;
      }
      for (const k of Object.keys(x))
        if (!EXTERNAL_KEYS.has(k)) errors.push(`${p}: unknown key "${k}"`);
      if (typeof x.match !== "string" || !x.match.trim()) {
        errors.push(`${p}.match: required string (IP, CIDR or name)`);
        return;
      }
      const e: MappingExternal = { match: x.match };
      for (const k of ["name", "owner"] as const) {
        const v = x[k];
        if (v === undefined) continue;
        if (typeof v !== "string") errors.push(`${p}.${k}: must be a string`);
        else e[k] = v;
      }
      external.push(e);
    });

  const mapping: Mapping = { services, external };
  if (raw.kubernetes !== undefined) {
    const k = parseKubernetes(raw.kubernetes, ids, ips, errors);
    if (k) mapping.kubernetes = k;
  }
  if (raw.places !== undefined) {
    const pl = parsePlaces(raw.places, errors);
    if (pl) mapping.places = pl;
  }
  return { mapping, errors };
}

const PLACE_KEYS = new Set(["name", "match", "note", "preset", "forwardsTo"]);

function parsePlaces(
  raw: unknown,
  errors: string[],
): MappingPlaces | undefined {
  if (!isObject(raw)) {
    errors.push("places: must be an object");
    return undefined;
  }
  const out: MappingPlaces = {};
  for (const k of Object.keys(raw))
    if (!PLACE_GROUPS.includes(k as PlaceGroup))
      errors.push(`places: unknown key "${k}"`);
  for (const g of PLACE_GROUPS) {
    const list = raw[g];
    if (list === undefined) continue;
    if (!Array.isArray(list)) {
      errors.push(`places.${g}: must be a list`);
      continue;
    }
    const places: MappingPlace[] = [];
    list.forEach((x: unknown, i: number) => {
      const p = `places.${g}[${i}]`;
      if (!isObject(x)) {
        errors.push(`${p}: must be an object`);
        return;
      }
      for (const k of Object.keys(x))
        if (!PLACE_KEYS.has(k)) errors.push(`${p}: unknown key "${k}"`);
      if (typeof x.name !== "string" || !x.name.trim()) {
        errors.push(`${p}.name: required string`);
        return;
      }
      const match = stringList(
        x.match,
        `${p}.match`,
        errors,
        (s) => isIp(s) || isCidr(s),
        "IP addresses or CIDRs",
      );
      if (!match) {
        if (x.match === undefined) errors.push(`${p}.match: required list`);
        return;
      }
      const place: MappingPlace = { name: x.name, match };
      if (x.note !== undefined) {
        if (typeof x.note !== "string")
          errors.push(`${p}.note: must be a string`);
        else place.note = x.note;
      }
      if (x.preset !== undefined) {
        if (g !== "storage" || x.preset !== "ceph")
          errors.push(`${p}.preset: only "ceph", on storage`);
        else place.preset = "ceph";
      }
      if (x.forwardsTo !== undefined) {
        const to = stringList(x.forwardsTo, `${p}.forwardsTo`, errors);
        if (to && g !== "loadBalancers")
          errors.push(`${p}.forwardsTo: only on loadBalancers`);
        else if (to) place.forwardsTo = to;
      }
      places.push(place);
    });
    out[g] = places;
  }
  return out;
}

function stringList(
  v: unknown,
  path: string,
  errors: string[],
  check?: (s: string) => boolean,
  what = "strings",
): string[] | undefined {
  if (v === undefined) return undefined;
  if (
    !Array.isArray(v) ||
    v.some((x) => typeof x !== "string" || (check && !check(x)))
  ) {
    errors.push(`${path}: must be a list of ${what}`);
    return undefined;
  }
  return v as string[];
}

function parseKubernetes(
  raw: unknown,
  ids: Set<string>,
  ips: Map<string, string>,
  errors: string[],
): MappingKubernetes | undefined {
  if (!isObject(raw)) {
    errors.push("kubernetes: must be an object");
    return undefined;
  }
  for (const k of Object.keys(raw))
    if (!KUBERNETES_KEYS.has(k)) errors.push(`kubernetes: unknown key "${k}"`);
  const clusters: MappingCluster[] = [];
  const rawClusters = raw.clusters ?? [];
  if (!Array.isArray(rawClusters))
    errors.push("kubernetes.clusters: must be a list");
  else
    rawClusters.forEach((c: unknown, i: number) => {
      const p = `kubernetes.clusters[${i}]`;
      if (!isObject(c)) {
        errors.push(`${p}: must be an object`);
        return;
      }
      for (const k of Object.keys(c))
        if (!CLUSTER_KEYS.has(k)) errors.push(`${p}: unknown key "${k}"`);
      if (typeof c.name !== "string" || !c.name.trim()) {
        errors.push(`${p}.name: required string`);
        return;
      }
      const at = `kubernetes.clusters[${c.name}]`;
      if (clusters.some((x) => x.name === c.name)) {
        errors.push(`${at}: duplicate name`);
        return;
      }
      const cluster: MappingCluster = { name: c.name, nodes: [] };
      const rawNodes = c.nodes ?? [];
      if (!Array.isArray(rawNodes)) errors.push(`${at}.nodes: must be a list`);
      else
        rawNodes.forEach((n: unknown, j: number) => {
          const np = `${at}.nodes[${j}]`;
          if (!isObject(n)) {
            errors.push(`${np}: must be an object`);
            return;
          }
          for (const k of Object.keys(n))
            if (!NODE_KEYS.has(k)) errors.push(`${np}: unknown key "${k}"`);
          if (typeof n.name !== "string" || !n.name.trim()) {
            errors.push(`${np}.name: required string`);
            return;
          }
          if (typeof n.ip !== "string" || !isIp(n.ip)) {
            errors.push(`${np}.ip: required IP address`);
            return;
          }
          const node: MappingNode = { name: n.name, ip: n.ip };
          const addresses = stringList(
            n.addresses,
            `${np}.addresses`,
            errors,
            isIp,
            "IP addresses",
          );
          if (addresses) node.addresses = addresses;
          for (const a of [n.ip, ...(addresses ?? [])]) {
            const owner = ips.get(a);
            if (owner) errors.push(`${np}: ${a} is already used by ${owner}`);
            else ips.set(a, `node ${n.name}`);
          }
          cluster.nodes.push(node);
        });
      const egress = stringList(
        c.egressIps,
        `${at}.egressIps`,
        errors,
        isIp,
        "IP addresses",
      );
      if (egress) cluster.egressIps = egress;
      const hide = stringList(c.hideNamespaces, `${at}.hideNamespaces`, errors);
      if (hide) cluster.hideNamespaces = hide;
      clusters.push(cluster);
    });

  const services: MappingWorkload[] = [];
  const rawServices = raw.services ?? [];
  if (!Array.isArray(rawServices))
    errors.push("kubernetes.services: must be a list");
  else
    rawServices.forEach((s: unknown, i: number) => {
      const p = `kubernetes.services[${i}]`;
      if (!isObject(s)) {
        errors.push(`${p}: must be an object`);
        return;
      }
      for (const k of Object.keys(s))
        if (!WORKLOAD_KEYS.has(k)) errors.push(`${p}: unknown key "${k}"`);
      if (typeof s.id !== "string" || !s.id.trim()) {
        errors.push(`${p}.id: required string`);
        return;
      }
      const at = `kubernetes.services[${s.id}]`;
      if (ids.has(s.id)) {
        errors.push(`${at}: duplicate id`);
        return;
      }
      if (typeof s.namespace !== "string" || !s.namespace.trim()) {
        errors.push(`${at}.namespace: required string`);
        return;
      }
      ids.add(s.id);
      const w: MappingWorkload = { id: s.id, namespace: s.namespace };
      for (const k of [
        "name",
        "owner",
        "cluster",
        "workload",
        "loadQuery",
        "process",
      ] as const) {
        const v = s[k];
        if (v === undefined) continue;
        if (typeof v !== "string") errors.push(`${at}.${k}: must be a string`);
        else w[k] = v;
      }
      if (
        w.cluster !== undefined &&
        !clusters.some((c) => c.name === w.cluster)
      )
        errors.push(
          `${at}.cluster: ${w.cluster} is not in kubernetes.clusters`,
        );
      if (w.cluster === undefined && clusters.length > 1)
        errors.push(
          `${at}.cluster: required when there is more than one cluster`,
        );
      const names = stringList(s.services, `${at}.services`, errors);
      if (names) w.services = names;
      if (s.replicas !== undefined) {
        if (!Number.isInteger(s.replicas) || (s.replicas as number) < 1)
          errors.push(`${at}.replicas: must be an integer >= 1`);
        else w.replicas = s.replicas as number;
      }
      if (s.ha !== undefined) {
        if (!HA_TYPES.includes(s.ha as HaType))
          errors.push(`${at}.ha: must be one of ${HA_TYPES.join(", ")}`);
        else w.ha = s.ha as HaType;
      }
      if (s.minUp !== undefined) {
        if (!Number.isInteger(s.minUp) || (s.minUp as number) < 1)
          errors.push(`${at}.minUp: must be an integer >= 1`);
        else if (w.replicas !== undefined && (s.minUp as number) > w.replicas)
          errors.push(
            `${at}.minUp: ${s.minUp} is more than its ${w.replicas} replicas`,
          );
        else w.minUp = s.minUp as number;
      }
      if (s.nodePorts !== undefined) {
        if (
          !Array.isArray(s.nodePorts) ||
          s.nodePorts.some((n) => !Number.isInteger(n) || n < 1 || n > 65535)
        )
          errors.push(`${at}.nodePorts: must be a list of ports`);
        else w.nodePorts = s.nodePorts as number[];
      }
      if (s.loadBalancerIp !== undefined) {
        if (typeof s.loadBalancerIp !== "string" || !isIp(s.loadBalancerIp))
          errors.push(`${at}.loadBalancerIp: must be an IP address`);
        else {
          const owner = ips.get(s.loadBalancerIp);
          if (owner)
            errors.push(
              `${at}.loadBalancerIp: ${s.loadBalancerIp} is already used by ${owner}`,
            );
          else {
            ips.set(s.loadBalancerIp, s.id);
            w.loadBalancerIp = s.loadBalancerIp;
          }
        }
      }
      if (s.load !== undefined) {
        if (typeof s.load !== "number" || !(s.load >= 0))
          errors.push(`${at}.load: must be a number >= 0 (percent)`);
        else w.load = s.load;
      }
      const ha = w.ha ?? ((w.replicas ?? 1) > 1 ? "active-active" : "single");
      if (ha !== "single" && w.replicas !== undefined && w.replicas < 2)
        errors.push(`${at}.ha: ${ha} needs replicas >= 2`);
      services.push(w);
    });
  return { clusters, services };
}

/**
 * The mapping text with changed waves written back, keeping comments and layout. Services whose wave
 * did not change are left alone.
 */
export function updateWaves(
  text: string,
  waves: Record<string, number>,
): string {
  const doc = parseDocument(text);
  const services = doc.get("services");
  if (!isSeq(services)) return text;
  services.items.forEach((item) => {
    if (!isMap(item)) return;
    const id = item.get("id");
    if (typeof id !== "string" || !(id in waves)) return;
    item.set("wave", waves[id]);
  });
  return doc.toString();
}

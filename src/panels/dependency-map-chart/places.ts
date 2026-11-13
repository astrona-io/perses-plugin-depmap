import { Mapping, MappingPlace, PlaceGroup } from "./mapping";
import { cidrContains } from "./model";

/**
 * Places of the estate view: groups of addresses that are not compute the collectors see from inside
 * (load balancers, storage, LANs, internet providers), plus the built-in places every estate has.
 * Pure: no React.
 */

export type PlaceKind =
  | "lb"
  | "storage"
  | "lan"
  | "internet"
  /** Callers outside every cluster and server that are never called themselves. */
  | "clients"
  /** Services in the mapping that are not Kubernetes workloads: VMs, bare metal. */
  | "servers"
  /** Kubernetes Service addresses (ClusterIP) of one cluster, before kube-proxy picks a pod. */
  | "services"
  /** Pods of one cluster whose node is not known. */
  | "unplaced"
  /** Private addresses in no place. */
  | "private";

export interface Place {
  id: string;
  kind: PlaceKind;
  name: string;
  note?: string;
  match: string[];
  preset?: "ceph";
  forwardsTo?: string[];
  /** services and unplaced: the cluster they belong to. */
  cluster?: string;
}

/**
 * Published ranges of common providers, used when the mapping has no `places.internet`. Editable: the
 * settings editor copies them into the mapping. Lists change; check the providers' own pages.
 */
export const DEFAULT_INTERNET_PROVIDERS: MappingPlace[] = [
  {
    name: "GitHub",
    match: [
      "140.82.112.0/20",
      "185.199.108.0/22",
      "192.30.252.0/22",
      "143.55.64.0/20",
    ],
  },
  {
    name: "Cloudflare",
    match: [
      "104.16.0.0/13",
      "104.24.0.0/14",
      "172.64.0.0/13",
      "162.158.0.0/15",
      "173.245.48.0/20",
      "103.21.244.0/22",
      "103.22.200.0/22",
      "103.31.4.0/22",
      "141.101.64.0/18",
      "108.162.192.0/18",
      "190.93.240.0/20",
      "188.114.96.0/20",
      "197.234.240.0/22",
      "198.41.128.0/17",
      "131.0.72.0/22",
    ],
  },
  {
    name: "Google",
    match: [
      "8.8.8.0/24",
      "8.8.4.0/24",
      "142.250.0.0/15",
      "172.217.0.0/16",
      "216.58.192.0/19",
      "172.253.0.0/16",
      "74.125.0.0/16",
      "64.233.160.0/19",
      "209.85.128.0/17",
    ],
  },
  { name: "Fastly", match: ["151.101.0.0/16", "199.232.0.0/16"] },
  { name: "Quad9", match: ["9.9.9.0/24"] },
];

export const CLIENTS_ID = "clients";
export const SERVERS_ID = "servers";
export const PRIVATE_ID = "private";
/** Internet addresses in no provider's ranges. */
export const OTHER_INTERNET_ID = "inet:*";

const KIND_OF: Record<PlaceGroup, PlaceKind> = {
  loadBalancers: "lb",
  storage: "storage",
  lan: "lan",
  internet: "internet",
};
const PREFIX: Record<PlaceKind, string> = {
  lb: "lb:",
  storage: "storage:",
  lan: "lan:",
  internet: "inet:",
  clients: "",
  servers: "",
  services: "svc:",
  unplaced: "unplaced:",
  private: "",
};

/** Places from the mapping, in match priority: load balancers, storage, LANs, internet providers. */
export function mappedPlaces(mapping: Mapping): Place[] {
  const p = mapping.places ?? {};
  const groups: Array<[PlaceGroup, MappingPlace[]]> = [
    ["loadBalancers", p.loadBalancers ?? []],
    ["storage", p.storage ?? []],
    ["lan", p.lan ?? []],
    ["internet", p.internet ?? DEFAULT_INTERNET_PROVIDERS],
  ];
  return groups.flatMap(([g, list]) =>
    list.map((x) => ({
      id: PREFIX[KIND_OF[g]] + x.name,
      kind: KIND_OF[g],
      name: x.name,
      note: x.note,
      match: x.match,
      preset: x.preset,
      forwardsTo: x.forwardsTo,
    })),
  );
}

export function builtinPlace(id: string): Place | undefined {
  if (id === CLIENTS_ID)
    return { id, kind: "clients", name: "Clients", match: [] };
  if (id === SERVERS_ID)
    return { id, kind: "servers", name: "Servers", match: [] };
  if (id === PRIVATE_ID)
    return { id, kind: "private", name: "Other private addresses", match: [] };
  if (id === OTHER_INTERNET_ID)
    return {
      id,
      kind: "internet",
      name: "Other internet addresses",
      match: [],
    };
  if (id.startsWith("svc:"))
    return {
      id,
      kind: "services",
      name: "Cluster services",
      cluster: id.slice(4),
      match: [],
    };
  if (id.startsWith("unplaced:"))
    return {
      id,
      kind: "unplaced",
      name: "Node not known",
      cluster: id.slice(9),
      match: [],
    };
  return undefined;
}

/** The first place whose addresses or ranges hold the IP. */
export function placeOfIp(places: Place[], ip: string): Place | undefined {
  return places.find((p) =>
    p.match.some((m) => (m.includes("/") ? cidrContains(m, ip) : m === ip)),
  );
}

/** RFC 1918, loopback, link-local, CGNAT and IPv6 unique-local / link-local addresses. */
export function isPrivateIp(ip: string): boolean {
  if (ip.includes(":")) {
    const l = ip.toLowerCase();
    return (
      l === "::1" ||
      l.startsWith("fc") ||
      l.startsWith("fd") ||
      l.startsWith("fe80")
    );
  }
  return [
    "10.0.0.0/8",
    "172.16.0.0/12",
    "192.168.0.0/16",
    "127.0.0.0/8",
    "169.254.0.0/16",
    "100.64.0.0/10",
  ].some((c) => cidrContains(c, ip));
}

/** Ceph's port roles: monitors on 3300 and 6789; OSDs and managers share 6800-7300. */
export function cephRole(port: number): string {
  if (port === 6789 || port === 3300) return "mon";
  if (port >= 6800 && port <= 7300) return "OSD / mgr";
  return "other";
}

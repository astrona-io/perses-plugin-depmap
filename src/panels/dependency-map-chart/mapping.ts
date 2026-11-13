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

export interface Mapping {
  services: MappingService[];
  external: MappingExternal[];
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
    if (k !== "services" && k !== "external")
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

  return { mapping: { services, external }, errors };
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

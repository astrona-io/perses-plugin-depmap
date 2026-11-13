import { EdgeSample } from "./model";

/** Range queries run at one-hour steps: frequency is "in how many hours of the window was it seen". */
export const STEP_SECONDS = 3600;
/** Longest window the panel queries (Prometheus caps a range query at 11,000 points per series). */
export const MAX_WINDOW_SECONDS = 365 * 24 * 3600;

const UNITS: Record<string, number> = {
  ms: 0.001,
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
  w: 7 * 86400,
  y: 365 * 86400,
};

/** Prometheus-style duration (`30d`, `1w2d`, `90m`) in seconds; undefined when it does not parse. */
export function parseDuration(text: string): number | undefined {
  const s = text.trim();
  if (!s) return undefined;
  const re = /(\d+(?:\.\d+)?)(ms|s|m|h|d|w|y)/g;
  let total = 0;
  let consumed = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (m.index !== consumed) return undefined;
    total += Number(m[1]) * UNITS[m[2]!]!;
    consumed = m.index + m[0].length;
  }
  if (consumed !== s.length || total <= 0) return undefined;
  return total;
}

export interface MatrixSeries {
  metric: Record<string, string>;
  values: Array<[number, string]>;
}

/**
 * One sample per series. Labels are read so both collectors fit the same code:
 * - OBI: `src_address`, `dst_address`, `server_port` (or `dst_port`), `dst_name`; the value is bytes.
 * - Fallback script: `src_ip`, `dst_ip`, `dst_port`, `src_process`, `direction`. Its value is 1 while a
 *   connection exists. On `direction="in"` the script saw an inbound connection: `dst_ip` is the remote
 *   client and `dst_port` the local listening port, so caller and callee are swapped.
 */
export function seriesToSamples(
  series: MatrixSeries[],
  valueIsBytes: boolean,
): EdgeSample[] {
  const out: EdgeSample[] = [];
  for (const s of series) {
    const m = s.metric;
    let src = m.src_address ?? m.src_ip ?? "";
    let dst = m.dst_address ?? m.dst_ip ?? "";
    const port = Number(m.server_port ?? m.dst_port);
    if (m.direction === "in") [src, dst] = [dst, src];
    if (!src || !dst || !Number.isFinite(port) || port <= 0) continue;
    const hours = new Set<number>();
    let bytes = 0;
    let lastSeen = 0;
    for (const [ts, raw] of s.values) {
      const v = Number(raw);
      if (!(v > 0)) continue;
      hours.add(Math.floor(ts / STEP_SECONDS));
      bytes += v;
      lastSeen = Math.max(lastSeen, ts);
    }
    if (hours.size === 0) continue;
    out.push({
      src,
      dst,
      port,
      srcProcess: m.direction === "in" ? undefined : m.src_process || undefined,
      dstName: m.dst_name || undefined,
      hours: [...hours],
      bytes: valueIsBytes ? bytes : undefined,
      lastSeen,
    });
  }
  return out;
}

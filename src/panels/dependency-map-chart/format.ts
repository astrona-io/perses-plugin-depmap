import { Frequency, RateUnit } from "./dependency-map-chart-types";

function trim(n: number, digits: number): string {
  const s = n.toFixed(digits);
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

export function formatBytes(v: number | undefined): string {
  if (v === undefined || !Number.isFinite(v)) return "–";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = v;
  let i = 0;
  while (n >= 1000 && i < units.length - 1) {
    n /= 1000;
    i++;
  }
  return `${trim(n, n >= 100 ? 0 : 1)} ${units[i]}`;
}

const PER: Record<Exclude<RateUnit, "auto">, number> = {
  s: 1,
  min: 60,
  h: 3600,
};

/**
 * A rate in bytes per second, shown per second, minute or hour. `auto` picks the largest unit in which
 * the value is at least 1 kB, so small flows do not read as "0 B/s".
 */
export function formatRate(
  bytesPerSecond: number | undefined,
  unit: RateUnit = "s",
): string {
  if (bytesPerSecond === undefined || !Number.isFinite(bytesPerSecond))
    return "–";
  const per =
    unit !== "auto"
      ? unit
      : bytesPerSecond >= 1e3
        ? "s"
        : bytesPerSecond * 60 >= 1e3
          ? "min"
          : "h";
  if (bytesPerSecond <= 0) return `0 B/${per}`;
  let v = bytesPerSecond * PER[per];
  const units = ["B", "kB", "MB", "GB", "TB"];
  let i = 0;
  while (v >= 1e3 && i < units.length - 1) {
    v /= 1e3;
    i++;
  }
  const shown =
    v >= 100
      ? Math.round(v)
      : Number(v.toPrecision(v < 1 ? 1 : v < 10 ? 2 : 3));
  return `${shown} ${units[i]}/${per}`;
}

export function formatAgo(unixSeconds: number, nowSeconds: number): string {
  if (!unixSeconds) return "never";
  const d = Math.max(0, nowSeconds - unixSeconds);
  if (d < 3600) return "in the last hour";
  if (d < 86400) return `${Math.round(d / 3600)} h ago`;
  return `${Math.round(d / 86400)} d ago`;
}

export const FREQUENCY_LABELS: Record<Frequency, string> = {
  constantly: "Constantly",
  hourly: "Hourly",
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly / rare",
};

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** `${name}` placeholders filled from vars, each value URL-encoded. Unknown names are left empty. */
export function fillTemplate(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\$\{(\w+)\}/g, (_, k: string) =>
    encodeURIComponent(vars[k] ?? ""),
  );
}

/** Only http(s) and relative links are rendered. */
export function safeHref(url: string): string | undefined {
  const u = url.trim();
  if (
    /^(https?:)?\/\//i.test(u) ||
    u.startsWith("/") ||
    u.startsWith("?") ||
    u.startsWith("#")
  )
    return u;
  return undefined;
}

import { Frequency } from "./dependency-map-chart-types";

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

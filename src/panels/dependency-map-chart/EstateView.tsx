import {
  ReactElement,
  ReactNode,
  RefObject,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Autocomplete,
  Box,
  Button,
  ButtonBase,
  Chip,
  Link,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
  alpha,
  useTheme,
} from "@mui/material";
import { Mode, RateUnit, ResolvedOptions } from "./dependency-map-chart-types";
import {
  Estate,
  Hop,
  Link as EstateLink,
  Machine,
  Neighbour,
  blastRadius,
  closure,
  depGraph,
  depKey,
  estateGroup,
  isMonitoring,
  linksOf,
  monitoringRegex,
} from "./estate";
import {
  firewallRulesForCluster,
  firewallRulesForWave,
  formatRules,
  wavesOf,
} from "./firewall";
import { fillTemplate, formatRate, safeHref } from "./format";
import { DepEdge, DepModel } from "./model";
import {
  Effect,
  Outage,
  OutageInput,
  OutageSummary,
  addrUnit,
  chainOf,
  isUnit,
  outageScore,
  rankUnits,
  simulate,
  storageHosts,
  summarize,
  summaryParts,
} from "./outage";
import {
  CLIENTS_ID,
  OTHER_INTERNET_ID,
  PRIVATE_ID,
  Place,
  SERVERS_ID,
  cephRole,
} from "./places";

/**
 * The map mode's estate view: a drill-down from the whole estate to clusters, machines, namespaces and
 * workloads, a page per place (load balancer, storage, LAN, internet provider), and the dependencies
 * of anything on it. In outage mode ("If unreachable") the same estate becomes a board of units to
 * mark as down, with what that does beside it. Navigation and the outage live here, in the panel;
 * nothing is written to the URL.
 *
 * Navigation targets are strings: "estate", "cluster:<name>", a machine id ("m:<cluster>/<node>"),
 * "place:<place id>", "internet" (all providers) and "deps:<node or place id>".
 */

export interface EstateViewProps {
  model: DepModel;
  estate: Estate;
  /** Edges after the frequency filter. */
  edges: DepEdge[];
  o: ResolvedOptions;
  rateUnit: RateUnit;
  width: number;
  height: number;
  panelOpen: boolean;
  narrow: boolean;
  panelW: number;
  mode: Mode;
  onMode: (mode: Mode) => void;
}

const CRUMBS_H = 40;
const CHIP_W = 136;
const CHIPS_SHOWN = 8;

type IconType =
  | "pod"
  | "node"
  | "storage"
  | "internet"
  | "lan"
  | "svc"
  | "lb"
  | "clients"
  | "server";

const ICON_PATHS: Record<IconType, ReactNode> = {
  pod: <path d="M12 2.5l8.5 4.9v9.2L12 21.5l-8.5-4.9V7.4z" />,
  node: (
    <>
      <rect x="3" y="4" width="18" height="7" rx="1.5" />
      <rect x="3" y="13" width="18" height="7" rx="1.5" />
    </>
  ),
  server: (
    <>
      <rect x="4" y="3" width="16" height="18" rx="1.5" />
      <path d="M8 8h8M8 12h8" />
    </>
  ),
  storage: (
    <>
      <ellipse cx="12" cy="5.5" rx="8" ry="3" />
      <path d="M4 5.5v13c0 1.7 3.6 3 8 3s8-1.3 8-3v-13M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
    </>
  ),
  internet: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18" />
    </>
  ),
  lan: (
    <>
      <rect x="9" y="2.5" width="6" height="5" />
      <rect x="2.5" y="16.5" width="6" height="5" />
      <rect x="15.5" y="16.5" width="6" height="5" />
      <path d="M12 7.5v5M5.5 16.5v-4h13v4" />
    </>
  ),
  svc: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="3" fill="currentColor" />
    </>
  ),
  lb: <path d="M3 12h6m0 0l9-7m-9 7h12m-12 0l9 7" />,
  clients: (
    <path d="M9 4.5a3.5 3.5 0 1 1 0 7a3.5 3.5 0 1 1 0-7M2.5 20c.5-3.5 3-5.5 6.5-5.5s6 2 6.5 5.5M16 4.5a3.5 3.5 0 0 1 0 7M18 14.8c2 .7 3.2 2.5 3.5 5.2" />
  ),
};

function Icon({ type }: { type: IconType }): ReactElement {
  return (
    <Box
      component="svg"
      viewBox="0 0 24 24"
      aria-hidden
      sx={{
        width: 14,
        height: 14,
        flexShrink: 0,
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 2,
        color:
          type === "storage"
            ? "secondary.main"
            : ["internet", "lan", "clients", "lb"].includes(type)
              ? "warning.main"
              : "primary.main",
      }}
    >
      {ICON_PATHS[type]}
    </Box>
  );
}

function ClusterIcon(): ReactElement {
  return (
    <Box
      component="svg"
      viewBox="0 0 24 24"
      aria-hidden
      sx={{
        width: 18,
        height: 18,
        flexShrink: 0,
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 1.8,
        color: "primary.main",
      }}
    >
      <circle cx="12" cy="12" r="9.5" />
      <circle cx="12" cy="12" r="2.6" />
      {[0, 51.4, 102.8, 154.3, 205.7, 257.1, 308.6].map((a) => (
        <line
          key={a}
          x1="12"
          y1="9.4"
          x2="12"
          y2="3.5"
          transform={`rotate(${a} 12 12)`}
        />
      ))}
    </Box>
  );
}

/** One line of text that never overflows: cut with an ellipsis, the full text in a tooltip. */
function Ellipsis({
  text,
  variant = "body2",
  color,
  weight,
  tip,
}: {
  text: string;
  variant?: "body2" | "caption" | "subtitle2";
  color?: string;
  weight?: number;
  tip?: string;
}): ReactElement {
  return (
    <Tooltip title={tip ?? text} disableInteractive enterDelay={400}>
      <Typography
        variant={variant}
        noWrap
        component="span"
        sx={{ display: "block", minWidth: 0, color, fontWeight: weight }}
      >
        {text}
      </Typography>
    </Tooltip>
  );
}

const sum = (xs: Array<number | undefined>): number =>
  xs.reduce<number>((n, x) => n + (x ?? 0), 0);

/** What the views need to draw and link one id: a service, a place, a machine or a cluster. */
interface Info {
  type: IconType;
  name: string;
  sub: string;
  go?: string;
}

/** Workload names in a namespace often share a prefix; drop it (or "<namespace>-") for the chip. */
function sharedPrefix(names: string[]): string {
  if (names.length < 3) return "";
  const parts = names.map((n) => n.split("-"));
  const first = parts[0] ?? [];
  const out: string[] = [];
  for (let i = 0; ; i++) {
    const w = first[i];
    if (w === undefined || parts.some((a) => a[i] !== w || a.length <= i + 1))
      break;
    out.push(w);
  }
  return out.length ? out.join("-") + "-" : "";
}
/**
 * Names without the dash-separated prefix they all share ("prod-worker-1", "prod-worker-2" become
 * "worker-1", "worker-2"), so a cut name still shows the part that differs. Unchanged for one name.
 */
function dropCommonPrefix(names: string[]): Map<string, string> {
  const out = new Map(names.map((n) => [n, n]));
  if (names.length < 2) return out;
  const parts = names.map((n) => n.split("-"));
  let k = 0;
  while (parts.every((p) => p.length > k + 1 && p[k] === parts[0]?.[k])) k++;
  if (k > 0)
    for (const [i, n] of names.entries())
      out.set(n, (parts[i] ?? []).slice(k).join("-"));
  return out;
}

function shortName(name: string, ns: string, prefix: string): string {
  let s = name;
  if (prefix && s.startsWith(prefix)) s = s.slice(prefix.length);
  else if (ns && s.startsWith(ns + "-")) s = s.slice(ns.length + 1);
  return s || name;
}

interface DrawLink {
  a: string;
  b: string;
  bps: number;
  measured: boolean;
  kind: "in" | "store" | "out";
  dashed?: boolean;
}

/**
 * Lines between the cards of a view, drawn over them in an SVG. Card boxes are measured after layout
 * (elements carrying `data-loc`) and again when the container resizes.
 */
function EdgeLayer({
  container,
  links,
  hovered,
  arrows,
}: {
  container: RefObject<HTMLDivElement>;
  links: DrawLink[];
  hovered?: string;
  arrows: boolean;
}): ReactElement {
  const theme = useTheme();
  const [paths, setPaths] = useState<
    Array<{ d: string; l: DrawLink; w: number }>
  >([]);
  useLayoutEffect(() => {
    const el = container.current;
    if (!el) return;
    const draw = (): void => {
      const R = el.getBoundingClientRect();
      const boxes = new Map<
        string,
        { x: number; y: number; l: number; r: number; t: number; b: number }
      >();
      el.querySelectorAll<HTMLElement>("[data-loc]").forEach((c) => {
        const r = c.getBoundingClientRect();
        boxes.set(c.dataset.loc ?? "", {
          x: r.left - R.left + r.width / 2,
          y: r.top - R.top + r.height / 2,
          l: r.left - R.left,
          r: r.right - R.left,
          t: r.top - R.top,
          b: r.bottom - R.top,
        });
      });
      const max = Math.max(1, ...links.map((l) => l.bps));
      const out: Array<{ d: string; l: DrawLink; w: number }> = [];
      for (const l of links) {
        const A = boxes.get(l.a);
        const C = boxes.get(l.b);
        if (!A || !C) continue;
        let d: string;
        if (C.l >= A.r - 2) {
          const x1 = A.r + 2;
          const x2 = C.l - 4;
          const mx = (x1 + x2) / 2;
          d = `M${x1},${A.y} C${mx},${A.y} ${mx},${C.y} ${x2},${C.y}`;
        } else if (A.l >= C.r - 2) {
          const x1 = A.l - 2;
          const x2 = C.r + 4;
          const mx = (x1 + x2) / 2;
          d = `M${x1},${A.y} C${mx},${A.y} ${mx},${C.y} ${x2},${C.y}`;
        } else if (Math.abs(A.y - C.y) < 4) {
          const y = A.t - 2;
          const lift = Math.min(26, 8 + Math.abs(A.x - C.x) * 0.05);
          d = `M${A.x},${y} C${A.x},${y - lift} ${C.x},${y - lift} ${C.x},${y}`;
        } else {
          const [U, L] = A.y < C.y ? [A, C] : [C, A];
          const my = (U.b + L.t) / 2;
          d = `M${U.x},${U.b} C${U.x},${my} ${L.x},${my} ${L.x},${L.t}`;
        }
        out.push({
          d,
          l,
          w: l.measured && l.bps > 0 ? 1 + 7 * Math.sqrt(l.bps / max) : 1.5,
        });
      }
      setPaths(out);
    };
    draw();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(draw);
    ro.observe(el);
    return () => ro.disconnect();
  }, [container, links]);
  const color = {
    in: theme.palette.primary.main,
    store: theme.palette.secondary.main,
    out: theme.palette.warning.main,
  };
  return (
    <Box
      component="svg"
      aria-hidden
      sx={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        overflow: "visible",
        pointerEvents: "none",
        zIndex: 0,
      }}
    >
      <defs>
        <marker
          id="depmap-arrow"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerUnits="userSpaceOnUse"
          markerWidth="9"
          markerHeight="9"
          orient="auto-start-reverse"
        >
          <path d="M0 0L10 5L0 10z" fill="context-stroke" />
        </marker>
      </defs>
      {paths.map(({ d, l, w }) => {
        const hit = !hovered || l.a === hovered || l.b === hovered;
        return (
          <path
            key={`${l.a}>${l.b}`}
            d={d}
            fill="none"
            stroke={color[l.kind]}
            strokeWidth={w.toFixed(1)}
            strokeOpacity={hit ? (l.dashed ? 0.8 : 0.5) : 0.08}
            strokeLinecap="round"
            strokeDasharray={l.dashed ? "5 5" : undefined}
            markerEnd={arrows ? "url(#depmap-arrow)" : undefined}
          />
        );
      })}
    </Box>
  );
}

function Legend({ children }: { children: ReactNode }): ReactElement {
  return (
    <Box
      sx={{
        display: "flex",
        flexWrap: "wrap",
        gap: 2,
        mt: 2,
        color: "text.secondary",
        fontSize: 12,
        alignItems: "center",
      }}
    >
      {children}
    </Box>
  );
}

function Swatch({
  kind,
  label,
  dashed,
}: {
  kind: DrawLink["kind"];
  label: string;
  dashed?: boolean;
}): ReactElement {
  const color = {
    in: "primary.main",
    store: "secondary.main",
    out: "warning.main",
  }[kind];
  return (
    <Box
      component="span"
      sx={{ display: "inline-flex", alignItems: "center", gap: 0.75 }}
    >
      <Box
        component="span"
        sx={{
          width: 22,
          borderTop: 3,
          borderColor: color,
          borderTopStyle: dashed ? "dashed" : "solid",
        }}
      />
      {label}
    </Box>
  );
}

/** A box on the estate or cluster map; `loc` ties it to the lines drawn between boxes. */
function Card({
  loc,
  icon,
  name,
  sub,
  onClick,
  onHover,
  active,
  children,
  dashed,
  minWidth = 150,
  tip,
  tone,
  label,
  pressed,
}: {
  loc: string;
  icon?: IconType;
  name: string;
  /** Tooltip of the name when it is not the whole name. */
  tip?: string;
  sub?: string;
  onClick: () => void;
  onHover: (loc: string | undefined) => void;
  active?: boolean;
  children?: ReactNode;
  dashed?: boolean;
  minWidth?: number;
  /** Outage mode: down, hit (stops or loses a dependency), warn (less headroom), dim (unaffected). */
  tone?: Tone;
  /** Accessible name; default "Open <name>". */
  label?: string;
  /** Set for toggles. */
  pressed?: boolean;
}): ReactElement {
  return (
    <ButtonBase
      data-loc={loc}
      onClick={onClick}
      onMouseEnter={() => onHover(loc)}
      onMouseLeave={() => onHover(undefined)}
      onFocus={() => onHover(loc)}
      onBlur={() => onHover(undefined)}
      aria-label={label ?? `Open ${name}`}
      aria-pressed={pressed}
      sx={{
        position: "relative",
        zIndex: 1,
        display: "flex",
        flexDirection: "column",
        alignItems: "stretch",
        textAlign: "left",
        gap: 0.25,
        minWidth,
        maxWidth: "100%",
        p: 1,
        borderRadius: 1,
        border: 1,
        borderStyle: dashed ? "dashed" : "solid",
        borderColor: active
          ? "primary.main"
          : tone === "down" || tone === "hit"
            ? "error.main"
            : tone === "warn"
              ? "warning.main"
              : "divider",
        borderWidth: tone === "down" ? 2 : 1,
        bgcolor: (t) =>
          tone === "down"
            ? alpha(t.palette.error.main, 0.16)
            : tone === "hit"
              ? alpha(t.palette.error.main, 0.06)
              : tone === "warn"
                ? alpha(t.palette.warning.main, 0.08)
                : t.palette.background.paper,
        opacity: tone === "dim" ? 0.6 : 1,
        "&:hover, &.Mui-focusVisible": {
          borderColor: "primary.main",
          opacity: 1,
        },
      }}
    >
      <Box
        sx={{ display: "flex", alignItems: "center", gap: 0.75, minWidth: 0 }}
      >
        {icon ? <Icon type={icon} /> : null}
        <Ellipsis text={name} tip={tip} weight={600} />
      </Box>
      {sub ? (
        <Ellipsis text={sub} variant="caption" color="text.secondary" />
      ) : null}
      {children}
    </ButtonBase>
  );
}

type Tone = "down" | "hit" | "warn" | "dim";

function Heading({ children }: { children: string }): ReactElement {
  return (
    <Typography
      variant="caption"
      component="h4"
      sx={{
        display: "block",
        mt: 1.5,
        mb: 0.5,
        fontWeight: 600,
        letterSpacing: 0.4,
        color: "text.secondary",
        textTransform: "uppercase",
      }}
    >
      {children}
    </Typography>
  );
}

function Kv({ rows }: { rows: Array<[string, ReactNode]> }): ReactElement {
  return (
    <Box
      component="dl"
      sx={{
        display: "grid",
        gridTemplateColumns: "minmax(0,1fr) auto",
        columnGap: 1.5,
        rowGap: 0.25,
        m: 0,
        fontSize: 13,
        "& dt": { color: "text.secondary", minWidth: 0 },
        "& dd": {
          m: 0,
          textAlign: "right",
          fontVariantNumeric: "tabular-nums",
        },
      }}
    >
      {rows.map(([k, v]) => (
        <Box key={k} sx={{ display: "contents" }}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </Box>
      ))}
    </Box>
  );
}

function Note({ children }: { children: ReactNode }): ReactElement {
  return (
    <Typography
      variant="caption"
      component="p"
      color="text.secondary"
      sx={{ my: 0.75 }}
    >
      {children}
    </Typography>
  );
}

function Empty({ children }: { children: string }): ReactElement {
  return (
    <Typography variant="body2" color="text.secondary" sx={{ py: 0.5 }}>
      {children}
    </Typography>
  );
}

/** A row in a list: icon and name on the left, rate on the right, a second line below. */
function Row({
  icon,
  name,
  rate,
  meta,
  onClick,
  tip,
  tone,
}: {
  icon?: IconType;
  name: string;
  rate?: string;
  meta?: string;
  onClick?: () => void;
  tip?: string;
  /** Outage mode: a coloured edge on the left; "via" is dashed. */
  tone?: "bad" | "via" | "warn";
}): ReactElement {
  return (
    <ButtonBase
      onClick={onClick}
      disabled={!onClick}
      sx={{
        ...(tone
          ? {
              borderLeft: 3,
              borderLeftStyle: tone === "via" ? "dashed" : "solid",
              borderLeftColor: tone === "warn" ? "warning.main" : "error.main",
              mb: 0.25,
            }
          : {}),
        display: "grid",
        gridTemplateColumns: "minmax(0,1fr) auto",
        alignItems: "center",
        columnGap: 1,
        width: "100%",
        textAlign: "left",
        px: 0.75,
        py: 0.5,
        borderRadius: 1,
        "&:hover, &.Mui-focusVisible": { bgcolor: "action.hover" },
      }}
    >
      <Box
        sx={{ display: "flex", alignItems: "center", gap: 0.75, minWidth: 0 }}
      >
        {icon ? <Icon type={icon} /> : null}
        <Ellipsis text={name} tip={tip} />
      </Box>
      <Typography
        variant="body2"
        component="span"
        sx={{ fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}
      >
        {rate ?? ""}
      </Typography>
      {meta ? (
        <Box sx={{ gridColumn: "1 / -1", minWidth: 0 }}>
          <Ellipsis text={meta} variant="caption" color="text.secondary" />
        </Box>
      ) : null}
    </ButtonBase>
  );
}

const ports = (ps: Iterable<number>): string => {
  const s = [...ps].sort((a, b) => a - b);
  if (s.length === 0) return "";
  return `:${s.slice(0, 3).join(", :")}${s.length > 3 ? ` +${s.length - 3}` : ""}`;
};

export function EstateView(props: EstateViewProps): ReactElement {
  const { model, estate, o, rateUnit, width, height, narrow } = props;
  const [nav, setNav] = useState("estate");
  const [hideMonitoring, setHideMonitoring] = useState(false);
  const [hovered, setHovered] = useState<string | undefined>();
  const [hops, setHops] = useState(1);
  const [expanded, setExpanded] = useState<Map<string, boolean>>(
    () => new Map(),
  );
  const [openNs, setOpenNs] = useState<Set<string>>(() => new Set());
  const mapRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const impactRef = useRef<HTMLDivElement>(null);
  const rate = useCallback(
    (bps: number | undefined) => formatRate(bps, rateUnit),
    [rateUnit],
  );

  const go = useCallback((to: string) => {
    setNav(to);
    setHovered(undefined);
    if (to.startsWith("deps:")) setExpanded(new Map());
    setOpenNs(new Set());
    scrollRef.current?.scrollTo?.({ top: 0 });
  }, []);

  const monRe = useMemo(
    () => monitoringRegex(o.monitoringPattern),
    [o.monitoringPattern],
  );
  const isMon = useCallback(
    (id: string) => isMonitoring(model.byId.get(id), monRe),
    [model, monRe],
  );
  const edges = useMemo(
    () =>
      hideMonitoring
        ? props.edges.filter((e) => !isMon(e.source) && !isMon(e.target))
        : props.edges,
    [props.edges, hideMonitoring, isMon],
  );
  const visibleHops = useMemo(() => {
    const ids = new Set(edges.map((e) => e.id));
    return estate.hops.filter((h) => ids.has(h.edge.id));
  }, [estate, edges]);
  const graph = useMemo(() => depGraph(estate, edges), [estate, edges]);

  // ---------- If unreachable ----------
  // Kept across mode switches, so going back to the map and returning keeps the outage.
  const [down, setDown] = useState<Set<string>>(() => new Set());
  const [focus, setFocus] = useState<string | undefined>();
  const [copied, setCopied] = useState<string | undefined>();
  const outageInput = useMemo<OutageInput>(
    () => ({ model, estate, graph, hops: visibleHops }),
    [model, estate, graph, visibleHops],
  );

  const placeName = useCallback(
    (id: string): string => estate.places.get(id)?.name ?? id,
    [estate],
  );
  const locName = useCallback(
    (loc: string): string => {
      if (loc.startsWith("cluster:")) return loc.slice(8);
      const m = estate.machines.get(loc);
      if (m) return m.name;
      const p = estate.places.get(loc);
      if (p?.kind === "services" || p?.kind === "unplaced")
        return estate.clusters.length > 1 ? `${p.name} (${p.cluster})` : p.name;
      return placeName(loc);
    },
    [estate, placeName],
  );
  const navOfLoc = (loc: string): string =>
    loc.startsWith("cluster:") || estate.machines.has(loc)
      ? loc
      : loc.startsWith("unplaced:")
        ? `place:${loc}`
        : `place:${loc}`;

  const info = useCallback(
    (id: string): Info => {
      const n = model.byId.get(id);
      if (n) {
        const k = n.k8s;
        if (!k)
          return {
            type: "server",
            name: n.name,
            sub: n.owner ?? "server",
            go: `deps:${id}`,
          };
        if (k.type === "service")
          return {
            type: "svc",
            name: n.name,
            sub: `${k.namespace ?? ""} · Service`,
            go: `deps:${id}`,
          };
        if (k.type === "nodes" || k.type === "nat")
          return {
            type: "node",
            name: n.name,
            sub: k.cluster,
            go: `deps:${id}`,
          };
        return {
          type: "pod",
          name: n.name,
          sub: k.namespace ?? "",
          go: `deps:${id}`,
        };
      }
      const m = estate.machines.get(id);
      if (m) return { type: "node", name: m.name, sub: m.ip, go: id };
      const p = estate.places.get(id);
      if (p) {
        const type: IconType = (
          {
            lb: "lb",
            storage: "storage",
            lan: "lan",
            internet: "internet",
            clients: "clients",
            servers: "server",
            services: "svc",
            unplaced: "pod",
            private: "lan",
          } as const
        )[p.kind];
        return {
          type,
          name: locName(id),
          sub: p.note ?? p.match.slice(0, 2).join(", "),
          go: `place:${id}`,
        };
      }
      return { type: "svc", name: id, sub: "" };
    },
    [model, estate, locName],
  );

  const unitName = useCallback(
    (u: string): string => {
      if (u.startsWith("cluster:")) return `${u.slice(8)} (cluster)`;
      if (u.startsWith("vm:")) return u.slice(3);
      if (u.startsWith("addr:")) {
        const at = u.lastIndexOf("@");
        return `${placeName(u.slice(5, at))} ${u.slice(at + 1)}`;
      }
      return info(u).name;
    },
    [info, placeName],
  );
  const outage = useMemo<Outage>(
    () => simulate(outageInput, down, unitName),
    [outageInput, down, unitName],
  );
  const outageSummary = useMemo<OutageSummary>(
    () => summarize(outageInput, outage),
    [outageInput, outage],
  );
  const ranking = useMemo(
    () => (props.mode === "outage" ? rankUnits(outageInput, unitName) : []),
    [props.mode, outageInput, unitName],
  );
  const tryUnreachable = (unit: string): void => {
    setDown(new Set([unit]));
    setFocus(undefined);
    props.onMode("outage");
  };
  const unreachableButton = (unit: string): ReactElement => (
    <Button
      size="small"
      variant="outlined"
      color="error"
      sx={{ mt: 1.5, textTransform: "none" }}
      onClick={() => tryUnreachable(unit)}
    >
      What if it is unreachable?
    </Button>
  );
  const copy = (key: string, text: string): void => {
    void navigator.clipboard?.writeText(text);
    setCopied(key);
  };
  const copyButton = (
    key: string,
    label: string,
    text: string,
  ): ReactElement => (
    <Button
      key={key}
      size="small"
      variant="outlined"
      disabled={!text}
      sx={{ mt: 1, mr: 1, textTransform: "none" }}
      onClick={() => copy(key, text)}
    >
      {copied === key ? "Copied" : label}
    </Button>
  );

  // Where each service runs: the locations of its instances.
  const locationsOf = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const [loc, ids] of estate.workloadsAt)
      for (const id of ids) m.set(id, [...(m.get(id) ?? []), loc]);
    return m;
  }, [estate]);

  const allOptions = useMemo(() => {
    const out: Array<{ label: string; sub: string; go: string }> = [];
    for (const n of model.nodes)
      if (n.kind === "internal") {
        const x = info(n.id);
        out.push({ label: x.name, sub: x.sub, go: x.go ?? "" });
      }
    for (const m of estate.machines.values())
      out.push({ label: m.name, sub: `machine · ${m.cluster}`, go: m.id });
    for (const p of estate.places.values())
      out.push({ label: locName(p.id), sub: p.kind, go: `place:${p.id}` });
    return out.sort((a, b) => a.label.localeCompare(b.label));
  }, [model, estate, info, locName]);

  const unitOfGo = (to: string): string =>
    to.startsWith("deps:")
      ? to.slice(5)
      : to.startsWith("place:")
        ? to.slice(6)
        : to;

  // ---------- Crumbs ----------
  const crumbs: Array<[string, string | undefined]> =
    props.mode === "outage"
      ? [["If unreachable", undefined]]
      : [["Estate", "estate"]];
  const clusterCrumb = (c: string | undefined): void => {
    if (c) crumbs.push([`${c} (cluster)`, `cluster:${c}`]);
  };
  if (props.mode === "outage") {
    // One page: the units to mark and what that does.
  } else if (nav.startsWith("cluster:")) clusterCrumb(nav.slice(8));
  else if (estate.machines.has(nav)) {
    const m = estate.machines.get(nav)!;
    clusterCrumb(m.cluster);
    crumbs.push([m.name, nav]);
  } else if (nav === "internet") crumbs.push(["Internet", nav]);
  else if (nav.startsWith("place:")) {
    const p = estate.places.get(nav.slice(6));
    clusterCrumb(p?.cluster);
    if (p?.kind === "internet") crumbs.push(["Internet", "internet"]);
    crumbs.push([locName(nav.slice(6)), nav]);
  } else if (nav.startsWith("deps:")) {
    const id = nav.slice(5);
    const n = model.byId.get(id);
    clusterCrumb(n?.k8s?.cluster);
    const at = (locationsOf.get(id) ?? []).find((l) => estate.machines.has(l));
    if (at && n?.k8s) crumbs.push([locName(at), at]);
    crumbs.push([info(id).name, nav]);
  }
  const current = crumbs[crumbs.length - 1]?.[1];

  // ---------- Views ----------
  let main: ReactNode;
  let side: ReactNode;
  let arrows = false;
  let drawn: DrawLink[] = [];

  const kindOf = (a: string, b: string): DrawLink["kind"] => {
    const k = (x: string): string | undefined => estate.places.get(x)?.kind;
    if ([a, b].some((x) => k(x) === "storage")) return "store";
    if (
      [a, b].some((x) =>
        ["internet", "lan", "clients", "lb", "private"].includes(k(x) ?? ""),
      ) ||
      a === "internet" ||
      b === "internet"
    )
      return "out";
    return "in";
  };

  const linkRow = (l: EstateLink, from?: string): ReactElement => {
    const other = from ? (l.a === from ? l.b : l.a) : undefined;
    const name = other ? locName(other) : `${locName(l.a)} → ${locName(l.b)}`;
    const target = other ?? (l.a.startsWith("cluster:") ? l.b : l.a);
    return (
      <Row
        key={`${l.a}>${l.b}`}
        name={name}
        rate={l.measured ? rate(l.bps) : "no bytes"}
        meta={`${l.edges.size} connection${l.edges.size === 1 ? "" : "s"}${
          l.ports.size ? ` · ${ports(l.ports)}` : ""
        }`}
        onClick={() =>
          go(target === "internet" ? "internet" : navOfLoc(target))
        }
      />
    );
  };

  const internetPlaces = useMemo(
    () => [...estate.places.values()].filter((p) => p.kind === "internet"),
    [estate],
  );

  if (props.mode === "outage") {
    const toggle = (u: string, add: boolean): void => {
      setFocus(undefined);
      setDown((d) => {
        const next = new Set(add ? d : []);
        if (d.has(u)) next.delete(u);
        else next.add(u);
        return next;
      });
    };
    const toneOf = (u: string): Tone | undefined => {
      if (down.has(u)) return "down";
      const m = estate.machines.get(u);
      if (m && down.has(`cluster:${m.cluster}`)) return "down";
      const e = outage.effects.get(u) ?? outage.hosts.get(u);
      if (!e) return down.size ? "dim" : undefined;
      if (e.s === "down" || e.s === "gone") return "down";
      if (e.s === "needs" || e.s === "via") return "hit";
      return "warn";
    };
    const unitCard = (
      u: string,
      icon: IconType,
      name: string,
      sub: string,
    ): ReactElement => (
      <Card
        key={u}
        loc={u}
        icon={icon}
        name={name}
        sub={(outage.effects.get(u) ?? outage.hosts.get(u))?.why ?? sub}
        tone={toneOf(u)}
        pressed={down.has(u)}
        label={`Mark ${name} unreachable`}
        minWidth={140}
        onClick={() => toggle(u, true)}
        onHover={setHovered}
      />
    );
    const cardRow = (children: ReactNode): ReactElement => (
      <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1, mb: 1.5 }}>
        {children}
      </Box>
    );
    const inGraph = (id: string): boolean => graph.up.has(id);
    const outside = estate.mapped.filter(
      (p) =>
        ["lb", "storage", "lan", "private"].includes(p.kind) && inGraph(p.id),
    );
    const addrs = storageHosts(outageInput);
    const vms = [
      ...new Set(
        model.nodes
          .filter((n) => n.kind === "internal" && !n.k8s)
          .flatMap((n) => n.instances.map((i) => i.host)),
      ),
    ].sort();
    const inet = [...estate.places.values()].filter(
      (p) => p.kind === "internet" && inGraph(p.id),
    );

    const effectRows = (
      pick: (e: Effect) => boolean,
      tone: "bad" | "via" | "warn",
      cap?: number,
    ): ReactNode => {
      const list = [...outage.effects]
        .filter(([id, e]) => pick(e) && !down.has(id))
        .sort(
          (a, b) =>
            b[1].bps - a[1].bps ||
            info(a[0]).name.localeCompare(info(b[0]).name),
        );
      const shown = cap ? list.slice(0, cap) : list;
      return (
        <>
          {shown.map(([id, e]) => {
            const i = info(id);
            return (
              <Row
                key={id}
                icon={i.type}
                name={i.name}
                meta={e.why}
                rate={e.bps ? rate(e.bps) : undefined}
                tone={tone}
                onClick={() => setFocus(id)}
              />
            );
          })}
          {list.length > shown.length ? (
            <Note>{`${list.length - shown.length} more.`}</Note>
          ) : null}
        </>
      );
    };
    const count = (pick: (e: Effect) => boolean): number =>
      [...outage.effects].filter(([id, e]) => pick(e) && !down.has(id)).length;
    const stops = (e: Effect): boolean => e.s === "down" || e.s === "gone";
    const needs = (e: Effect): boolean => e.s === "needs";
    const via = (e: Effect): boolean => e.s === "via";
    const reduced = (e: Effect): boolean => e.s === "reduced";
    const risk = (e: Effect): boolean => e.s === "risk";

    main = (
      <>
        <Box
          sx={{
            display: "flex",
            flexWrap: "wrap",
            gap: 0.75,
            alignItems: "center",
            mb: 1.5,
          }}
        >
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            Unreachable:
          </Typography>
          {down.size ? (
            <>
              {[...down].map((u) => (
                <Chip
                  key={u}
                  size="small"
                  color="error"
                  label={unitName(u)}
                  onDelete={() => toggle(u, true)}
                />
              ))}
              <Button
                size="small"
                sx={{ textTransform: "none" }}
                onClick={() => {
                  setDown(new Set());
                  setFocus(undefined);
                }}
              >
                Clear
              </Button>
              <Typography
                variant="body2"
                color={
                  outageScore(outageSummary) > 0
                    ? "error.main"
                    : "text.secondary"
                }
                sx={{ ml: "auto" }}
              >
                {[
                  outageSummary.stop || outageSummary.needs
                    ? ""
                    : "Nothing stops",
                  ...summaryParts(outageSummary),
                ]
                  .filter(Boolean)
                  .join(" · ")}
                {". "}
                <Link
                  component="button"
                  variant="body2"
                  onClick={() =>
                    impactRef.current?.scrollIntoView?.({ behavior: "smooth" })
                  }
                >
                  Show the list
                </Link>
              </Typography>
            </>
          ) : (
            <Typography variant="body2" color="text.secondary">
              nothing yet. Click a box to mark it; click again to bring it back.
            </Typography>
          )}
        </Box>
        {outside.length || addrs.size ? (
          <>
            <Heading>Outside the clusters</Heading>
            {cardRow(
              <>
                {outside.map((p) =>
                  unitCard(
                    p.id,
                    info(p.id).type,
                    p.name,
                    p.note ?? p.match.slice(0, 2).join(", "),
                  ),
                )}
                {[...addrs].flatMap(([pid, ips]) =>
                  ips.map((ip) =>
                    unitCard(
                      addrUnit(pid, ip),
                      "storage",
                      unitName(addrUnit(pid, ip)),
                      "one host",
                    ),
                  ),
                )}
              </>,
            )}
          </>
        ) : null}
        {estate.clusters.map((c) => {
          const cu = `cluster:${c.name}`;
          return (
            <Box key={c.name} component="section" aria-label={c.name}>
              <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                <Heading>{`${c.name} · ${c.machines.length} machines`}</Heading>
                <ToggleButton
                  value="cluster"
                  size="small"
                  selected={down.has(cu)}
                  onChange={() => toggle(cu, true)}
                  sx={{ textTransform: "none", py: 0.1, mt: 1 }}
                >
                  Mark whole cluster
                </ToggleButton>
              </Box>
              {cardRow(
                [...c.machines]
                  .sort(
                    (a, b) =>
                      Number(b.controlPlane) - Number(a.controlPlane) ||
                      a.name.localeCompare(b.name),
                  )
                  .map((m) =>
                    unitCard(
                      m.id,
                      "node",
                      m.name,
                      `${m.controlPlane ? "control plane" : "worker"} · ${m.ip}`,
                    ),
                  ),
              )}
            </Box>
          );
        })}
        {vms.length ? (
          <>
            <Heading>Servers</Heading>
            {cardRow(
              vms.map((h) => unitCard(`vm:${h}`, "server", h, "server host")),
            )}
          </>
        ) : null}
        {inet.length ? (
          <>
            <Heading>Internet</Heading>
            {cardRow(
              inet.map((p) =>
                unitCard(
                  p.id,
                  "internet",
                  p.id === OTHER_INTERNET_ID
                    ? "Other internet addresses"
                    : p.name,
                  "provider",
                ),
              ),
            )}
          </>
        ) : null}
        {down.size ? (
          <Box ref={impactRef} sx={{ maxWidth: 820 }}>
            <Heading>{`Stop · ${count(stops)}`}</Heading>
            {count(stops) ? (
              effectRows(stops, "bad")
            ) : (
              <Empty>Nothing stops.</Empty>
            )}
            <Heading>{`Lose a dependency · ${count(needs)}`}</Heading>
            {count(needs) ? (
              effectRows(needs, "bad")
            ) : (
              <Empty>Nothing calls what stopped.</Empty>
            )}
            {count(via) ? (
              <>
                <Heading>{`May break, further away · ${count(via)}`}</Heading>
                {effectRows(via, "via")}
              </>
            ) : null}
            {outage.hosts.size ? (
              <>
                <Heading>{`Machines that lose something · ${outage.hosts.size}`}</Heading>
                {[...outage.hosts].map(([m, e]) => (
                  <Row
                    key={m}
                    icon="node"
                    name={locName(m)}
                    meta={e.why}
                    rate={e.bps ? rate(e.bps) : undefined}
                    tone="bad"
                    onClick={() => setFocus(m)}
                  />
                ))}
              </>
            ) : null}
            {count(reduced) ? (
              <>
                <Heading>{`Still run, on fewer machines · ${count(reduced)}`}</Heading>
                {effectRows(reduced, "warn", 8)}
              </>
            ) : null}
            {count(risk) ? (
              <>
                <Heading>{`Call something with less headroom · ${count(risk)}`}</Heading>
                {effectRows(risk, "warn", 8)}
              </>
            ) : null}
          </Box>
        ) : null}
      </>
    );

    const fe = focus
      ? (outage.effects.get(focus) ?? outage.hosts.get(focus))
      : undefined;
    const top = ranking.slice(0, 10).filter((r) => outageScore(r.summary) > 0);
    const worst = top.length ? outageScore(top[0]!.summary) : 1;
    side =
      focus && fe ? (
        <>
          <Ellipsis
            text={locName(focus) || info(focus).name}
            variant="subtitle2"
          />
          <Typography variant="body2" sx={{ mt: 0.5 }}>
            {fe.why}
          </Typography>
          <Heading>Breaks along</Heading>
          {chainOf(outage, focus).map((x) => {
            const i = info(x);
            const e = outage.effects.get(x);
            return (
              <Row
                key={x}
                icon={i.type}
                name={i.name}
                meta={e?.why}
                tone={e && (e.s === "down" || e.s === "gone") ? "bad" : "via"}
                onClick={
                  outage.effects.get(x)?.via ? () => setFocus(x) : undefined
                }
              />
            );
          })}
          <Button
            size="small"
            sx={{ mt: 1.5, textTransform: "none" }}
            onClick={() => setFocus(undefined)}
          >
            Back to the summary
          </Button>
          {model.byId.has(focus) ? (
            <Button
              size="small"
              sx={{ mt: 1.5, textTransform: "none" }}
              onClick={() => {
                props.onMode("map");
                go(`deps:${focus}`);
              }}
            >
              Open its dependencies
            </Button>
          ) : null}
        </>
      ) : (
        <>
          <Typography variant="subtitle2">If unreachable</Typography>
          {down.size ? (
            <>
              <Kv
                rows={[
                  ["Stop", outageSummary.stop],
                  ["Lose a dependency", outageSummary.needs],
                  ["May break, further away", outageSummary.via],
                  ["Machines that lose something", outageSummary.hosts],
                  ["On fewer machines", outageSummary.reduced],
                  ["Less headroom", outageSummary.risk],
                  ["Namespaces hit", outageSummary.namespaces.size],
                ]}
              />
            </>
          ) : (
            <Note>
              Mark a machine, a cluster, a server host or a place as unreachable
              and see, from the flows measured, what stops and what loses a
              dependency. Several can be marked at once.
            </Note>
          )}
          <Heading>What hurts most, one at a time</Heading>
          {top.length ? (
            top.map((r) => (
              <ButtonBase
                key={r.unit}
                onClick={(ev) =>
                  ev.shiftKey
                    ? toggle(r.unit, true)
                    : setDown(new Set([r.unit]))
                }
                aria-label={`Try ${unitName(r.unit)} alone`}
                sx={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  py: 0.5,
                  borderRadius: 0.5,
                  "&:hover, &.Mui-focusVisible": { bgcolor: "action.hover" },
                }}
              >
                <Box sx={{ display: "flex", gap: 1, minWidth: 0 }}>
                  <Box sx={{ minWidth: 0, flex: 1 }}>
                    <Ellipsis text={unitName(r.unit)} variant="body2" />
                  </Box>
                  <Typography variant="caption" color="text.secondary">
                    {summaryParts(r.summary).slice(0, 2).join(", ")}
                  </Typography>
                </Box>
                <Box
                  sx={{
                    height: 4,
                    mt: 0.25,
                    borderRadius: 2,
                    bgcolor: down.has(r.unit) ? "error.main" : "error.light",
                    opacity: down.has(r.unit) ? 1 : 0.6,
                    width: `${Math.max(4, (outageScore(r.summary) / worst) * 100)}%`,
                  }}
                />
              </ButtonBase>
            ))
          ) : (
            <Empty>Nothing loses a dependency on its own.</Empty>
          )}
          <Note>Click to try one alone; shift-click to add it.</Note>
          <Heading>What the flows cannot tell</Heading>
          <Note>
            Only traffic seen in the time range counts: a replica or a fallback
            that stayed quiet is not known. Nothing reschedules here, so this is
            the first minutes, before pods move. Retries, caches and failover
            inside an application are not visible in flows.
          </Note>
        </>
      );
  } else if (nav === "estate") {
    arrows = true;
    const group = (loc: string): string => {
      const g = estateGroup(estate, loc);
      return estate.places.get(g)?.kind === "internet" ? "internet" : g;
    };
    const links = linksOf(visibleHops, group, true);
    const present = new Set(links.flatMap((l) => [l.a, l.b]));
    const lbs = estate.mapped.filter((p) => p.kind === "lb");
    const outside = estate.mapped.filter(
      (p) => p.kind === "storage" || p.kind === "lan",
    );
    const notMeasured: DrawLink[] = [];
    for (const lb of lbs)
      for (const to of lb.forwardsTo ?? []) {
        const target = estate.clusters.some((c) => c.name === to)
          ? `cluster:${to}`
          : estate.mapped.find((p) => p.name === to)?.id;
        if (!target) continue;
        if (links.some((l) => l.a === lb.id && l.b === target && l.measured))
          continue;
        notMeasured.push({
          a: lb.id,
          b: target,
          bps: 0,
          measured: false,
          dashed: true,
          kind: kindOf(lb.id, target),
        });
      }
    drawn = [
      ...links.map((l) => ({
        a: l.a,
        b: l.b,
        bps: l.bps,
        measured: l.measured,
        kind: kindOf(l.a, l.b),
      })),
      ...notMeasured,
    ];
    const inetBps = sum(
      links.filter((l) => l.b === "internet").map((l) => l.bps),
    );
    const inetAddrs = new Set(
      visibleHops
        .filter((h) => estate.places.get(h.to)?.kind === "internet")
        .map((h) => h.ip),
    ).size;
    const hasServers = estate.workloadsAt.has(SERVERS_ID);
    const cols: ReactNode[] = [];
    if (estate.places.has(CLIENTS_ID))
      cols.push(
        <Card
          key="clients"
          loc={CLIENTS_ID}
          icon="clients"
          name="Clients"
          sub="callers outside, never called"
          onClick={() => go(`place:${CLIENTS_ID}`)}
          onHover={setHovered}
        />,
      );
    if (lbs.length > 0)
      cols.push(
        <>
          {lbs.map((p) => (
            <Card
              key={p.id}
              loc={p.id}
              icon="lb"
              name={p.name}
              sub={p.note ?? p.match.join(", ")}
              onClick={() => go(`place:${p.id}`)}
              onHover={setHovered}
            />
          ))}
        </>,
      );
    cols.push(
      <>
        {estate.clusters.map((c) => {
          const wl = new Set<string>();
          const nss = new Set<string>();
          for (const [loc, ids] of estate.workloadsAt)
            if (estateGroup(estate, loc) === `cluster:${c.name}`)
              for (const id of ids) {
                const n = model.byId.get(id);
                if (n?.k8s?.type === "workload") {
                  wl.add(id);
                  if (n.k8s.namespace) nss.add(n.k8s.namespace);
                }
              }
          return (
            <Card
              key={c.name}
              loc={`cluster:${c.name}`}
              name={c.name}
              sub="Kubernetes"
              minWidth={210}
              onClick={() => go(`cluster:${c.name}`)}
              onHover={setHovered}
            >
              <Box
                sx={{
                  display: "grid",
                  gridTemplateColumns: "repeat(2, minmax(0,1fr))",
                  gap: 0.5,
                  mt: 0.5,
                }}
              >
                {(
                  [
                    [c.machines.length, "nodes"],
                    [wl.size, "workloads"],
                    [
                      c.machines.filter((m) => m.controlPlane).length,
                      "control plane",
                    ],
                    [nss.size, "namespaces"],
                  ] as Array<[number, string]>
                ).map(([v, k]) => (
                  <Box key={k} sx={{ minWidth: 0 }}>
                    <Typography variant="subtitle2" component="span">
                      {v}
                    </Typography>{" "}
                    <Typography
                      variant="caption"
                      component="span"
                      color="text.secondary"
                    >
                      {k}
                    </Typography>
                  </Box>
                ))}
              </Box>
              <Typography
                variant="caption"
                color="primary.main"
                sx={{ mt: 0.5 }}
              >
                Open machines ›
              </Typography>
            </Card>
          );
        })}
        {hasServers ? (
          <Card
            loc={SERVERS_ID}
            icon="server"
            name="Servers"
            sub={`${estate.workloadsAt.get(SERVERS_ID)?.size ?? 0} mapped services`}
            onClick={() => go(`place:${SERVERS_ID}`)}
            onHover={setHovered}
          />
        ) : null}
      </>,
    );
    const right: ReactNode[] = outside.map((p) => (
      <Card
        key={p.id}
        loc={p.id}
        icon={p.kind === "storage" ? "storage" : "lan"}
        name={p.name}
        sub={p.note ?? p.match.join(", ")}
        onClick={() => go(`place:${p.id}`)}
        onHover={setHovered}
      />
    ));
    if (present.has(PRIVATE_ID))
      right.push(
        <Card
          key={PRIVATE_ID}
          loc={PRIVATE_ID}
          icon="lan"
          name={placeName(PRIVATE_ID)}
          sub="in no place of the mapping"
          dashed
          onClick={() => go(`place:${PRIVATE_ID}`)}
          onHover={setHovered}
        />,
      );
    if (present.has("internet"))
      right.push(
        <Card
          key="internet"
          loc="internet"
          icon="internet"
          name="Internet"
          sub={`${inetAddrs} address${inetAddrs === 1 ? "" : "es"} · ${rate(inetBps)}`}
          onClick={() => go("internet")}
          onHover={setHovered}
        />,
      );
    if (right.length) cols.push(<>{right}</>);
    main = (
      <>
        <Box
          sx={{
            display: "grid",
            gridTemplateColumns: narrow
              ? "minmax(0,1fr)"
              : `repeat(${cols.length}, minmax(150px, 1fr))`,
            columnGap: narrow ? 0 : 7,
            rowGap: 3,
            alignItems: "center",
          }}
        >
          {cols.map((c, i) => (
            <Box
              key={i}
              sx={{
                display: "flex",
                flexDirection: "column",
                gap: 2,
                minWidth: 0,
              }}
            >
              {c}
            </Box>
          ))}
        </Box>
        <Legend>
          <Swatch kind="in" label="measured" />
          <Swatch kind="store" label="storage" />
          <Swatch kind="out" label="leaves the cluster" />
          <Swatch kind="in" label="not measured" dashed />
          <span>Thicker = higher rate. Hover a box for its rates.</span>
        </Legend>
      </>
    );
    const list = hovered
      ? links.filter((l) => l.a === hovered || l.b === hovered)
      : links;
    side = (
      <>
        <Ellipsis
          text={hovered ? locName(hovered) : "Estate"}
          variant="subtitle2"
        />
        <Note>
          {hovered
            ? "Measured flows to and from this box."
            : "Every cluster, server and place on one page. Click a box to open it."}
        </Note>
        <Heading>Measured flows</Heading>
        {list.length ? (
          list.slice(0, 12).map((l) => linkRow(l))
        ) : (
          <Empty>No measured flows.</Empty>
        )}
        {notMeasured.length ? (
          <>
            <Heading>Not measured</Heading>
            {notMeasured.map((l) => (
              <Row
                key={`${l.a}>${l.b}`}
                name={`${locName(l.a)} → ${locName(l.b)}`}
                rate="not measured"
                meta="Its host runs no collector, so the line is dashed and has no rate."
              />
            ))}
          </>
        ) : null}
      </>
    );
  } else if (nav.startsWith("cluster:")) {
    const cl = nav.slice(8);
    const block = estate.clusters.find((c) => c.name === cl);
    const inCluster = (loc: string): boolean =>
      estateGroup(estate, loc) === `cluster:${cl}`;
    const key = (loc: string): string =>
      inCluster(loc) ? loc : estateGroup(estate, loc);
    const links = linksOf(visibleHops, key, false);
    drawn = links.map((l) => ({
      a: l.a,
      b: l.b,
      bps: l.bps,
      measured: l.measured,
      kind: kindOf(l.a, l.b),
    }));
    const providers = internetPlaces
      .map((p) => ({
        p,
        bps: sum(
          visibleHops
            .filter((h) => h.to === p.id && inCluster(h.from))
            .map((h) => h.bps),
        ),
        addrs: new Set(
          visibleHops
            .filter((h) => h.to === p.id && inCluster(h.from))
            .map((h) => h.ip),
        ).size,
      }))
      .filter((x) => x.addrs > 0)
      .sort((a, b) => b.bps - a.bps);
    const shownProviders = providers.slice(0, 5);
    const shortMachine = dropCommonPrefix(
      (block?.machines ?? []).map((m) => m.name),
    );
    const machineCard = (m: Machine): ReactElement => {
      const ids = [...(estate.workloadsAt.get(m.id) ?? [])].filter(
        (id) => model.byId.get(id)?.k8s?.type === "workload",
      );
      const nss = new Map<string, number>();
      for (const id of ids) {
        const ns = model.byId.get(id)?.k8s?.namespace ?? "";
        nss.set(ns, (nss.get(ns) ?? 0) + 1);
      }
      const bars = [...nss].sort((a, b) => b[1] - a[1]);
      return (
        <Card
          key={m.id}
          loc={m.id}
          icon="node"
          name={shortMachine.get(m.name) ?? m.name}
          tip={m.name}
          sub={m.ip || "address not known"}
          active={hovered === m.id}
          onClick={() => go(m.id)}
          onHover={setHovered}
        >
          <Typography variant="caption" color="text.secondary">
            {ids.length} workloads · {nss.size} ns
          </Typography>
          {ids.length ? (
            <Box
              sx={{
                display: "flex",
                height: 4,
                borderRadius: 1,
                overflow: "hidden",
                mt: 0.25,
              }}
            >
              {bars.map(([ns, c], i) => (
                <Box
                  key={ns}
                  sx={{
                    width: `${((100 * c) / ids.length).toFixed(1)}%`,
                    bgcolor: "primary.main",
                    opacity: Math.max(0.2, 1 - i * 0.14),
                  }}
                />
              ))}
            </Box>
          ) : null}
        </Card>
      );
    };
    const grid = (children: ReactNode): ReactElement => (
      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))",
          gap: 2,
        }}
      >
        {children}
      </Box>
    );
    const rowLabel = (t: string): ReactElement => <Heading>{t}</Heading>;
    const cp = block?.machines.filter((m) => m.controlPlane) ?? [];
    const workers = block?.machines.filter((m) => !m.controlPlane) ?? [];
    const network = [`svc:${cl}`, `unplaced:${cl}`].filter((id) =>
      estate.places.has(id),
    );
    const outsideIds = [
      ...[CLIENTS_ID].filter((id) => estate.places.has(id)),
      ...estate.mapped.filter((p) => p.kind !== "internet").map((p) => p.id),
      ...[PRIVATE_ID, SERVERS_ID].filter((id) => estate.places.has(id)),
      ...estate.clusters
        .filter((c) => c.name !== cl)
        .map((c) => `cluster:${c.name}`),
    ];
    main = (
      <>
        {providers.length ? (
          <>
            {rowLabel("Internet")}
            {grid(
              <>
                {shownProviders.map(({ p, bps, addrs }) => (
                  <Card
                    key={p.id}
                    loc={p.id}
                    icon="internet"
                    name={p.name}
                    sub={`${addrs} address${addrs === 1 ? "" : "es"} · ${rate(bps)}`}
                    onClick={() => go(`place:${p.id}`)}
                    onHover={setHovered}
                  />
                ))}
                {providers.length > shownProviders.length ? (
                  <Card
                    loc="internet-more"
                    name={`+${providers.length - shownProviders.length} more`}
                    sub="all providers"
                    onClick={() => go("internet")}
                    onHover={setHovered}
                  />
                ) : null}
              </>,
            )}
          </>
        ) : null}
        <Box
          sx={{
            mt: 2,
            p: 1.5,
            border: 1,
            borderColor: "divider",
            borderRadius: 1,
          }}
        >
          <Box
            sx={{ display: "flex", alignItems: "center", gap: 1, minWidth: 0 }}
          >
            <ClusterIcon />
            <Ellipsis text={cl} variant="subtitle2" />
            <Typography variant="caption" color="text.secondary" noWrap>
              Kubernetes · {block?.machines.length ?? 0} nodes
            </Typography>
          </Box>
          {cp.length ? (
            <>
              {rowLabel("Control plane")}
              {grid(cp.map(machineCard))}
            </>
          ) : null}
          {workers.length ? (
            <>
              {rowLabel(cp.length ? "Workers" : "Nodes")}
              {grid(workers.map(machineCard))}
            </>
          ) : null}
          {network.length ? (
            <>
              {rowLabel("Cluster network")}
              {grid(
                network.map((id) => (
                  <Card
                    key={id}
                    loc={id}
                    icon={id.startsWith("svc:") ? "svc" : "pod"}
                    name={placeName(id)}
                    sub={
                      id.startsWith("svc:")
                        ? "ClusterIP addresses"
                        : "pods without a node label"
                    }
                    dashed={id.startsWith("unplaced:")}
                    onClick={() => go(`place:${id}`)}
                    onHover={setHovered}
                  />
                )),
              )}
            </>
          ) : null}
        </Box>
        {outsideIds.length ? (
          <>
            {rowLabel("Outside the cluster")}
            {grid(
              outsideIds.map((id) => {
                const x = id.startsWith("cluster:")
                  ? {
                      type: "node" as IconType,
                      name: id.slice(8),
                      sub: "cluster",
                    }
                  : info(id);
                return (
                  <Card
                    key={id}
                    loc={id}
                    icon={x.type}
                    name={x.name}
                    sub={x.sub}
                    onClick={() => go(navOfLoc(id))}
                    onHover={setHovered}
                  />
                );
              }),
            )}
          </>
        ) : null}
        <Legend>
          <Swatch kind="in" label="between machines" />
          <Swatch kind="store" label="storage" />
          <Swatch kind="out" label="outside the cluster" />
          <span>Thicker = higher rate. Every box opens its page.</span>
        </Legend>
      </>
    );
    const mine = hovered
      ? links.filter((l) => l.a === hovered || l.b === hovered)
      : links;
    const wlCount = new Set(
      [...estate.workloadsAt]
        .filter(([loc]) => inCluster(loc))
        .flatMap(([, ids]) => [...ids]),
    ).size;
    side = hovered ? (
      <>
        <Ellipsis text={locName(hovered)} variant="subtitle2" />
        <Note>{mine.length} linked. Click the box to open it.</Note>
        <Heading>Links</Heading>
        {mine.length ? (
          mine.slice(0, 10).map((l) => linkRow(l, hovered))
        ) : (
          <Empty>No links after filtering.</Empty>
        )}
      </>
    ) : (
      <>
        <Typography variant="subtitle2">
          {block?.machines.length ?? 0} machines · {wlCount} workloads
        </Typography>
        <Note>
          Each box is one machine. A line adds up all traffic between the
          workloads on two machines; an edge&apos;s rate is split evenly over
          the instance pairs it joins.
        </Note>
        <Heading>Busiest links</Heading>
        {links.length ? (
          links.slice(0, 8).map((l) => linkRow(l))
        ) : (
          <Empty>No links after filtering.</Empty>
        )}
        {unreachableButton(`cluster:${block?.name ?? nav.slice(8)}`)}
        <Heading>Firewall</Heading>
        <Note>
          Every opening across this cluster&apos;s boundary, in and out.
        </Note>
        {copyButton(
          `fw:${nav}`,
          "Copy firewall rules",
          formatRules(firewallRulesForCluster(model, nav.slice(8))),
        )}
      </>
    );
  } else if (estate.machines.has(nav)) {
    const m = estate.machines.get(nav)!;
    const ids = [...(estate.workloadsAt.get(m.id) ?? [])];
    const byNs = new Map<string, string[]>();
    for (const id of ids) {
      const n = model.byId.get(id);
      const ns =
        n?.k8s?.type === "workload" ? (n.k8s.namespace ?? "") : "(machine)";
      byNs.set(ns, [...(byNs.get(ns) ?? []), id]);
    }
    const nss = [...byNs].sort(
      (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
    );
    const mine = visibleHops.filter((h) => h.from === m.id || h.to === m.id);
    const cross = new Set<string>();
    for (const h of mine) {
      if (h.from === m.id && h.to !== m.id) cross.add(h.edge.source);
      if (h.to === m.id && h.from !== m.id) cross.add(h.edge.target);
    }
    const sends = new Map<string, number>();
    for (const h of mine)
      if (h.from === m.id)
        sends.set(
          h.edge.source,
          (sends.get(h.edge.source) ?? 0) + (h.bps ?? 0),
        );
    main = (
      <>
        <Box
          sx={{ display: "flex", gap: 1, alignItems: "baseline", minWidth: 0 }}
        >
          <Ellipsis text={m.name} variant="subtitle2" />
          <Typography variant="caption" color="text.secondary" noWrap>
            {m.ip ? `${m.ip} · ` : ""}
            {ids.length} workloads · {nss.length} namespaces
          </Typography>
        </Box>
        <Box
          sx={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
            gap: 1.5,
            mt: 1.5,
          }}
        >
          {nss.map(([ns, list]) => {
            const shown = list.filter((id) => !(hideMonitoring && isMon(id)));
            const hidden = list.length - shown.length;
            const names = shown.map((id) => model.byId.get(id)?.name ?? id);
            const prefix = sharedPrefix(names);
            const open = openNs.has(ns);
            const top = open ? shown : shown.slice(0, CHIPS_SHOWN);
            const rest = shown.length - top.length;
            return (
              <Box
                key={ns}
                component="section"
                aria-label={`Namespace ${ns}`}
                sx={{
                  border: 1,
                  borderColor: "divider",
                  borderRadius: 1,
                  p: 1,
                  minWidth: 0,
                }}
              >
                <Box
                  sx={{
                    display: "grid",
                    gridTemplateColumns: "minmax(0,1fr) auto auto",
                    gap: 1,
                    alignItems: "baseline",
                    mb: 0.75,
                  }}
                >
                  <Ellipsis text={ns} weight={600} />
                  <Typography variant="caption" color="text.secondary" noWrap>
                    {prefix ? `${prefix}…` : ""}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {list.length}
                  </Typography>
                </Box>
                <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5 }}>
                  {top.map((id) => {
                    const n = model.byId.get(id);
                    const name = n?.name ?? id;
                    const hot = cross.has(id);
                    return (
                      <Tooltip
                        key={id}
                        title={`${name} · sends ${rate(sends.get(id))}${
                          hot ? " · talks to another machine" : ""
                        }`}
                        disableInteractive
                      >
                        <ButtonBase
                          onClick={() => go(`deps:${id}`)}
                          aria-label={name}
                          sx={{
                            width: CHIP_W,
                            justifyContent: "flex-start",
                            gap: 0.5,
                            px: 0.75,
                            py: 0.25,
                            borderRadius: 1,
                            border: 1,
                            borderColor: hot ? "primary.main" : "divider",
                            fontSize: 12,
                            "&:hover, &.Mui-focusVisible": {
                              bgcolor: "action.hover",
                            },
                          }}
                        >
                          <Box
                            component="span"
                            sx={{
                              width: 6,
                              height: 6,
                              borderRadius: "50%",
                              flexShrink: 0,
                              bgcolor: hot ? "primary.main" : "text.disabled",
                            }}
                          />
                          <Box
                            component="span"
                            sx={{
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {shortName(name, ns, prefix)}
                          </Box>
                        </ButtonBase>
                      </Tooltip>
                    );
                  })}
                  {rest > 0 || hidden > 0 ? (
                    <Box
                      sx={{
                        display: "flex",
                        alignItems: "center",
                        gap: 0.5,
                        fontSize: 12,
                        color: "text.secondary",
                      }}
                    >
                      {rest > 0 ? (
                        <Link
                          component="button"
                          variant="caption"
                          onClick={() =>
                            setOpenNs((cur) => new Set(cur).add(ns))
                          }
                        >
                          +{rest} more
                        </Link>
                      ) : null}
                      {hidden > 0 ? (
                        <span>{hidden} monitoring hidden</span>
                      ) : null}
                    </Box>
                  ) : null}
                </Box>
              </Box>
            );
          })}
        </Box>
        <Legend>
          <span>
            A blue outline talks to another machine. Hover a name for the full
            name and rate; click it for its dependencies.
          </span>
        </Legend>
      </>
    );
    const agg = (dir: "out" | "in"): Array<[string, number, Set<string>]> => {
      const g = new Map<string, [number, Set<string>]>();
      for (const h of mine) {
        const other =
          dir === "out"
            ? h.from === m.id && h.to !== m.id
              ? h.to
              : undefined
            : h.to === m.id && h.from !== m.id
              ? h.from
              : undefined;
        if (!other) continue;
        const x = g.get(other) ?? [0, new Set<string>()];
        x[0] += h.bps ?? 0;
        x[1].add(dir === "out" ? h.edge.source : h.edge.target);
        g.set(other, x);
      }
      return [...g]
        .map(([k, [b, w]]) => [k, b, w] as [string, number, Set<string>])
        .sort((a, b) => b[1] - a[1]);
    };
    const out = agg("out");
    const inn = agg("in");
    const li = (
      [other, b, w]: [string, number, Set<string>],
      dir: string,
    ): ReactElement => (
      <Row
        key={other}
        icon={info(other).type}
        name={`${dir} ${locName(other)}`}
        rate={rate(b)}
        meta={`${w.size} workload${w.size === 1 ? "" : "s"} here`}
        tip={[...w].map((id) => model.byId.get(id)?.name ?? id).join(", ")}
        onClick={() => go(navOfLoc(other))}
      />
    );
    side = (
      <>
        <Ellipsis text={m.name} variant="subtitle2" />
        <Kv
          rows={[
            [
              "Links on this machine",
              mine.filter((h) => h.from === m.id && h.to === m.id).length,
            ],
            ["Leaves it", rate(sum(out.map((x) => x[1])))],
            ["Arrives", rate(sum(inn.map((x) => x[1])))],
          ]}
        />
        <Heading>Leaves to</Heading>
        {out.length ? (
          out.slice(0, 8).map((x) => li(x, "To"))
        ) : (
          <Empty>Nothing after filtering.</Empty>
        )}
        <Heading>Arrives from</Heading>
        {inn.length ? (
          inn.slice(0, 8).map((x) => li(x, "From"))
        ) : (
          <Empty>Nothing after filtering.</Empty>
        )}
        {unreachableButton(m.id)}
      </>
    );
  } else if (nav === "internet") {
    const rows = internetPlaces
      .map((p) => {
        const hs = visibleHops.filter((h) => h.to === p.id);
        return {
          p,
          bps: sum(hs.map((h) => h.bps)),
          addrs: new Set(hs.map((h) => h.ip)).size,
        };
      })
      .filter((x) => x.addrs > 0)
      .sort((a, b) => b.bps - a.bps);
    main = (
      <Box sx={{ maxWidth: 720 }}>
        <Heading>{`Providers · ${rows.length}`}</Heading>
        {rows.length ? (
          rows.map(({ p, bps, addrs }) => (
            <Row
              key={p.id}
              icon="internet"
              name={p.name}
              rate={rate(bps)}
              meta={`${addrs} address${addrs === 1 ? "" : "es"}`}
              onClick={() => go(`place:${p.id}`)}
            />
          ))
        ) : (
          <Empty>No flow reaches the internet after filtering.</Empty>
        )}
      </Box>
    );
    side = (
      <>
        <Typography variant="subtitle2">Internet</Typography>
        <Kv
          rows={[
            ["Leaves the estate", rate(sum(rows.map((r) => r.bps)))],
            ["Addresses", sum(rows.map((r) => r.addrs))],
          ]}
        />
        <Note>
          Providers are matched by their published ranges (the mapping&apos;s
          places.internet, or the defaults). Addresses in none of them are
          &quot;Other internet addresses&quot;.
        </Note>
      </>
    );
  } else if (nav.startsWith("place:")) {
    const pid = nav.slice(6);
    const p: Place | undefined = estate.places.get(pid);
    const inbound = visibleHops.filter((h) => h.to === pid);
    const outbound = visibleHops.filter((h) => h.from === pid);
    const group = (
      list: Hop[],
      keyOf: (h: Hop) => string,
      idOf: (h: Hop) => string,
      extraOf?: (h: Hop) => string,
    ): Array<{
      id: string;
      bps: number;
      ports: Set<number>;
      extra: string;
    }> => {
      const g = new Map<
        string,
        { id: string; bps: number; ports: Set<number>; extra: string }
      >();
      for (const h of list) {
        const k = keyOf(h);
        const x = g.get(k) ?? {
          id: idOf(h),
          bps: 0,
          ports: new Set<number>(),
          extra: extraOf?.(h) ?? "",
        };
        x.bps += h.bps ?? 0;
        x.ports.add(h.edge.port);
        g.set(k, x);
      }
      return [...g.values()].sort((a, b) => b.bps - a.bps);
    };
    const peer = (x: {
      id: string;
      bps: number;
      ports: Set<number>;
      extra: string;
    }): ReactElement => {
      const i = info(x.id);
      return (
        <Row
          key={`${x.id}|${x.extra}`}
          icon={i.type}
          name={i.name}
          rate={rate(x.bps)}
          meta={[i.sub, ports(x.ports), x.extra].filter(Boolean).join(" · ")}
          onClick={i.go ? () => go(i.go!) : undefined}
        />
      );
    };
    const limit = (rows: ReactElement[], max = 40): ReactNode => (
      <>
        {rows.slice(0, max)}
        {rows.length > max ? (
          <Empty>{`+${rows.length - max} more`}</Empty>
        ) : null}
      </>
    );
    const src = (h: Hop): string => depKey(estate, h.edge.source);
    const dst = (h: Hop): string => depKey(estate, h.edge.target);
    let body: ReactNode;
    let sideBody: ReactNode = null;
    if (p?.kind === "storage" && p.preset === "ceph") {
      const g = group(
        inbound,
        (h) => `${src(h)}|${cephRole(h.edge.port)}|${h.ip}`,
        src,
        (h) => `${cephRole(h.edge.port)} on ${h.ip ?? "?"}`,
      );
      const byRole = (r: string): number =>
        sum(
          inbound.filter((h) => cephRole(h.edge.port) === r).map((h) => h.bps),
        );
      const hosts = [...new Set(inbound.map((h) => h.ip ?? "?"))].sort();
      body = (
        <>
          <Heading>{`Clients · ${g.length}`}</Heading>
          {g.length ? limit(g.map(peer)) : <Empty>No flows.</Empty>}
        </>
      );
      sideBody = (
        <>
          <Heading>By role</Heading>
          <Kv
            rows={[
              [
                "mon · :6789, :3300",
                byRole("mon") ? rate(byRole("mon")) : "none seen",
              ],
              ["OSD / mgr · :6800–7300", rate(byRole("OSD / mgr"))],
              ...(byRole("other")
                ? ([["other ports", rate(byRole("other"))]] as Array<
                    [string, string]
                  >)
                : []),
            ]}
          />
          <Note>
            OSDs and managers share the 6800–7300 range, so flows cannot tell
            them apart. Clients are often node kernels (RBD, CephFS): the pod
            behind a mount is not in the flow.
          </Note>
          <Heading>By host</Heading>
          <Kv
            rows={hosts.map((ip) => [
              ip,
              rate(
                sum(
                  inbound.filter((h) => (h.ip ?? "?") === ip).map((h) => h.bps),
                ),
              ),
            ])}
          />
        </>
      );
    } else if (p?.kind === "internet") {
      const g = group(inbound, src, src);
      const addrs = new Map<string, number>();
      for (const h of inbound)
        addrs.set(h.ip ?? "?", (addrs.get(h.ip ?? "?") ?? 0) + (h.bps ?? 0));
      const sorted = [...addrs].sort((a, b) => b[1] - a[1]);
      const named = sorted.slice(0, o.internetTop);
      const rest = sorted.slice(o.internetTop);
      body = (
        <>
          <Heading>{`Workloads and machines that call it · ${g.length}`}</Heading>
          {g.length ? (
            limit(g.map(peer))
          ) : (
            <Empty>No flow with a known source reaches it.</Empty>
          )}
          <Heading>{`Addresses · ${sorted.length}`}</Heading>
          {named.map(([ip, b]) => (
            <Row key={ip} name={ip} rate={rate(b)} />
          ))}
          {rest.length ? (
            <Row
              name={`+${rest.length} more address${rest.length === 1 ? "" : "es"}`}
              rate={rate(sum(rest.map((x) => x[1])))}
              meta={`Only the ${o.internetTop} busiest are listed by name.`}
            />
          ) : null}
        </>
      );
      sideBody = (
        <>
          <Heading>Other providers</Heading>
          {internetPlaces
            .filter((x) => x.id !== pid)
            .map((x) => ({
              x,
              bps: sum(
                visibleHops.filter((h) => h.to === x.id).map((h) => h.bps),
              ),
              n: visibleHops.filter((h) => h.to === x.id).length,
            }))
            .filter((r) => r.n > 0)
            .sort((a, b) => b.bps - a.bps)
            .map(({ x, bps }) => (
              <Row
                key={x.id}
                icon="internet"
                name={x.name}
                rate={rate(bps)}
                onClick={() => go(`place:${x.id}`)}
              />
            ))}
        </>
      );
    } else if (p?.kind === "servers") {
      const ids = [...(estate.workloadsAt.get(SERVERS_ID) ?? [])];
      body = (
        <>
          <Heading>{`Services · ${ids.length}`}</Heading>
          {ids
            .map((id) => model.byId.get(id)!)
            .filter(Boolean)
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((n) => (
              <Row
                key={n.id}
                icon="server"
                name={n.name}
                meta={[
                  n.owner,
                  `${n.instances.length} instance${n.instances.length === 1 ? "" : "s"}`,
                  n.wave > 0 ? `wave ${n.wave}` : "",
                ]
                  .filter(Boolean)
                  .join(" · ")}
                onClick={() => go(`deps:${n.id}`)}
              />
            ))}
          {wavesOf(model).length ? (
            <>
              <Heading>Firewall rules per migration wave</Heading>
              {wavesOf(model).map((w) =>
                copyButton(
                  `wave:${w}`,
                  `Copy wave ${w}`,
                  formatRules(firewallRulesForWave(model, w)),
                ),
              )}
            </>
          ) : null}
        </>
      );
    } else if (p?.kind === "services") {
      const g = group(
        inbound,
        (h) => `${src(h)}|${h.edge.target}`,
        src,
        (h) => `→ ${model.byId.get(h.edge.target)?.name ?? h.edge.target}`,
      );
      body = (
        <>
          <Heading>{`Calls to cluster services · ${g.length}`}</Heading>
          {g.length ? limit(g.map(peer)) : <Empty>No flows.</Empty>}
        </>
      );
      sideBody = (
        <Note>
          Flows caught before kube-proxy picked a pod. The pod behind each
          Service shows up as its own flow when the collector sees it.
        </Note>
      );
    } else {
      const g = group(
        inbound,
        (h) => `${src(h)}|${p?.kind === "lan" ? h.ip : ""}`,
        src,
        (h) =>
          p?.kind === "lan" || p?.kind === "private" ? `→ ${h.ip ?? "?"}` : "",
      );
      const o2 = group(outbound, dst, dst);
      body = (
        <>
          {g.length || !o2.length ? (
            <>
              <Heading>{`Callers · ${g.length}`}</Heading>
              {g.length ? limit(g.map(peer)) : <Empty>No flows.</Empty>}
            </>
          ) : null}
          {o2.length ? (
            <>
              <Heading>{`What it reaches · ${o2.length}`}</Heading>
              {limit(o2.map(peer))}
            </>
          ) : null}
        </>
      );
      if (p?.kind === "lb")
        sideBody = (
          <Note>
            {p.forwardsTo?.length
              ? `Forwards to ${p.forwardsTo.join(", ")}. Only what is measured is drawn solid; a host without a collector leaves its forwarding dashed as "not measured".`
              : "Only calls into it are measured unless its host runs a collector."}
          </Note>
        );
      if (p?.kind === "clients")
        sideBody = (
          <Note>
            Callers outside every cluster and server that nothing calls back:
            devices, other networks, the internet.
          </Note>
        );
      if (p?.kind === "unplaced")
        sideBody = (
          <Note>
            Pods whose node the collector did not report, or pods not seen in
            the last hours of the window.
          </Note>
        );
    }
    const iconType = info(pid).type;
    main = (
      <Box sx={{ maxWidth: 760 }}>
        <Box
          sx={{ display: "flex", gap: 0.75, alignItems: "center", minWidth: 0 }}
        >
          <Icon type={iconType} />
          <Ellipsis text={locName(pid)} variant="subtitle2" />
        </Box>
        {p?.match.length ? (
          <Ellipsis
            text={p.match.join(", ")}
            variant="caption"
            color="text.secondary"
          />
        ) : null}
        {body}
      </Box>
    );
    side = (
      <>
        <Ellipsis text={locName(pid)} variant="subtitle2" />
        {p?.note ? <Note>{p.note}</Note> : null}
        <Kv
          rows={[
            ["Arrives", rate(sum(inbound.map((h) => h.bps)))],
            ...(outbound.length
              ? ([["Leaves", rate(sum(outbound.map((h) => h.bps)))]] as Array<
                  [string, string]
                >)
              : []),
            ["Callers", new Set(inbound.map(src)).size],
          ]}
        />
        {sideBody}
        <Note>Rows open the service&apos;s dependencies.</Note>
        {isUnit(outageInput, pid) ? unreachableButton(pid) : null}
      </>
    );
  } else if (nav.startsWith("deps:")) {
    const id = nav.slice(5);
    const self = info(id);
    const isService = (x: string): boolean =>
      model.byId.get(x)?.kind === "internal";
    const tree = (
      at: string,
      dir: "up" | "down",
      depth: number,
      path: string[],
    ): ReactNode => {
      const adj = dir === "up" ? graph.up : graph.down;
      const list = (adj.get(at) ?? []).filter((x) => !path.includes(x.id));
      if (!list.length)
        return depth === 1 ? (
          <Empty>
            {dir === "up"
              ? "Nothing calls it after filtering."
              : "It calls nothing after filtering."}
          </Empty>
        ) : null;
      const top = list.slice(0, depth === 1 ? 12 : 8);
      return (
        <>
          {depth > 1 ? (
            <Typography variant="caption" color="text.secondary" sx={{ pl: 1 }}>
              Hop {depth} · {dir === "up" ? "calls " : "called by "}
              {info(at).name}
            </Typography>
          ) : null}
          {top.map((x: Neighbour) => {
            const key = `${dir}>${[...path, x.id].join(">")}`;
            const more =
              depth < 3 &&
              (adj.get(x.id) ?? []).some(
                (y) => ![...path, x.id].includes(y.id),
              );
            const open =
              more && (expanded.has(key) ? expanded.get(key)! : depth < hops);
            const i = info(x.id);
            const where = (locationsOf.get(x.id) ?? [])
              .filter((l) => estate.machines.has(l))
              .map(locName);
            return (
              <Box key={key}>
                <Box
                  sx={{
                    display: "grid",
                    gridTemplateColumns: "minmax(0,1fr) 28px",
                    alignItems: "center",
                  }}
                >
                  <Row
                    icon={i.type}
                    name={i.name}
                    rate={x.measured ? rate(x.bps) : "no bytes"}
                    meta={[
                      i.type === "pod" ? i.sub : "",
                      where.length
                        ? where.length > 2
                          ? `${where.length} machines`
                          : where.join(", ")
                        : "",
                      ports(x.ports),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                    onClick={i.go ? () => go(i.go!) : undefined}
                  />
                  {more ? (
                    <Button
                      size="small"
                      sx={{ minWidth: 0, p: 0, width: 26, height: 26 }}
                      aria-expanded={open}
                      aria-label={`${open ? "Collapse" : "Expand"} ${i.name}`}
                      onClick={() =>
                        setExpanded((cur) => new Map(cur).set(key, !open))
                      }
                    >
                      {open ? "−" : "+"}
                    </Button>
                  ) : null}
                </Box>
                {open ? (
                  <Box
                    sx={{
                      pl: 1.5,
                      ml: 1,
                      borderLeft: 1,
                      borderColor: "divider",
                    }}
                  >
                    {tree(x.id, dir, depth + 1, [...path, x.id])}
                  </Box>
                ) : null}
              </Box>
            );
          })}
          {list.length > top.length ? (
            <Empty>{`+${list.length - top.length} more`}</Empty>
          ) : null}
        </>
      );
    };
    const br = blastRadius(graph, id, isService);
    const nsOf = (ids: string[]): number =>
      new Set(ids.map((x) => model.byId.get(x)?.k8s?.namespace ?? x)).size;
    const all = [...br.direct, ...br.indirect];
    const upAll = closure(graph, id, "up");
    const downAll = closure(graph, id, "down");
    const where = (locationsOf.get(id) ?? []).map(locName);
    main = (
      <>
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 1,
            flexWrap: "wrap",
            mb: 1.5,
            color: "text.secondary",
            fontSize: 12,
          }}
        >
          <span>Hops shown</span>
          <ToggleButtonGroup
            size="small"
            exclusive
            value={hops}
            onChange={(_, v: number | null) => {
              if (v) {
                setHops(v);
                setExpanded(new Map());
              }
            }}
            aria-label="Hops shown"
          >
            {[1, 2, 3].map((n) => (
              <ToggleButton key={n} value={n} sx={{ py: 0, px: 1.25 }}>
                {n}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
          <span>
            Use + on a row to go one hop further. Click a row to centre on it.
          </span>
        </Box>
        <Box
          sx={{
            display: "grid",
            gridTemplateColumns: narrow
              ? "minmax(0,1fr)"
              : "minmax(0,1fr) minmax(140px, 200px) minmax(0,1fr)",
            gap: 2,
            alignItems: "start",
          }}
        >
          <Box component="section" aria-label="Upstream" sx={{ minWidth: 0 }}>
            <Heading>Upstream · depends on it</Heading>
            {tree(id, "up", 1, [id])}
          </Box>
          <Box
            sx={{
              border: 2,
              borderColor: "primary.main",
              borderRadius: 1,
              p: 1,
              mt: narrow ? 0 : 4,
              minWidth: 0,
            }}
          >
            <Box
              sx={{
                display: "flex",
                gap: 0.75,
                alignItems: "center",
                minWidth: 0,
              }}
            >
              <Icon type={self.type} />
              <Ellipsis text={self.name} weight={600} />
            </Box>
            <Ellipsis
              text={[self.sub, where.slice(0, 2).join(", ")]
                .filter(Boolean)
                .join(" · ")}
              variant="caption"
              color="text.secondary"
            />
          </Box>
          <Box component="section" aria-label="Downstream" sx={{ minWidth: 0 }}>
            <Heading>Downstream · it depends on</Heading>
            {tree(id, "down", 1, [id])}
          </Box>
        </Box>
      </>
    );
    const node = model.byId.get(id);
    const nodeHref =
      o.links.node && node
        ? safeHref(
            fillTemplate(o.links.node, {
              service: node.id,
              name: node.name,
              host: node.instances[0]?.host ?? "",
              hosts: node.instances.map((i) => i.host).join(","),
            }),
          )
        : undefined;
    side = (
      <>
        <Ellipsis text={self.name} variant="subtitle2" />
        {self.sub ? (
          <Ellipsis text={self.sub} variant="caption" color="text.secondary" />
        ) : null}
        <Kv
          rows={[
            [
              "Runs on",
              where.length
                ? where.length > 2
                  ? `${where.length} places`
                  : where.join(", ")
                : "–",
            ],
            ["Callers", (graph.up.get(id) ?? []).length],
            ["Dependencies", (graph.down.get(id) ?? []).length],
          ]}
        />
        <Heading>Blast radius</Heading>
        <Typography variant="body2">
          <b>{all.length}</b> service{all.length === 1 ? "" : "s"} in{" "}
          {nsOf(all)} namespace{nsOf(all) === 1 ? "" : "s"} lose a dependency if
          it goes down
        </Typography>
        <Kv
          rows={[
            ["Directly", `${br.direct.length} in ${nsOf(br.direct)} ns`],
            ["Through other services", br.indirect.length],
            ...(upAll.has(CLIENTS_ID)
              ? ([["Clients outside", "yes"]] as Array<[string, string]>)
              : []),
          ]}
        />
        <Heading>Only path to</Heading>
        {br.onlyPathTo.length ? (
          br.onlyPathTo.map((x) => {
            const i = info(x.id);
            return (
              <Row
                key={x.id}
                icon={i.type}
                name={i.name}
                rate={x.measured ? rate(x.bps) : "no bytes"}
                onClick={i.go ? () => go(i.go!) : undefined}
              />
            );
          })
        ) : (
          <Empty>No outside system depends on it alone.</Empty>
        )}
        <Note>
          Counted over the flows shown: turn off a filter to include more.{" "}
          {downAll.size} things downstream within reach.
        </Note>
        {nodeHref ? (
          <Box sx={{ mt: 1 }}>
            <Link
              href={nodeHref}
              variant="body2"
              target="_blank"
              rel="noopener noreferrer"
            >
              Open details
            </Link>
          </Box>
        ) : null}
        {model.byId.get(id)?.kind === "internal" ? unreachableButton(id) : null}
      </>
    );
  } else {
    main = <Empty>Nothing here.</Empty>;
    side = null;
  }

  const panelW = narrow ? Math.min(width, 340) : props.panelW;
  const mapW = Math.max(
    100,
    props.panelOpen && !narrow ? width - panelW : width,
  );
  const bodyH = Math.max(100, height - CRUMBS_H);

  return (
    <Box sx={{ width, height, display: "flex", flexDirection: "column" }}>
      <Box
        sx={{
          height: CRUMBS_H,
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          gap: 1,
          px: 1,
          borderTop: 1,
          borderBottom: 1,
          borderColor: "divider",
        }}
      >
        <Box
          component="nav"
          aria-label="Breadcrumbs"
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 0.5,
            minWidth: 0,
            flex: 1,
            overflow: "hidden",
          }}
        >
          {crumbs.map(([label, to], i) => (
            <Box
              key={`${label}-${i}`}
              sx={{
                display: "flex",
                alignItems: "center",
                gap: 0.5,
                minWidth: 0,
                flexShrink: i === crumbs.length - 1 ? 1 : 2,
              }}
            >
              {i > 0 ? (
                <Typography component="span" color="text.secondary">
                  ›
                </Typography>
              ) : null}
              {to && to !== current ? (
                <Tooltip title={label} disableInteractive enterDelay={400}>
                  <Link
                    component="button"
                    variant="body2"
                    onClick={() => go(to)}
                    sx={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      maxWidth: "100%",
                    }}
                  >
                    {label}
                  </Link>
                </Tooltip>
              ) : (
                <Box sx={{ minWidth: 0 }} aria-current="page">
                  <Ellipsis text={label} weight={600} />
                </Box>
              )}
            </Box>
          ))}
        </Box>
        {monRe ? (
          <ToggleButton
            value="mon"
            size="small"
            selected={hideMonitoring}
            onChange={() => setHideMonitoring((v) => !v)}
            sx={{ textTransform: "none", py: 0.1, whiteSpace: "nowrap" }}
          >
            Hide monitoring
          </ToggleButton>
        ) : null}
        <Autocomplete
          size="small"
          options={
            props.mode === "outage"
              ? allOptions.filter((x) => isUnit(outageInput, unitOfGo(x.go)))
              : allOptions
          }
          getOptionLabel={(x) => x.label}
          groupBy={undefined}
          renderOption={(p, x) => (
            <li {...p} key={`${x.go}`}>
              <Box sx={{ minWidth: 0 }}>
                <Ellipsis text={x.label} />
                <Ellipsis
                  text={x.sub}
                  variant="caption"
                  color="text.secondary"
                />
              </Box>
            </li>
          )}
          value={null}
          blurOnSelect
          onChange={(_, x) => {
            if (!x) return;
            if (props.mode === "outage") {
              const u = unitOfGo(x.go);
              setFocus(undefined);
              setDown((d) => new Set([...d, u]));
            } else go(x.go);
          }}
          sx={{ width: narrow ? 140 : 220, flexShrink: 0 }}
          renderInput={(p) => (
            <TextField
              {...p}
              placeholder={
                props.mode === "outage"
                  ? "Mark unreachable…"
                  : "Find a workload…"
              }
              aria-label="Find"
            />
          )}
        />
      </Box>
      <Box sx={{ display: "flex", position: "relative", height: bodyH }}>
        <Box
          ref={scrollRef}
          sx={{ width: mapW, height: bodyH, overflow: "auto", flexShrink: 0 }}
          data-testid="depmap-estate"
        >
          <Box ref={mapRef} sx={{ position: "relative", p: 2, minWidth: 0 }}>
            {drawn.length ? (
              <EdgeLayer
                container={mapRef}
                links={drawn}
                hovered={hovered}
                arrows={arrows}
              />
            ) : null}
            {main}
          </Box>
        </Box>
        {props.panelOpen ? (
          <Box
            component="aside"
            aria-label="Details"
            sx={{
              width: panelW,
              height: bodyH,
              p: 1.5,
              boxSizing: "border-box",
              overflowY: "auto",
              borderLeft: 1,
              borderColor: "divider",
              bgcolor: "background.paper",
              ...(narrow
                ? {
                    position: "absolute",
                    right: 0,
                    top: 0,
                    zIndex: 2,
                    boxShadow: 4,
                  }
                : {}),
            }}
          >
            {side}
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}

import { Mode } from "./dependency-map-chart-types";
import { FailureResult, ServiceState } from "./failure";
import { FREQUENCY_LABELS, escapeHtml, formatAgo, formatBytes } from "./format";
import { CHIP_H, CHIP_W, Layout } from "./layout";
import { DepEdge, DepModel, ServiceNode } from "./model";

/** Colours, all from the MUI theme palette, so light and dark follow the Perses theme. */
export interface Palette {
  text: string;
  textSecondary: string;
  divider: string;
  paper: string;
  background: string;
  error: string;
  warning: string;
  primary: string;
  secondary: string;
  info: string;
  success: string;
  /** Translucent version of a colour. */
  alpha: (color: string, opacity: number) => string;
}

export interface SeriesBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface OptionInput {
  model: DepModel;
  layout: Layout;
  mode: Mode;
  failure?: FailureResult;
  /** Hosts down in the failure scenario (for the chips). */
  down: ReadonlySet<string>;
  /** Selected service (node id) or edge (edge id). */
  selectedNode?: string;
  selectedEdge?: string;
  /** Needs mode: the selected service's transitive callees. */
  needs?: ReadonlySet<string>;
  /** Map mode: every path through the selected service (its hop chain), highlighted. */
  chain?: { nodes: ReadonlySet<string>; edges: ReadonlySet<string> };
  palette: Palette;
  box: SeriesBox;
  nowSeconds: number;
}

export const STATE_LABELS: Record<ServiceState, string> = {
  down: "✕ down",
  broken: "↯ breaks",
  brokenvia: "↯ breaks",
  failover: "⇄ failing over",
  overload: "▲ overloaded",
  degraded: "◐ degraded",
  risk: "△ at risk",
  reduced: "◐ reduced",
  ok: "● ok",
};

export const HA_LABELS: Record<ServiceNode["ha"], string> = {
  single: "single",
  "active-active": "A/A",
  "active-passive": "A/P",
  quorum: "quorum",
};

export function stateColor(s: ServiceState, p: Palette): string {
  switch (s) {
    case "down":
    case "broken":
    case "brokenvia":
      return p.error;
    case "failover":
    case "overload":
    case "degraded":
    case "risk":
      return p.warning;
    case "reduced":
      return p.info;
    case "ok":
      return p.divider;
  }
}

const portId = (id: string, side: "L" | "R"): string => `port:${side}:${id}`;
/**
 * Id of an instance chip. Carries the service, because one host can be an instance of two map nodes
 * (a Kubernetes node is in its cluster's node group and in its "via node (NAT)" node), and ECharts
 * needs unique ids.
 */
export const chipId = (service: string, host: string): string =>
  `chip:${service}|${host}`;
/** Service and host of a chip id (hosts never contain "|"). */
export function parseChipId(id: string): { service: string; host: string } {
  const rest = id.slice(5);
  const i = rest.lastIndexOf("|");
  return { service: rest.slice(0, i), host: rest.slice(i + 1) };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function edgeWidth(e: DepEdge): number {
  if (e.bytesPerDay !== undefined && e.bytesPerDay > 0)
    return clamp(1 + Math.log10(1 + e.bytesPerDay / 1e5), 1, 6);
  return { constantly: 2.6, hourly: 2, daily: 1.6, weekly: 1.3, monthly: 1.2 }[
    e.frequency
  ];
}

export function nodeSubtitle(n: ServiceNode): string {
  if (n.kind === "unknown") return "? find owner";
  if (n.kind === "external")
    return n.owner ? `external · ${n.owner}` : "external";
  if (n.k8s?.type === "nat") return "SNAT · pod unknown";
  if (n.k8s?.type === "nodes") return "Kubernetes nodes";
  const parts = [
    n.k8s?.namespace,
    n.process,
    n.instances.length > 1 ? HA_LABELS[n.ha] : undefined,
  ].filter(Boolean);
  return parts.join(" · ") || HA_LABELS[n.ha];
}

function nodeTooltip(n: ServiceNode, f: FailureResult | undefined): string {
  const rows: string[] = [`<b>${escapeHtml(n.name)}</b>`];
  if (n.kind === "unknown")
    rows.push("Not in the mapping: find its owner and add it.");
  if (n.owner) rows.push(`Owner: ${escapeHtml(n.owner)}`);
  if (n.k8s) {
    const k = n.k8s;
    rows.push(
      `Kubernetes · ${escapeHtml(k.cluster)}${k.namespace ? ` · ${escapeHtml(k.namespace)}` : ""}${
        k.workload ? ` · ${escapeHtml(k.workload)}` : ""
      }`,
    );
    if (k.type === "nat")
      rows.push(
        `Traffic that left node ${escapeHtml(k.node ?? "")} SNATed to its address, and no pod-side flow explains it (no OBI on that node then).`,
      );
    if (n.replicas) rows.push(`Replicas: ${n.replicas}`);
  }
  if (n.kind === "internal") {
    if (!n.k8s)
      rows.push(n.wave > 0 ? `Wave ${n.wave}` : "Stays in the old DC");
    rows.push(
      `HA: ${escapeHtml(HA_LABELS[n.ha])}${n.load !== undefined ? ` · load ${n.load}%` : ""}${
        n.vip ? ` · VIP ${escapeHtml(n.vip)}` : ""
      }`,
    );
    rows.push(
      n.instances
        .map((i) => `${escapeHtml(i.host)} ${escapeHtml(i.ip)}`)
        .join("<br/>"),
    );
  }
  const s = f?.services.get(n.id);
  if (s && s.state !== "ok")
    rows.push(
      `<b>${escapeHtml(STATE_LABELS[s.state])}</b>: ${escapeHtml(s.reason)}`,
    );
  return rows.join("<br/>");
}

export function edgeTooltip(
  e: DepEdge,
  model: DepModel,
  nowSeconds: number,
): string {
  const a = model.byId.get(e.source)?.name ?? e.source;
  const b = model.byId.get(e.target)?.name ?? e.target;
  const rows = [
    `<b>${escapeHtml(a)} → ${escapeHtml(b)}</b> :${e.port}`,
    `${FREQUENCY_LABELS[e.frequency]}: seen in ${e.hoursSeen} of ${model.windowHours} hours (${(
      e.share * 100
    ).toFixed(e.share < 0.01 ? 2 : 1)}%)`,
    `Last seen ${formatAgo(e.lastSeen, nowSeconds)}`,
  ];
  if (e.bytesPerDay !== undefined)
    rows.push(`${formatBytes(e.bytesPerDay)} per day`);
  if (e.processes.length)
    rows.push(`Process: ${escapeHtml(e.processes.join(", "))}`);
  if (e.crosses?.length)
    rows.push(`Ranges: ${escapeHtml(e.crosses.join(", "))}`);
  for (const [c, callee] of Object.entries(e.pins))
    rows.push(
      `<b>Hard-wired</b>: ${escapeHtml(c)} only uses ${escapeHtml(callee)}`,
    );
  return rows.join("<br/>");
}

/**
 * The ECharts option. Lanes, services, instance chips and invisible ports are all nodes of one graph
 * series laid out by us (`layout: "none"`), so pan and zoom move everything together. Sizes are layout
 * units times the scale fitBox picked; `nodeScaleRatio: 1` keeps them in proportion while zooming.
 */
export function buildOption(input: OptionInput): object {
  const {
    model,
    layout,
    mode,
    failure,
    down,
    selectedNode,
    selectedEdge,
    needs,
    chain,
    palette: p,
    box,
  } = input;
  const s = layout.width > 0 ? box.width / layout.width : 1;
  const font = (px: number): number => clamp(Math.round(px * s), 7, px);
  const failing = mode === "failure" && failure;
  const needing = mode === "needs" && selectedNode && needs;
  const chaining = mode === "map" && selectedNode && chain;

  const data: object[] = [];
  // Corners pin the bounding box to the whole layout, lanes included.
  for (const [id, x, y] of [
    ["corner:0", 0, 0],
    ["corner:1", layout.width, layout.height],
  ] as const)
    data.push({
      id,
      name: id,
      x,
      y,
      symbolSize: 0,
      label: { show: false },
      tooltip: { show: false },
    });

  for (const lane of layout.lanes) {
    const w = lane.x1 - lane.x0;
    const h = lane.y1 - lane.y0;
    data.push({
      id: `lane:${lane.key}`,
      name: lane.label,
      x: lane.x0 + w / 2,
      y: lane.y0 + h / 2,
      symbol: "roundRect",
      symbolSize: [w * s, h * s],
      itemStyle: {
        color: p.alpha(
          lane.key === "ext"
            ? p.secondary
            : lane.key.startsWith("k8s:")
              ? p.info
              : p.primary,
          lane.key.startsWith("k8s:") ? 0.07 : 0.04,
        ),
        borderColor: p.alpha(p.text, 0.12),
        borderWidth: 1,
      },
      label: {
        show: true,
        position: "insideTop",
        distance: 10 * s,
        color: p.textSecondary,
        fontSize: font(13),
        fontWeight: 600,
        formatter: lane.label,
      },
      tooltip: { show: false },
      emphasis: { disabled: true },
      cursor: "default",
      z: 0,
    });
  }

  const visible = new Set(model.nodes.map((n) => n.id));
  for (const n of model.nodes) {
    const pos = layout.nodes.get(n.id);
    if (!pos) continue;
    const st = failing ? failure.services.get(n.id) : undefined;
    const state = st?.state ?? "ok";
    const isSel = selectedNode === n.id;
    const needed = needing ? needs.has(n.id) : false;
    let border =
      n.kind === "unknown"
        ? p.warning
        : n.kind === "external"
          ? p.secondary
          : p.alpha(p.text, 0.35);
    let fill = p.paper;
    let dash: "solid" | "dashed" = n.kind === "unknown" ? "dashed" : "solid";
    let faded = false;
    let line2 = nodeSubtitle(n);
    if (failing) {
      border = state === "ok" ? p.alpha(p.text, 0.25) : stateColor(state, p);
      if (state !== "ok")
        fill = p.alpha(stateColor(state, p), state === "down" ? 0.22 : 0.1);
      if (state === "brokenvia" || state === "risk") dash = "dashed";
      faded = state === "ok";
      if (state !== "ok")
        line2 = `${STATE_LABELS[state]}${st?.reason ? ` · ${st.reason}` : ""}`;
    } else if (needing) {
      faded = !needed && !isSel;
      if (needed) {
        border = p.primary;
        line2 = `● needed · ${nodeSubtitle(n)}`;
      }
    } else if (chaining) {
      const on = chain.nodes.has(n.id);
      faded = !on;
      if (on && !isSel) border = p.primary;
    }
    if (isSel) border = p.primary;
    data.push({
      id: n.id,
      name: n.name,
      x: pos.x,
      y: pos.y,
      symbol: "roundRect",
      symbolSize: [pos.w * s, pos.h * s],
      itemStyle: {
        color: fill,
        borderColor: border,
        borderWidth: isSel ? 3 : 1.5,
        borderType: dash,
        opacity: faded ? 0.45 : 1,
      },
      label: {
        show: true,
        position: "insideTop",
        distance: 8 * s,
        width: (pos.w - 16) * s,
        overflow: "truncate",
        formatter: `{name|${n.name}}\n{sub|${line2}}`,
        rich: {
          name: {
            fontSize: font(14),
            fontWeight: 600,
            color: p.text,
            lineHeight: font(19),
          },
          sub: {
            fontSize: font(11),
            color:
              failing && state !== "ok"
                ? stateColor(state, p)
                : p.textSecondary,
            lineHeight: font(16),
          },
        },
        opacity: faded ? 0.6 : 1,
      },
      raw: { kind: "service", id: n.id },
      tooltipHtml: nodeTooltip(n, failure),
      z: 2,
    });
  }

  for (const c of layout.chips) {
    const n = model.byId.get(c.service);
    if (!n || !visible.has(n.id)) continue;
    const inst = n.instances.find((i) => i.host === c.host);
    const isDown = down.has(c.host);
    const lost =
      failing && failure.services.get(n.id)?.lostInstances.includes(c.host);
    const mark =
      n.ha === "active-passive" && n.instances.length > 1
        ? n.instances[0]?.host === c.host
          ? " P"
          : " S"
        : "";
    const color = isDown ? p.error : lost ? p.warning : p.alpha(p.text, 0.08);
    data.push({
      id: chipId(n.id, c.host),
      name: c.host,
      x: c.x,
      y: c.y,
      symbol: "roundRect",
      symbolSize: [CHIP_W * s, CHIP_H * s],
      itemStyle: {
        color,
        borderColor: isDown ? p.error : p.alpha(p.text, 0.25),
        borderWidth: 1,
      },
      label: {
        show: true,
        position: "inside",
        fontSize: font(10),
        width: (CHIP_W - 4) * s,
        overflow: "truncate",
        color: isDown ? p.paper : p.text,
        formatter: `${isDown ? "✕ " : ""}${c.host}${mark}`,
      },
      raw: { kind: "chip", id: c.host },
      tooltipHtml: `${escapeHtml(c.host)} ${escapeHtml(inst?.ip ?? "")}<br/>${
        isDown
          ? "Down in this scenario. Click to bring it back."
          : "Click to take it down."
      }${lost ? "<br/>Lost: hard-wired to a down instance." : ""}`,
      cursor: "pointer",
      z: 3,
    });
  }

  // Ports on both sides of each service; edges leave and enter on the side facing the other end.
  for (const n of model.nodes) {
    const pos = layout.nodes.get(n.id);
    if (!pos) continue;
    for (const side of ["L", "R"] as const)
      data.push({
        id: portId(n.id, side),
        name: "",
        x: pos.x + (side === "L" ? -pos.w / 2 : pos.w / 2),
        y: pos.y - pos.h / 2 + 22,
        symbolSize: 1,
        itemStyle: { opacity: 0 },
        label: { show: false },
        tooltip: { show: false },
        emphasis: { disabled: true },
      });
  }

  const pairCount = new Map<string, number>();
  const links: object[] = [];
  for (const e of model.edges) {
    const a = layout.nodes.get(e.source);
    const b = layout.nodes.get(e.target);
    if (!a || !b) continue;
    let from: "L" | "R" = "R";
    let to: "L" | "R" = "L";
    if (b.x < a.x) [from, to] = ["L", "R"];
    else if (b.x === a.x) [from, to] = ["R", "R"];
    const pairKey = `${e.source}\u0000${e.target}`;
    const k = pairCount.get(pairKey) ?? 0;
    pairCount.set(pairKey, k + 1);
    const pinned = Object.keys(e.pins).length > 0;
    const rare = e.frequency === "weekly" || e.frequency === "monthly";
    let color = rare ? p.secondary : p.alpha(p.text, 0.45);
    let opacity = 0.9;
    let width = edgeWidth(e);
    if (pinned) color = p.warning;
    if (failing) {
      const fx = failure.edges.get(e.id) ?? "ok";
      if (fx === "cut" || fx === "pinlost") color = p.error;
      else if (fx === "risk") color = p.warning;
      else opacity = 0.25;
      if (fx !== "ok") width += 0.8;
    } else if (needing) {
      const on =
        (e.source === selectedNode || needs.has(e.source)) &&
        needs.has(e.target);
      color = on ? p.primary : color;
      opacity = on ? 1 : 0.15;
    } else if (chaining) {
      const on = chain.edges.has(e.id);
      color = on ? p.primary : color;
      opacity = on ? 1 : 0.15;
      if (on) width += 0.8;
    }
    if (selectedEdge === e.id) {
      color = p.primary;
      width += 1.5;
      opacity = 1;
    }
    links.push({
      source: portId(e.source, from),
      target: portId(e.target, to),
      lineStyle: {
        color,
        width,
        opacity,
        type: pinned ? "dotted" : rare ? "dashed" : "solid",
        curveness: (from === to ? 0.5 : 0.12) + k * 0.12,
      },
      label: {
        show: true,
        formatter: `:${e.port}`,
        fontSize: font(10),
        color: p.textSecondary,
        textBorderColor: p.paper,
        textBorderWidth: 2,
      },
      raw: { id: e.id },
      tooltipHtml: edgeTooltip(e, model, input.nowSeconds),
    });
  }

  return {
    animation: false,
    tooltip: {
      trigger: "item",
      confine: true,
      enterable: false,
      formatter: (params: { data?: { tooltipHtml?: string } }): string =>
        params.data?.tooltipHtml ?? "",
    },
    series: [
      {
        type: "graph",
        layout: "none",
        roam: true,
        draggable: false,
        ...box,
        nodeScaleRatio: 1,
        scaleLimit: { min: 0.2, max: 6 },
        edgeSymbol: ["none", "arrow"],
        edgeSymbolSize: [0, 7],
        emphasis: { focus: "none", scale: false },
        data,
        links,
      },
    ],
  };
}

/** Where the graph goes in the panel, keeping the layout's aspect ratio (see the servicegraph plugin). */
export function fitBox(
  layout: Pick<Layout, "width" | "height">,
  width: number,
  height: number,
  top = 8,
): SeriesBox {
  const pad = 8;
  const availW = Math.max(1, width - 2 * pad);
  const availH = Math.max(1, height - top - pad);
  const scale = Math.min(availW / layout.width, availH / layout.height, 1.4);
  const w = layout.width * scale;
  const h = layout.height * scale;
  return {
    left: pad + (availW - w) / 2,
    top: top + (availH - h) / 2,
    width: w,
    height: h,
  };
}

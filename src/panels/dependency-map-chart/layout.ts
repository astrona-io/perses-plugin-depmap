import { DepEdge, ServiceNode } from "./model";

/**
 * Lanes left to right: one per migration wave (ascending), then one per Kubernetes cluster, then the
 * services that stay in the old data centre, then external and unknown endpoints. A Kubernetes lane sits
 * between the waves and the old DC because that is where hybrid hop chains (VM -> pod -> VM) cross it. Inside a lane, services are ordered by the barycenter of
 * their neighbours so edges cross less; a lane with many services splits into sub-columns.
 *
 * Coordinates are abstract layout units; the panel scales them to pixels as a whole (see fitBox).
 */

export const NODE_W = 210;
export const NODE_HEAD = 62;
export const CHIP_W = 62;
export const CHIP_H = 18;
export const CHIP_GAP = 6;
export const CHIPS_PER_ROW = 3;
export const ROW_GAP = 22;
export const LANE_PAD = 22;
export const LANE_GAP = 26;
export const TITLE_H = 44;
export const MAX_ROWS = 14;

export interface LaneSpec {
  key: string;
  label: string;
}

export interface PlacedLane extends LaneSpec {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

export interface PlacedNode {
  id: string;
  lane: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PlacedChip {
  service: string;
  host: string;
  x: number;
  y: number;
}

export interface Layout {
  lanes: PlacedLane[];
  nodes: Map<string, PlacedNode>;
  chips: PlacedChip[];
  width: number;
  height: number;
}

export function laneKeyOf(n: ServiceNode): string {
  if (n.k8s) return `k8s:${n.k8s.cluster}`;
  if (n.kind !== "internal") return "ext";
  return n.wave > 0 ? `w${n.wave}` : "stay";
}

export function laneSpecs(
  nodes: ServiceNode[],
  labels: {
    waveLabels: Record<string, string>;
    stayLabel: string;
    externalLabel: string;
  },
): LaneSpec[] {
  const waves = [
    ...new Set(
      nodes
        .filter((n) => n.kind === "internal" && !n.k8s && n.wave > 0)
        .map((n) => n.wave),
    ),
  ].sort((a, b) => a - b);
  const out: LaneSpec[] = waves.map((w) => ({
    key: `w${w}`,
    label: labels.waveLabels[String(w)] ?? `Wave ${w}`,
  }));
  const clusters = [
    ...new Set(nodes.flatMap((n) => (n.k8s ? [n.k8s.cluster] : []))),
  ].sort();
  for (const c of clusters)
    out.push({ key: `k8s:${c}`, label: `Kubernetes · ${c}` });
  if (nodes.some((n) => laneKeyOf(n) === "stay"))
    out.push({ key: "stay", label: labels.stayLabel });
  if (nodes.some((n) => laneKeyOf(n) === "ext"))
    out.push({ key: "ext", label: labels.externalLabel });
  return out;
}

export function nodeHeight(n: ServiceNode): number {
  const rows = Math.ceil(n.instances.length / CHIPS_PER_ROW);
  return NODE_HEAD + rows * (CHIP_H + CHIP_GAP) + (rows > 0 ? 4 : 0);
}

export function layoutGraph(
  nodes: ServiceNode[],
  edges: DepEdge[],
  lanes: LaneSpec[],
): Layout {
  const byLane = new Map<string, ServiceNode[]>(lanes.map((l) => [l.key, []]));
  for (const n of [...nodes].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  ))
    byLane.get(laneKeyOf(n))?.push(n);

  // Barycenter ordering: a few sweeps, each node moved to the mean rank of its neighbours.
  const neighbours = new Map<string, string[]>();
  for (const e of edges) {
    (
      neighbours.get(e.source) ?? neighbours.set(e.source, []).get(e.source)!
    ).push(e.target);
    (
      neighbours.get(e.target) ?? neighbours.set(e.target, []).get(e.target)!
    ).push(e.source);
  }
  const rank = new Map<string, number>();
  const setRanks = (): void => {
    for (const list of byLane.values())
      list.forEach((n, i) =>
        rank.set(n.id, list.length > 1 ? i / (list.length - 1) : 0.5),
      );
  };
  setRanks();
  for (let sweep = 0; sweep < 4; sweep++) {
    for (const [key, list] of byLane) {
      const score = new Map<string, number>();
      for (const n of list) {
        const ns = (neighbours.get(n.id) ?? []).filter((m) => rank.has(m));
        score.set(
          n.id,
          ns.length > 0
            ? ns.reduce((s, m) => s + rank.get(m)!, 0) / ns.length
            : rank.get(n.id)!,
        );
      }
      const sorted = [...list].sort(
        (a, b) => score.get(a.id)! - score.get(b.id)!,
      );
      byLane.set(key, sorted);
      sorted.forEach((n, i) =>
        rank.set(n.id, sorted.length > 1 ? i / (sorted.length - 1) : 0.5),
      );
    }
  }

  const placed = new Map<string, PlacedNode>();
  const chips: PlacedChip[] = [];
  const placedLanes: PlacedLane[] = [];
  let x = 0;
  let maxBottom = TITLE_H;
  for (const lane of lanes) {
    const list = byLane.get(lane.key) ?? [];
    const cols = Math.max(1, Math.ceil(list.length / MAX_ROWS));
    const perCol = Math.max(1, Math.ceil(list.length / cols));
    const x0 = x;
    for (let c = 0; c < cols; c++) {
      const cx = x0 + LANE_PAD + c * (NODE_W + LANE_PAD) + NODE_W / 2;
      let y = TITLE_H;
      for (const n of list.slice(c * perCol, (c + 1) * perCol)) {
        const h = nodeHeight(n);
        placed.set(n.id, {
          id: n.id,
          lane: lane.key,
          x: cx,
          y: y + h / 2,
          w: NODE_W,
          h,
        });
        n.instances.forEach((inst, i) => {
          const row = Math.floor(i / CHIPS_PER_ROW);
          const inRow = Math.min(
            CHIPS_PER_ROW,
            n.instances.length - row * CHIPS_PER_ROW,
          );
          const col = i % CHIPS_PER_ROW;
          const rowW = inRow * CHIP_W + (inRow - 1) * CHIP_GAP;
          chips.push({
            service: n.id,
            host: inst.host,
            x: cx - rowW / 2 + col * (CHIP_W + CHIP_GAP) + CHIP_W / 2,
            y: y + NODE_HEAD + row * (CHIP_H + CHIP_GAP) + CHIP_H / 2,
          });
        });
        y += h + ROW_GAP;
      }
      maxBottom = Math.max(maxBottom, y);
    }
    x = x0 + LANE_PAD + cols * (NODE_W + LANE_PAD);
    placedLanes.push({ ...lane, x0, x1: x, y0: 0, y1: 0 });
    x += LANE_GAP;
  }
  const height = Math.max(maxBottom, TITLE_H + 80);
  for (const l of placedLanes) l.y1 = height;
  return {
    lanes: placedLanes,
    nodes: placed,
    chips,
    width: Math.max(1, x - LANE_GAP),
    height,
  };
}

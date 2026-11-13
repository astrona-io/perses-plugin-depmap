import { DatasourceSelector } from "@perses-dev/spec";
import {
  DatasourceSelectValue,
  OptionsEditorProps,
  PanelProps,
} from "@perses-dev/plugin-system";

export type DependencyMapChartProps = PanelProps<DependencyMapChartOptions>;
export type DependencyMapChartEditorProps =
  OptionsEditorProps<DependencyMapChartOptions>;

export const PROMETHEUS_DATASOURCE_KIND = "PrometheusDatasource";

/** How often an edge was seen over the window, from most to least often. */
export type Frequency =
  "constantly" | "hourly" | "daily" | "weekly" | "monthly";
export const FREQUENCIES: Frequency[] = [
  "constantly",
  "hourly",
  "daily",
  "weekly",
  "monthly",
];

export type Mode = "map" | "failure" | "needs";

/**
 * Minimum share of the window's hours (0..1) an edge must be seen in to get each class. Anything seen
 * less often than `weekly` is `monthly` (rare).
 */
export interface FrequencyThresholds {
  constantly: number;
  hourly: number;
  daily: number;
  weekly: number;
}

export interface QueryRoles {
  /** OBI network flow query. Empty turns it off. */
  edge?: string;
  /** Fallback script (`depmap_connection_seen`) query. Empty turns it off. */
  fallback?: string;
  /** Optional bytes per hour per edge, when the edge query does not carry bytes. */
  volume?: string;
}

export interface LaneOptions {
  /** Label per wave number, e.g. {"1": "Wave 1 (March)"}. */
  waveLabels?: Record<string, string>;
  /** Label of the "stays in old DC" column. */
  stayLabel?: string;
  /** Label of the external / unknown column. */
  externalLabel?: string;
  /** Show external and unknown nodes. Default true. */
  showExternal?: boolean;
}

export interface LinkTemplates {
  /** Per node, e.g. `/projects/infra/dashboards/host?var-host=${host}`. */
  node?: string;
  /** Per edge, e.g. a firewall request form with `${source}`, `${target}`, `${port}`. */
  edge?: string;
}

export interface Scenario {
  name: string;
  /** Instance hosts (or IPs of unknown nodes) to take down. */
  down: string[];
}

export interface DependencyMapChartOptions {
  /** Prometheus datasource (selector or `$variable`). The default Prometheus datasource when unset. */
  datasource?: DatasourceSelectValue<DatasourceSelector>;
  queries?: QueryRoles;
  /** The mapping file (YAML or JSON): services, instances, owners, waves, HA groups, externals. */
  mapping?: string;
  /** Observation window ending at the dashboard's end time. Default `30d`. */
  window?: string;
  frequencyThresholds?: Partial<FrequencyThresholds>;
  lanes?: LaneOptions;
  /** Frequencies shown when the panel opens. Default all. */
  edgeFilter?: Frequency[];
  linkTemplates?: LinkTemplates;
  /** Preset failure scenarios. When empty, the worst single-server failures are offered. */
  scenarios?: Scenario[];
  /** Mode the panel opens in. Default `map`. */
  defaultMode?: Mode;
}

/**
 * OBI network flows, client to server (`direction="request"`): source address, destination address and
 * the server port, bytes per hour. Needs `src.address`, `dst.address` and `server.port` selected in OBI's
 * `attributes.select` (see collect/obi/config.yaml); `dst.name`, when selected, lets externals match by
 * name.
 */
export const DEFAULT_EDGE_QUERY =
  'sum by (src_address, dst_address, server_port, dst_name) (increase(obi_network_flow_bytes_total{direction="request"}[1h])) > 0';
/** The fallback script's connections, seen at least once per hour. */
export const DEFAULT_FALLBACK_QUERY =
  "max by (src_ip, src_host, src_process, dst_ip, dst_port, direction) (max_over_time(depmap_connection_seen[1h]))";
export const DEFAULT_WINDOW = "30d";
export const DEFAULT_THRESHOLDS: FrequencyThresholds = {
  constantly: 0.9,
  hourly: 0.2,
  daily: 0.02,
  weekly: 0.004,
};
export const DEFAULT_STAY_LABEL = "Stays in old DC";
export const DEFAULT_EXTERNAL_LABEL = "External / unknown";

export interface ResolvedOptions {
  queries: Required<QueryRoles>;
  mapping: string;
  window: string;
  thresholds: FrequencyThresholds;
  waveLabels: Record<string, string>;
  stayLabel: string;
  externalLabel: string;
  showExternal: boolean;
  edgeFilter: Frequency[];
  links: LinkTemplates;
  scenarios: Scenario[];
  defaultMode: Mode;
}

export function resolveOptions(
  spec: DependencyMapChartOptions,
): ResolvedOptions {
  const q = spec.queries ?? {};
  return {
    queries: {
      edge: q.edge ?? DEFAULT_EDGE_QUERY,
      fallback: q.fallback ?? DEFAULT_FALLBACK_QUERY,
      volume: q.volume ?? "",
    },
    mapping: spec.mapping ?? "",
    window: spec.window || DEFAULT_WINDOW,
    thresholds: { ...DEFAULT_THRESHOLDS, ...(spec.frequencyThresholds ?? {}) },
    waveLabels: spec.lanes?.waveLabels ?? {},
    stayLabel: spec.lanes?.stayLabel || DEFAULT_STAY_LABEL,
    externalLabel: spec.lanes?.externalLabel || DEFAULT_EXTERNAL_LABEL,
    showExternal: spec.lanes?.showExternal ?? true,
    edgeFilter:
      spec.edgeFilter && spec.edgeFilter.length > 0
        ? spec.edgeFilter
        : [...FREQUENCIES],
    links: spec.linkTemplates ?? {},
    scenarios: spec.scenarios ?? [],
    defaultMode: spec.defaultMode ?? "map",
  };
}

export function createInitialDependencyMapChartOptions(): DependencyMapChartOptions {
  return {
    queries: { edge: DEFAULT_EDGE_QUERY, fallback: DEFAULT_FALLBACK_QUERY },
    window: DEFAULT_WINDOW,
    mapping: "services: []\n",
  };
}

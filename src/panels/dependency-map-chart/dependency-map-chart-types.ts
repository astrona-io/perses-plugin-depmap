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

/** map: the estate drill-down; outage: "If unreachable", mark units as down and see the impact. */
export type Mode = "map" | "outage";

/** Rates are shown per second, minute or hour; `auto` picks per value. */
export type RateUnit = "s" | "min" | "h" | "auto";
export const RATE_UNITS: RateUnit[] = ["s", "min", "h", "auto"];

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

/** Only `showExternal` is used since v0.4.0, when the lanes view was removed; the rest still loads. */
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
  /** Ignored since v0.4.0: no view selects a single edge any more. */
  edge?: string;
}

/** Ignored since v0.4.0; kept so saved panels still load. */
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
  /**
   * Observation window ending at the dashboard's end time, e.g. `30d`. Default: the dashboard's time
   * range. Rates and frequencies are computed over it.
   */
  window?: string;
  frequencyThresholds?: Partial<FrequencyThresholds>;
  lanes?: LaneOptions;
  /** Frequencies shown when the panel opens. Default all. */
  edgeFilter?: Frequency[];
  linkTemplates?: LinkTemplates;
  /** Ignored since v0.4.0: the outage view ranks every unit tried alone instead. */
  scenarios?: Scenario[];
  /**
   * Mode the panel opens in. Default `map`. Panels saved before v0.4.0 may hold `failure` (opens as
   * `outage`) or `needs` (opens as `map`).
   */
  defaultMode?: Mode | "failure" | "needs";
  /** Ignored since v0.4.0, when the lanes view was removed. */
  defaultView?: "estate" | "lanes";
  /** Unit rates open in. Default `s` (per second). */
  rateUnit?: RateUnit;
  /** Label holding the Kubernetes cluster name. Default `k8s_cluster_name`. */
  clusterLabel?: string;
  /** Name of the cluster when no sample carries the cluster label. Default `kubernetes`. */
  clusterName?: string;
  /** Internet addresses listed by name on a provider's page; the rest are counted. Default 40. */
  internetTopAddresses?: number;
  /**
   * Regular expression over namespace and workload names that marks monitoring traffic, which the
   * "Hide monitoring" switch hides. Empty turns the switch off.
   */
  monitoringPattern?: string;
}

/**
 * OBI network flows, client to server (`direction="request"`): source address, destination address and
 * the server port, bytes per hour. Needs `src.address`, `dst.address` and `server.port` selected in OBI's
 * `attributes.select` (see collect/obi/config.yaml); `dst.name`, when selected, lets externals match by
 * name.
 */
export const DEFAULT_EDGE_QUERY =
  'max by (src_address, dst_address, server_port, dst_name, src_cidr, dst_cidr, k8s_cluster_name, k8s_src_type, k8s_src_namespace, k8s_src_name, k8s_src_owner_name, k8s_src_owner_type, k8s_src_node_name, k8s_src_node_ip, k8s_dst_type, k8s_dst_namespace, k8s_dst_name, k8s_dst_owner_name, k8s_dst_owner_type, k8s_dst_node_name, k8s_dst_node_ip) (increase(obi_network_flow_bytes_total{direction="request"}[1h])) > 0';
/** The fallback script's connections, seen at least once per hour. */
export const DEFAULT_FALLBACK_QUERY =
  "max by (src_ip, src_host, src_process, dst_ip, dst_port, direction) (max_over_time(depmap_connection_seen[1h]))";
export const DEFAULT_CLUSTER_LABEL = "k8s_cluster_name";
export const DEFAULT_CLUSTER_NAME = "kubernetes";
export const DEFAULT_INTERNET_TOP = 40;
export const DEFAULT_MONITORING_PATTERN =
  "prometheus|grafana|alloy|otel|opentelemetry|vmagent|vmsingle|vmalert|victoria|node-exporter|kube-state-metrics|fluent-bit|loki|tempo|pyroscope|^obi";
export const DEFAULT_THRESHOLDS: FrequencyThresholds = {
  constantly: 0.9,
  hourly: 0.2,
  daily: 0.02,
  weekly: 0.004,
};

export interface ResolvedOptions {
  queries: Required<QueryRoles>;
  mapping: string;
  window: string;
  thresholds: FrequencyThresholds;
  showExternal: boolean;
  edgeFilter: Frequency[];
  links: LinkTemplates;
  defaultMode: Mode;
  rateUnit: RateUnit;
  clusterLabel: string;
  clusterName: string;
  internetTop: number;
  monitoringPattern: string;
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
    window: spec.window ?? "",
    thresholds: { ...DEFAULT_THRESHOLDS, ...(spec.frequencyThresholds ?? {}) },
    showExternal: spec.lanes?.showExternal ?? true,
    edgeFilter:
      spec.edgeFilter && spec.edgeFilter.length > 0
        ? spec.edgeFilter
        : [...FREQUENCIES],
    links: spec.linkTemplates ?? {},
    defaultMode:
      spec.defaultMode === "outage" || spec.defaultMode === "failure"
        ? "outage"
        : "map",
    rateUnit: spec.rateUnit ?? "s",
    clusterLabel: spec.clusterLabel || DEFAULT_CLUSTER_LABEL,
    clusterName: spec.clusterName || DEFAULT_CLUSTER_NAME,
    internetTop:
      spec.internetTopAddresses !== undefined && spec.internetTopAddresses >= 0
        ? Math.floor(spec.internetTopAddresses)
        : DEFAULT_INTERNET_TOP,
    monitoringPattern: spec.monitoringPattern ?? DEFAULT_MONITORING_PATTERN,
  };
}

export function createInitialDependencyMapChartOptions(): DependencyMapChartOptions {
  return {
    queries: { edge: DEFAULT_EDGE_QUERY, fallback: DEFAULT_FALLBACK_QUERY },
    mapping: "services: []\n",
  };
}

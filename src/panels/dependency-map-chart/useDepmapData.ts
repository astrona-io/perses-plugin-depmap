import { useQuery } from "@tanstack/react-query";
import {
  replaceVariablesInString,
  useAllVariableValues,
  useDatasourceClient,
  useDatasourceSelectValueToSelector,
  useTimeRange,
} from "@perses-dev/plugin-system";
import {
  DependencyMapChartOptions,
  PROMETHEUS_DATASOURCE_KIND,
  ResolvedOptions,
} from "./dependency-map-chart-types";
import { Mapping } from "./mapping";
import { EdgeSample } from "./model";
import {
  MAX_WINDOW_SECONDS,
  MatrixSeries,
  STEP_SECONDS,
  parseDuration,
  seriesToSamples,
} from "./queries";

/**
 * The part of the Prometheus datasource client this panel uses. Declared here rather than imported, so
 * the plugin does not bundle or depend on the Prometheus plugin: the client comes from the datasource
 * at runtime through `useDatasourceClient`.
 */
interface PromResponse<T> {
  status: string;
  error?: string;
  data?: { resultType: string; result: T[] };
}
interface PrometheusLikeClient {
  rangeQuery?: (params: {
    query: string;
    start: number;
    end: number;
    step: number;
  }) => Promise<PromResponse<MatrixSeries>>;
  instantQuery?: (params: {
    query: string;
    time?: number;
  }) => Promise<
    PromResponse<{ metric: Record<string, string>; value: [number, string] }>
  >;
}

export interface DepmapResults {
  samples: EdgeSample[];
  volume: EdgeSample[];
  loads: Record<string, number>;
  /** Which collectors returned data. */
  sources: { obi: boolean; fallback: boolean };
}

export interface DepmapData {
  results?: DepmapResults;
  windowHours: number;
  endSeconds: number;
  isLoading: boolean;
  error?: Error;
}

/**
 * Runs the edge queries as range queries over the window (one-hour steps, ending at the dashboard's end
 * time; the dashboard's time range unless the panel sets a window) and each service's `loadQuery` as an instant query. Variables are expanded in every query.
 */
export function useDepmapData(
  spec: DependencyMapChartOptions,
  o: ResolvedOptions,
  mapping: Mapping,
): DepmapData {
  const selector = useDatasourceSelectValueToSelector(
    spec.datasource ?? { kind: PROMETHEUS_DATASOURCE_KIND },
    PROMETHEUS_DATASOURCE_KIND,
  );
  const client = useDatasourceClient<PrometheusLikeClient>(selector);
  const { absoluteTimeRange } = useTimeRange();
  const variables = useAllVariableValues();
  const expand = (s: string): string =>
    s ? replaceVariablesInString(s, variables).trim() : "";

  const end = Math.floor(absoluteTimeRange.end.getTime() / 1000);
  const rangeSeconds =
    end - Math.floor(absoluteTimeRange.start.getTime() / 1000);
  // The dashboard's time range unless the panel sets its own window.
  const windowSeconds = Math.min(
    MAX_WINDOW_SECONDS,
    Math.max(STEP_SECONDS, parseDuration(expand(o.window)) ?? rangeSeconds),
  );
  const windowHours = Math.round(windowSeconds / STEP_SECONDS);
  const edgeQuery = expand(o.queries.edge);
  const fallbackQuery = expand(o.queries.fallback);
  const volumeQuery = expand(o.queries.volume);
  const loadQueries = mapping.services
    .filter((s) => s.loadQuery)
    .map((s) => [s.id, expand(s.loadQuery!)] as const);
  // Re-run at most once a minute while the end time moves (relative ranges refresh).
  const endBucket = Math.floor(end / 60);

  const result = useQuery<DepmapResults, Error>({
    queryKey: [
      "DependencyMapChart",
      selector,
      edgeQuery,
      fallbackQuery,
      volumeQuery,
      loadQueries,
      windowSeconds,
      endBucket,
      o.clusterLabel,
    ],
    enabled: client.isSuccess,
    keepPreviousData: true,
    queryFn: async () => {
      const c = client.data;
      if (!c?.rangeQuery)
        throw new Error(
          "The selected datasource is not a Prometheus datasource (no range query support).",
        );
      if (!edgeQuery && !fallbackQuery)
        throw new Error(
          "Both the edge query and the fallback query are empty: set at least one.",
        );
      const start = end - windowSeconds + STEP_SECONDS;
      const range = async (query: string): Promise<MatrixSeries[]> => {
        if (!query) return [];
        const res = await c.rangeQuery!({
          query,
          start,
          end,
          step: STEP_SECONDS,
        });
        if (res.status !== "success")
          throw new Error(res.error || `Query failed: ${query}`);
        return res.data?.resultType === "matrix" ? res.data.result : [];
      };
      const instant = async (query: string): Promise<number | undefined> => {
        if (!c.instantQuery) return undefined;
        const res = await c.instantQuery({ query, time: end });
        if (res.status !== "success")
          throw new Error(res.error || `Query failed: ${query}`);
        const v = Number(res.data?.result?.[0]?.value?.[1]);
        return Number.isFinite(v) ? v : undefined;
      };
      const [obi, fallback, volume, ...loadValues] = await Promise.all([
        range(edgeQuery),
        range(fallbackQuery),
        range(volumeQuery),
        ...loadQueries.map(([, q]) => instant(q)),
      ]);
      const loads: Record<string, number> = {};
      loadQueries.forEach(([id], i) => {
        const v = loadValues[i];
        if (v !== undefined) loads[id] = v;
      });
      const obiSamples = seriesToSamples(obi, true, o.clusterLabel);
      const fallbackSamples = seriesToSamples(fallback, false, o.clusterLabel);
      return {
        samples: [...obiSamples, ...fallbackSamples],
        volume: seriesToSamples(volume, true, o.clusterLabel),
        loads,
        sources: {
          obi: obiSamples.length > 0,
          fallback: fallbackSamples.length > 0,
        },
      };
    },
  });

  return {
    results: result.data,
    windowHours,
    endSeconds: end,
    isLoading:
      client.isLoading || (result.isLoading && result.fetchStatus !== "idle"),
    error: (client.error as Error | null) ?? result.error ?? undefined,
  };
}

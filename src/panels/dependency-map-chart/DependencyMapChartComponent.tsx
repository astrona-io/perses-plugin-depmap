import { ReactElement, useMemo } from "react";
import { Box, Typography } from "@mui/material";
import { LoadingOverlay } from "@perses-dev/components";
import {
  DependencyMapChartProps,
  resolveOptions,
} from "./dependency-map-chart-types";
import { DependencyMapView } from "./DependencyMapView";
import { parseMapping } from "./mapping";
import { buildModel } from "./model";
import { useDepmapData } from "./useDepmapData";

function Message({
  children,
  color,
}: {
  children: string;
  color?: string;
}): ReactElement {
  return (
    <Typography
      sx={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        p: 2,
        color: color ?? "text.secondary",
      }}
    >
      {children}
    </Typography>
  );
}

export function DependencyMapChartComponent(
  props: DependencyMapChartProps,
): ReactElement | null {
  const { spec, contentDimensions } = props;
  const o = useMemo(() => resolveOptions(spec), [spec]);
  const parsed = useMemo(() => parseMapping(o.mapping), [o.mapping]);
  const data = useDepmapData(spec, o, parsed.mapping);

  const model = useMemo(
    () =>
      data.results
        ? buildModel(
            parsed.mapping,
            data.results.samples,
            o.thresholds,
            data.windowHours,
            {
              volume: data.results.volume,
              loads: data.results.loads,
              clusterName: o.clusterName,
            },
          )
        : undefined,
    [
      data.results,
      parsed.mapping,
      o.thresholds,
      data.windowHours,
      o.clusterName,
    ],
  );

  if (!contentDimensions) return null;
  const { width, height } = contentDimensions;

  let message: string | undefined;
  let color: string | undefined;
  if (data.error) {
    message = data.error.message;
    color = "error.main";
  } else if (parsed.mapping.services.length === 0 && parsed.errors.length > 0) {
    message = `The mapping could not be read: ${parsed.errors.slice(0, 3).join("; ")}`;
    color = "error.main";
  } else if (model && model.edges.length === 0 && model.nodes.length === 0) {
    message =
      "No connections seen in the window, and the mapping lists no services.";
  } else if (model && model.edges.length === 0) {
    message =
      "No connections seen in the window. Check that OBI or the fallback script is running and its metrics reach this Prometheus.";
  }

  return (
    <Box sx={{ position: "relative", width, height }}>
      {data.isLoading && !model ? <LoadingOverlay /> : null}
      {message ? <Message color={color}>{message}</Message> : null}
      {model && !message ? (
        <DependencyMapView
          model={model}
          o={o}
          mapping={parsed.mapping}
          mappingErrors={parsed.errors}
          width={width}
          height={height}
          sources={data.results?.sources}
        />
      ) : null}
    </Box>
  );
}

import { ReactElement, useMemo } from "react";
import { Box, Typography, alpha, useTheme } from "@mui/material";
import { LoadingOverlay, useChartsTheme } from "@perses-dev/components";
import {
  DependencyMapChartProps,
  resolveOptions,
} from "./dependency-map-chart-types";
import { DependencyMapView } from "./DependencyMapView";
import { Palette } from "./chart-option";
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
  const theme = useTheme();
  const chartsTheme = useChartsTheme();
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

  const palette: Palette = useMemo(
    () => ({
      text: theme.palette.text.primary,
      textSecondary: theme.palette.text.secondary,
      divider: theme.palette.divider,
      paper: theme.palette.background.paper,
      background: theme.palette.background.default,
      error: theme.palette.error.main,
      warning: theme.palette.warning.main,
      primary: theme.palette.primary.main,
      secondary: theme.palette.secondary.main,
      info: theme.palette.info.main,
      success: theme.palette.success.main,
      alpha: (c, a) => alpha(c, a),
    }),
    [theme],
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
          mappingText={o.mapping}
          mappingErrors={parsed.errors}
          palette={palette}
          echartsTheme={chartsTheme.echartsTheme}
          width={width}
          height={height}
          nowSeconds={data.endSeconds}
          sources={data.results?.sources}
        />
      ) : null}
    </Box>
  );
}

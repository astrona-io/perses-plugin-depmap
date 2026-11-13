import { ReactElement, useEffect, useMemo, useState } from "react";
import {
  Box,
  Checkbox,
  FormControlLabel,
  IconButton,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from "@mui/material";
import {
  FREQUENCIES,
  Frequency,
  Mode,
  RATE_UNITS,
  RateUnit,
  ResolvedOptions,
} from "./dependency-map-chart-types";
import { buildEstate } from "./estate";
import { EstateView } from "./EstateView";
import { FREQUENCY_LABELS } from "./format";
import { Mapping } from "./mapping";
import { DepModel } from "./model";

export interface DependencyMapViewProps {
  model: DepModel;
  o: ResolvedOptions;
  /** The parsed mapping: places for the estate view. */
  mapping: Mapping;
  /** Lines of the mapping that could not be read; the rest still applies. */
  mappingErrors: string[];
  width: number;
  height: number;
  /** Which collectors returned data, shown in the toolbar. */
  sources?: { obi: boolean; fallback: boolean };
}

const TOOLBAR_H = 44;
const RATE_LABELS: Record<RateUnit, string> = {
  s: "/s",
  min: "/min",
  h: "/h",
  auto: "Auto",
};
/** Below this panel width the side panel covers the map instead of sitting beside it. */
export const NARROW = 720;

/**
 * The interactive panel body: toolbar, then the estate view in map or "If unreachable" mode. Pure on
 * its inputs (no queries), so it is rendered directly in tests.
 */
export function DependencyMapView(props: DependencyMapViewProps): ReactElement {
  const { o, model, width, height } = props;
  const [mode, setMode] = useState<Mode>(o.defaultMode);
  const [rateUnit, setRateUnit] = useState<RateUnit>(o.rateUnit);
  const [shown, setShown] = useState<Set<Frequency>>(
    () => new Set(o.edgeFilter),
  );
  const narrow = width < NARROW;
  const [panelOpen, setPanelOpen] = useState(!narrow);

  useEffect(() => setMode(o.defaultMode), [o.defaultMode]);
  useEffect(() => setShown(new Set(o.edgeFilter)), [o.edgeFilter]);
  useEffect(() => setRateUnit(o.rateUnit), [o.rateUnit]);

  // Edges after the frequency filter; external and unknown nodes dropped when asked.
  const view = useMemo(() => {
    const hidden = new Set(
      o.showExternal
        ? []
        : model.nodes.filter((n) => n.kind !== "internal").map((n) => n.id),
    );
    const edges = model.edges.filter(
      (e) =>
        shown.has(e.frequency) &&
        !hidden.has(e.source) &&
        !hidden.has(e.target),
    );
    return { edges, hiddenEdges: model.edges.length - edges.length };
  }, [model, shown, o.showExternal]);

  const estate = useMemo(
    () => buildEstate(model, props.mapping),
    [model, props.mapping],
  );

  const panelW = Math.round(Math.min(380, Math.max(280, width * 0.3)));
  const mapH = Math.max(100, height - TOOLBAR_H);

  const source =
    props.sources?.obi && props.sources.fallback
      ? "OBI + fallback"
      : props.sources?.obi
        ? "OBI"
        : props.sources?.fallback
          ? "fallback script"
          : undefined;

  return (
    <Box
      sx={{
        position: "relative",
        width,
        height,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <Stack
        direction="row"
        alignItems="center"
        spacing={1}
        sx={{
          height: TOOLBAR_H,
          px: 1,
          overflowX: "auto",
          overflowY: "hidden",
          flexShrink: 0,
        }}
      >
        <ToggleButtonGroup
          size="small"
          exclusive
          value={mode}
          onChange={(_, v: Mode | null) => v && setMode(v)}
          aria-label="Mode"
        >
          <ToggleButton value="map" sx={{ textTransform: "none", py: 0.25 }}>
            Map
          </ToggleButton>
          <ToggleButton
            value="outage"
            sx={{ textTransform: "none", py: 0.25, whiteSpace: "nowrap" }}
          >
            If unreachable
          </ToggleButton>
        </ToggleButtonGroup>
        {FREQUENCIES.map((f) => (
          <FormControlLabel
            key={f}
            sx={{
              mr: 0,
              whiteSpace: "nowrap",
              "& .MuiFormControlLabel-label": { fontSize: 13 },
            }}
            control={
              <Checkbox
                size="small"
                sx={{ p: 0.5 }}
                checked={shown.has(f)}
                onChange={() =>
                  setShown((cur) => {
                    const next = new Set(cur);
                    if (next.has(f)) next.delete(f);
                    else next.add(f);
                    return next;
                  })
                }
              />
            }
            label={FREQUENCY_LABELS[f]}
          />
        ))}
        <Box sx={{ flexGrow: 1 }} />
        <ToggleButtonGroup
          size="small"
          exclusive
          value={rateUnit}
          onChange={(_, v: RateUnit | null) => v && setRateUnit(v)}
          aria-label="Rate unit"
        >
          {RATE_UNITS.map((u) => (
            <ToggleButton
              key={u}
              value={u}
              sx={{ textTransform: "none", py: 0.25, px: 0.75 }}
            >
              {RATE_LABELS[u]}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
        {props.mappingErrors.length > 0 ? (
          <Tooltip title={props.mappingErrors.slice(0, 10).join("\n")}>
            <Typography
              variant="caption"
              color="error"
              sx={{ whiteSpace: "nowrap" }}
            >
              {props.mappingErrors.length} mapping error
              {props.mappingErrors.length === 1 ? "" : "s"}
            </Typography>
          </Tooltip>
        ) : null}
        {view.hiddenEdges > 0 ? (
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ whiteSpace: "nowrap" }}
          >
            {view.hiddenEdges} hidden
          </Typography>
        ) : null}
        {source ? (
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ whiteSpace: "nowrap" }}
          >
            {source}
          </Typography>
        ) : null}
        <Tooltip title={panelOpen ? "Hide details" : "Show details"}>
          <IconButton
            size="small"
            aria-label={panelOpen ? "Hide details" : "Show details"}
            aria-expanded={panelOpen}
            onClick={() => setPanelOpen((v) => !v)}
          >
            <Box component="span" sx={{ fontSize: 16, lineHeight: 1 }}>
              {panelOpen ? "»" : "«"}
            </Box>
          </IconButton>
        </Tooltip>
      </Stack>
      <EstateView
        model={model}
        estate={estate}
        edges={view.edges}
        o={o}
        mode={mode}
        onMode={setMode}
        rateUnit={rateUnit}
        width={width}
        height={mapH}
        panelOpen={panelOpen}
        narrow={narrow}
        panelW={panelW}
      />
    </Box>
  );
}

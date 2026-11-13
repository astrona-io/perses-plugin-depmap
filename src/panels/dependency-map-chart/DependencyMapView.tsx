import { ReactElement, useCallback, useEffect, useMemo, useState } from "react";
import {
  Box,
  Button,
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
  ResolvedOptions,
} from "./dependency-map-chart-types";
import {
  evaluateFailure,
  hardWiredClients,
  loseOneServer,
  needsOf,
} from "./failure";
import { firewallRulesForWave, wavesOf } from "./firewall";
import { FREQUENCY_LABELS } from "./format";
import { buildOption, fitBox, Palette, STATE_LABELS } from "./chart-option";
import { GraphCanvas } from "./GraphCanvas";
import { laneSpecs, layoutGraph } from "./layout";
import { updateWaves } from "./mapping";
import { DepModel } from "./model";
import { SidePanel } from "./SidePanel";

export interface DependencyMapViewProps {
  model: DepModel;
  o: ResolvedOptions;
  /** The mapping text, for "Copy updated mapping". */
  mappingText: string;
  mappingErrors: string[];
  palette: Palette;
  echartsTheme: string | object;
  width: number;
  height: number;
  nowSeconds: number;
  /** Which collectors returned data, shown in the toolbar. */
  sources?: { obi: boolean; fallback: boolean };
}

const TOOLBAR_H = 44;
/** Below this panel width the side panel covers the map instead of sitting beside it. */
export const NARROW = 720;

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * The interactive panel body: toolbar, map and side panel. Pure on its inputs (no queries), so it is
 * rendered directly in tests.
 */
export function DependencyMapView(props: DependencyMapViewProps): ReactElement {
  const { o, palette, width, height, nowSeconds } = props;
  const [mode, setMode] = useState<Mode>(o.defaultMode);
  const [shown, setShown] = useState<Set<Frequency>>(
    () => new Set(o.edgeFilter),
  );
  const [down, setDown] = useState<Set<string>>(() => new Set());
  const [selectedNode, setSelectedNode] = useState<string | undefined>();
  const [selectedEdge, setSelectedEdge] = useState<string | undefined>();
  const [waveOverrides, setWaveOverrides] = useState<Record<string, number>>(
    {},
  );
  const narrow = width < NARROW;
  const [panelOpen, setPanelOpen] = useState(!narrow);
  const [firewallWave, setFirewallWave] = useState(1);

  useEffect(() => setMode(o.defaultMode), [o.defaultMode]);
  useEffect(() => setShown(new Set(o.edgeFilter)), [o.edgeFilter]);

  // The model with any waves moved in the panel.
  const model: DepModel = useMemo(() => {
    if (Object.keys(waveOverrides).length === 0) return props.model;
    const nodes = props.model.nodes.map((n) =>
      n.id in waveOverrides ? { ...n, wave: waveOverrides[n.id]! } : n,
    );
    return {
      ...props.model,
      nodes,
      byId: new Map(nodes.map((n) => [n.id, n])),
    };
  }, [props.model, waveOverrides]);

  // Edges after the frequency filter; external nodes hidden when asked, and any external or unknown
  // node left without edges.
  const view = useMemo(() => {
    const hiddenIds = new Set(
      o.showExternal
        ? []
        : model.nodes.filter((n) => n.kind !== "internal").map((n) => n.id),
    );
    const edges = model.edges.filter(
      (e) =>
        shown.has(e.frequency) &&
        !hiddenIds.has(e.source) &&
        !hiddenIds.has(e.target),
    );
    const touched = new Set(edges.flatMap((e) => [e.source, e.target]));
    const nodes = model.nodes.filter(
      (n) => n.kind === "internal" || touched.has(n.id),
    );
    return {
      model: {
        ...model,
        nodes,
        edges,
        byId: new Map(nodes.map((n) => [n.id, n])),
      } as DepModel,
      hiddenEdges: model.edges.length - edges.length,
    };
  }, [model, shown, o.showExternal]);

  const failure = useMemo(
    () =>
      mode === "failure" ? evaluateFailure(view.model, [...down]) : undefined,
    [mode, view.model, down],
  );
  const spofs = useMemo(
    () => (mode === "failure" ? loseOneServer(view.model) : []),
    [mode, view.model],
  );
  const hardWired = useMemo(() => hardWiredClients(model), [model]);
  const needs = useMemo(
    () =>
      mode === "needs" && selectedNode
        ? needsOf(view.model, selectedNode)
        : undefined,
    [mode, view.model, selectedNode],
  );
  const waves = useMemo(() => {
    const ws = new Set([0, ...wavesOf(model), ...wavesOf(props.model)]);
    const max = Math.max(...ws);
    ws.add(max + 1);
    return [...ws].sort((a, b) => a - b);
  }, [model, props.model]);
  // Firewall rules use every edge seen in the window, not just the filtered ones.
  const firewall = useMemo(
    () => firewallRulesForWave(model, firewallWave),
    [model, firewallWave],
  );

  const layout = useMemo(
    () =>
      layoutGraph(
        view.model.nodes,
        view.model.edges,
        laneSpecs(view.model.nodes, {
          waveLabels: o.waveLabels,
          stayLabel: o.stayLabel,
          externalLabel: o.externalLabel,
        }),
      ),
    [view.model, o.waveLabels, o.stayLabel, o.externalLabel],
  );

  const panelW = Math.round(Math.min(380, Math.max(280, width * 0.3)));
  const mapW = Math.max(100, panelOpen && !narrow ? width - panelW : width);
  const mapH = Math.max(100, height - TOOLBAR_H);
  const option = useMemo(
    () =>
      buildOption({
        model: view.model,
        layout,
        mode,
        failure,
        down,
        selectedNode,
        selectedEdge,
        needs,
        palette,
        box: fitBox(layout, mapW, mapH),
        nowSeconds,
      }),
    [
      view.model,
      layout,
      mode,
      failure,
      down,
      selectedNode,
      selectedEdge,
      needs,
      palette,
      mapW,
      mapH,
      nowSeconds,
    ],
  );

  const toggleHost = useCallback((host: string) => {
    setDown((cur) => {
      const next = new Set(cur);
      if (next.has(host)) next.delete(host);
      else next.add(host);
      return next;
    });
  }, []);

  const onNodeClick = useCallback(
    (id: string) => {
      if (id.startsWith("chip:")) {
        const host = id.slice(5);
        if (mode === "failure") toggleHost(host);
        else {
          const owner = view.model.nodes.find((n) =>
            n.instances.some((i) => i.host === host),
          );
          setSelectedNode(owner?.id);
          setSelectedEdge(undefined);
        }
        return;
      }
      if (
        id.startsWith("lane:") ||
        id.startsWith("port:") ||
        id.startsWith("corner:")
      )
        return;
      setSelectedNode((cur) => (cur === id ? undefined : id));
      setSelectedEdge(undefined);
      if (narrow) setPanelOpen(true);
    },
    [mode, toggleHost, view.model, narrow],
  );
  const onEdgeClick = useCallback(
    (id: string) => {
      setSelectedEdge((cur) => (cur === id ? undefined : id));
      setSelectedNode(undefined);
      if (narrow) setPanelOpen(true);
    },
    [narrow],
  );
  const onBlankClick = useCallback(() => {
    setSelectedNode(undefined);
    setSelectedEdge(undefined);
  }, []);

  const presets = useMemo(
    () =>
      o.scenarios.length > 0
        ? o.scenarios
        : spofs
            .slice(0, 4)
            .map((s) => ({ name: `${s.host} down`, down: [s.host] })),
    [o.scenarios, spofs],
  );

  const changedWaves = Object.entries(waveOverrides).filter(
    ([id, w]) => props.model.byId.get(id)?.wave !== w,
  ).length;

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
            value="failure"
            sx={{ textTransform: "none", py: 0.25 }}
          >
            What if
          </ToggleButton>
          <ToggleButton value="needs" sx={{ textTransform: "none", py: 0.25 }}>
            Needs
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
        {mode === "failure"
          ? presets.map((p) => (
              <Button
                key={p.name}
                size="small"
                variant="outlined"
                sx={{ textTransform: "none", whiteSpace: "nowrap", py: 0.1 }}
                onClick={() => setDown(new Set(p.down))}
              >
                {p.name}
              </Button>
            ))
          : null}
        {mode === "failure" && down.size > 0 ? (
          <Button
            size="small"
            sx={{ whiteSpace: "nowrap" }}
            onClick={() => setDown(new Set())}
          >
            Reset
          </Button>
        ) : null}
        <Box sx={{ flexGrow: 1 }} />
        {mode === "failure" && failure ? (
          <Typography
            variant="body2"
            sx={{ whiteSpace: "nowrap" }}
            aria-live="polite"
          >
            <Box component="span" sx={{ color: "error.main" }}>
              {STATE_LABELS.down} {failure.outages.length} out
            </Box>
          </Typography>
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
      <Box
        sx={{
          position: "relative",
          flexGrow: 1,
          display: "flex",
          minHeight: 0,
        }}
      >
        <Box
          sx={{ width: mapW, height: mapH, flexShrink: 0 }}
          data-testid="depmap-canvas"
        >
          <GraphCanvas
            option={option}
            theme={props.echartsTheme}
            width={mapW}
            height={mapH}
            onNodeClick={onNodeClick}
            onEdgeClick={onEdgeClick}
            onBlankClick={onBlankClick}
          />
        </Box>
        {panelOpen ? (
          <Box
            sx={{
              width: narrow ? Math.min(width, 340) : panelW,
              height: mapH,
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
            <SidePanel
              model={model}
              o={o}
              mode={mode}
              failure={failure}
              down={down}
              onToggleHost={toggleHost}
              onScenario={(d) => {
                setMode("failure");
                setDown(new Set(d));
              }}
              spofs={spofs}
              hardWired={hardWired}
              selectedNode={selectedNode}
              selectedEdge={selectedEdge}
              onSelectNode={(id) => {
                setSelectedNode(id);
                setSelectedEdge(undefined);
              }}
              onSelectEdge={(id) => {
                setSelectedEdge(id);
                setSelectedNode(undefined);
              }}
              needs={needs}
              waves={waves}
              onWave={(id, w) =>
                setWaveOverrides((cur) => ({ ...cur, [id]: w }))
              }
              changedWaves={changedWaves}
              onCopyMapping={() =>
                void copyText(updateWaves(props.mappingText, waveOverrides))
              }
              firewallWave={firewallWave}
              onFirewallWave={setFirewallWave}
              firewall={firewall}
              hiddenEdges={view.hiddenEdges}
              mappingErrors={props.mappingErrors}
              nowSeconds={nowSeconds}
              copy={copyText}
            />
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}

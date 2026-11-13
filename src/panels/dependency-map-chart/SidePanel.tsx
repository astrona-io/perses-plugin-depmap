import { ReactElement, ReactNode, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Divider,
  Link,
  MenuItem,
  Stack,
  TextField,
  ToggleButton,
  Typography,
} from "@mui/material";
import { Mode, ResolvedOptions } from "./dependency-map-chart-types";
import {
  FailureResult,
  HardWiredClient,
  SinglePointOfFailure,
} from "./failure";
import { FirewallRule, formatRules } from "./firewall";
import {
  FREQUENCY_LABELS,
  fillTemplate,
  formatAgo,
  formatBytes,
  safeHref,
} from "./format";
import { HA_LABELS, STATE_LABELS } from "./chart-option";
import { DepEdge, DepModel } from "./model";

export interface SidePanelProps {
  model: DepModel;
  o: ResolvedOptions;
  mode: Mode;
  failure?: FailureResult;
  down: ReadonlySet<string>;
  onToggleHost: (host: string) => void;
  onScenario: (down: string[]) => void;
  spofs: SinglePointOfFailure[];
  hardWired: HardWiredClient[];
  selectedNode?: string;
  selectedEdge?: string;
  onSelectNode: (id: string | undefined) => void;
  onSelectEdge: (id: string | undefined) => void;
  needs?: ReadonlySet<string>;
  waves: number[];
  onWave: (id: string, wave: number) => void;
  changedWaves: number;
  onCopyMapping: () => void;
  firewallWave: number;
  onFirewallWave: (w: number) => void;
  firewall: FirewallRule[];
  hiddenEdges: number;
  mappingErrors: string[];
  nowSeconds: number;
  copy: (text: string) => Promise<boolean>;
}

function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}): ReactElement {
  return (
    <Box component="section" aria-label={title} sx={{ py: 1 }}>
      <Typography variant="subtitle2" component="h3" sx={{ mb: 0.5 }}>
        {title}
      </Typography>
      {children}
    </Box>
  );
}

function CopyButton({
  text,
  label,
  copy,
}: {
  text: string;
  label: string;
  copy: SidePanelProps["copy"];
}): ReactElement {
  const [done, setDone] = useState<"" | "ok" | "fail">("");
  return (
    <Button
      size="small"
      variant="outlined"
      disabled={!text}
      onClick={() => void copy(text).then((ok) => setDone(ok ? "ok" : "fail"))}
    >
      {done === "ok" ? "Copied" : done === "fail" ? "Copy failed" : label}
    </Button>
  );
}

export function SidePanel(props: SidePanelProps): ReactElement {
  const {
    model,
    o,
    mode,
    failure,
    down,
    selectedNode,
    selectedEdge,
    nowSeconds,
  } = props;
  const name = (id: string): string => model.byId.get(id)?.name ?? id;
  const node = selectedNode ? model.byId.get(selectedNode) : undefined;
  const edge: DepEdge | undefined = selectedEdge
    ? model.edges.find((e) => e.id === selectedEdge)
    : undefined;
  const internal = model.nodes
    .filter((n) => n.kind !== "external")
    .sort((a, b) => (a.name < b.name ? -1 : 1));

  const unknown = model.nodes.filter((n) => n.kind === "unknown");
  const rare = model.edges.filter(
    (e) => e.frequency === "weekly" || e.frequency === "monthly",
  );

  return (
    <Box
      sx={{
        p: 1.5,
        overflowY: "auto",
        height: "100%",
        boxSizing: "border-box",
      }}
    >
      {props.mappingErrors.length > 0 ? (
        <Alert severity="warning" sx={{ mb: 1 }}>
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            Mapping problems ({props.mappingErrors.length})
          </Typography>
          {props.mappingErrors.slice(0, 8).map((e) => (
            <Typography key={e} variant="caption" component="div">
              {e}
            </Typography>
          ))}
        </Alert>
      ) : null}

      <TextField
        select
        size="small"
        fullWidth
        label="Service"
        value={selectedNode ?? ""}
        onChange={(e) => props.onSelectNode(e.target.value || undefined)}
        SelectProps={{ MenuProps: { disablePortal: false } }}
      >
        <MenuItem value="">
          <em>None</em>
        </MenuItem>
        {internal.map((n) => (
          <MenuItem key={n.id} value={n.id}>
            {n.name}
          </MenuItem>
        ))}
      </TextField>

      {mode === "failure" && failure ? (
        <Section title="Scenario">
          {down.size === 0 ? (
            <Typography variant="body2" color="text.secondary">
              Nothing is down. Click instance chips on the map, pick a service
              above, or try a preset.
            </Typography>
          ) : (
            <>
              <Typography variant="body2">
                Down: <b>{[...down].join(", ")}</b>
              </Typography>
              <Stack direction="row" spacing={2} sx={{ my: 0.5 }}>
                <Typography variant="body2" color="error.main">
                  {failure.outages.length} out
                </Typography>
                <Typography variant="body2" color="warning.main">
                  {failure.counts.failover +
                    failure.counts.overload +
                    failure.counts.degraded +
                    failure.counts.risk}{" "}
                  at risk
                </Typography>
              </Stack>
              <Box component="ul" sx={{ m: 0, pl: 2 }}>
                {[...failure.services]
                  .filter(([, s]) => s.state !== "ok" && s.state !== "reduced")
                  .map(([id, s]) => (
                    <li key={id}>
                      <Typography variant="body2">
                        <b>{name(id)}</b> {STATE_LABELS[s.state]}: {s.reason}
                      </Typography>
                    </li>
                  ))}
              </Box>
            </>
          )}
        </Section>
      ) : null}

      {mode === "failure" ? (
        <Section title="Lose one server">
          {props.spofs.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              No single server takes anything else down.
            </Typography>
          ) : (
            props.spofs.slice(0, 12).map((s) => (
              <Stack
                key={s.host}
                direction="row"
                alignItems="center"
                spacing={1}
                sx={{ mb: 0.25 }}
              >
                <Button
                  size="small"
                  onClick={() => props.onScenario([s.host])}
                  aria-label={`Try ${s.host} down`}
                >
                  Try
                </Button>
                <Typography variant="body2">
                  <b>{s.host}</b>: {s.outages.length} out (
                  {s.outages.map(name).join(", ")})
                </Typography>
              </Stack>
            ))
          )}
          {props.hardWired.length > 0 ? (
            <>
              <Typography variant="body2" sx={{ mt: 1, fontWeight: 600 }}>
                Hard-wired clients
              </Typography>
              {props.hardWired.map((h) => (
                <Typography key={h.edgeId + h.callerHost} variant="body2">
                  {h.callerHost} ({name(h.caller)}) only uses {h.calleeHost} of{" "}
                  {name(h.callee)}
                </Typography>
              ))}
            </>
          ) : null}
        </Section>
      ) : null}

      {node ? (
        <Section title={node.name}>
          {node.owner ? (
            <Typography variant="body2">Owner: {node.owner}</Typography>
          ) : null}
          {node.kind === "unknown" ? (
            <Typography variant="body2" color="warning.main">
              Not in the mapping. Find its owner and add it.
            </Typography>
          ) : null}
          {node.kind === "internal" ? (
            <>
              <Typography variant="body2">
                HA: {HA_LABELS[node.ha]}
                {node.load !== undefined ? ` · load ${node.load}%` : ""}
                {node.vip ? ` · VIP ${node.vip}` : ""}
              </Typography>
              <TextField
                select
                size="small"
                label="Wave"
                value={node.wave}
                onChange={(e) => props.onWave(node.id, Number(e.target.value))}
                sx={{ mt: 1, minWidth: 160 }}
              >
                {props.waves.map((w) => (
                  <MenuItem key={w} value={w}>
                    {w === 0
                      ? o.stayLabel
                      : (o.waveLabels[String(w)] ?? `Wave ${w}`)}
                  </MenuItem>
                ))}
              </TextField>
            </>
          ) : null}
          {node.instances.length > 0 ? (
            <Stack
              direction="row"
              flexWrap="wrap"
              gap={0.5}
              sx={{ mt: 1 }}
              role="group"
              aria-label="Instances"
            >
              {node.instances.map((i) => (
                <ToggleButton
                  key={i.host}
                  size="small"
                  value={i.host}
                  selected={down.has(i.host)}
                  aria-pressed={down.has(i.host)}
                  onChange={() => props.onToggleHost(i.host)}
                  title={`${i.ip}: ${down.has(i.host) ? "bring back up" : "take down"}`}
                  sx={{ py: 0.25, textTransform: "none" }}
                >
                  {down.has(i.host) ? "✕ " : ""}
                  {i.host}
                </ToggleButton>
              ))}
            </Stack>
          ) : null}
          <Typography variant="body2" sx={{ mt: 1 }}>
            Calls:{" "}
            {model.edges
              .filter((e) => e.source === node.id)
              .map((e) => `${name(e.target)}:${e.port}`)
              .join(", ") || "nothing"}
          </Typography>
          <Typography variant="body2">
            Called by:{" "}
            {[
              ...new Set(
                model.edges
                  .filter((e) => e.target === node.id)
                  .map((e) => name(e.source)),
              ),
            ].join(", ") || "nobody"}
          </Typography>
          {mode === "needs" && props.needs ? (
            <Typography variant="body2">
              Needs ({props.needs.size}):{" "}
              {[...props.needs].map(name).join(", ") || "nothing"}
            </Typography>
          ) : null}
          {o.links.node
            ? (() => {
                const href = safeHref(
                  fillTemplate(o.links.node, {
                    service: node.id,
                    name: node.name,
                    host: node.instances[0]?.host ?? "",
                    hosts: node.instances.map((i) => i.host).join(","),
                  }),
                );
                return href ? (
                  <Link
                    href={href}
                    variant="body2"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Open details
                  </Link>
                ) : null;
              })()
            : null}
        </Section>
      ) : null}

      {edge ? (
        <Section
          title={`${name(edge.source)} → ${name(edge.target)} :${edge.port}`}
        >
          <Typography variant="body2">
            {FREQUENCY_LABELS[edge.frequency]}: seen in {edge.hoursSeen} of{" "}
            {model.windowHours} hours
          </Typography>
          <Typography variant="body2">
            Last seen {formatAgo(edge.lastSeen, nowSeconds)}
          </Typography>
          {edge.bytesPerDay !== undefined ? (
            <Typography variant="body2">
              {formatBytes(edge.bytesPerDay)} per day
            </Typography>
          ) : null}
          {Object.entries(edge.pairs).map(([c, callees]) => (
            <Typography key={c} variant="body2">
              {c} → {callees.join(", ")}
              {edge.pins[c] ? " (hard-wired)" : ""}
            </Typography>
          ))}
          {o.links.edge
            ? (() => {
                const href = safeHref(
                  fillTemplate(o.links.edge, {
                    source: edge.source,
                    target: edge.target,
                    port: String(edge.port),
                  }),
                );
                return href ? (
                  <Link
                    href={href}
                    variant="body2"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Open link
                  </Link>
                ) : null;
              })()
            : null}
        </Section>
      ) : null}

      {props.changedWaves > 0 ? (
        <Section title="Changed waves">
          <Typography variant="body2" sx={{ mb: 0.5 }}>
            {props.changedWaves} service(s) moved. The dashboard keeps the old
            mapping until you paste the updated one into the panel settings.
          </Typography>
          <Button size="small" variant="outlined" onClick={props.onCopyMapping}>
            Copy updated mapping
          </Button>
        </Section>
      ) : null}

      <Divider sx={{ my: 1 }} />
      <Section title="Firewall rules">
        {props.waves.filter((w) => w > 0).length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            No service has a wave yet.
          </Typography>
        ) : (
          <>
            <Stack
              direction="row"
              spacing={1}
              alignItems="center"
              sx={{ mb: 0.5 }}
            >
              <TextField
                select
                size="small"
                label="For wave"
                value={props.firewallWave}
                onChange={(e) => props.onFirewallWave(Number(e.target.value))}
                sx={{ minWidth: 120 }}
              >
                {props.waves
                  .filter((w) => w > 0)
                  .map((w) => (
                    <MenuItem key={w} value={w}>
                      {o.waveLabels[String(w)] ?? `Wave ${w}`}
                    </MenuItem>
                  ))}
              </TextField>
              <CopyButton
                text={formatRules(props.firewall)}
                label="Copy"
                copy={props.copy}
              />
            </Stack>
            <Typography variant="caption" color="text.secondary">
              {props.firewall.length} rule(s), all edges seen in the window, not
              only the ones shown.
            </Typography>
            <Box
              component="pre"
              sx={{
                fontSize: 11,
                m: 0,
                mt: 0.5,
                maxHeight: 180,
                overflow: "auto",
                whiteSpace: "pre",
              }}
            >
              {formatRules(props.firewall) || "No rules needed."}
            </Box>
          </>
        )}
      </Section>

      <Section title="Easy to miss">
        {props.hiddenEdges > 0 ? (
          <Typography variant="body2">
            {props.hiddenEdges} edge(s) hidden by the frequency filter.
          </Typography>
        ) : null}
        {unknown.length > 0 ? (
          <Typography variant="body2">
            {unknown.length} unknown address(es):{" "}
            {unknown.map((n) => n.name).join(", ")}
          </Typography>
        ) : null}
        {rare.map((e) => (
          <Typography key={e.id} variant="body2">
            <Link
              component="button"
              variant="body2"
              onClick={() => props.onSelectEdge(e.id)}
            >
              {name(e.source)} → {name(e.target)} :{e.port}
            </Link>{" "}
            {FREQUENCY_LABELS[e.frequency].toLowerCase()}, last{" "}
            {formatAgo(e.lastSeen, nowSeconds)}
          </Typography>
        ))}
        {props.hardWired.length > 0 ? (
          <Typography variant="body2">
            {props.hardWired.length} hard-wired client instance(s).
          </Typography>
        ) : null}
        {props.hiddenEdges === 0 &&
        unknown.length === 0 &&
        rare.length === 0 &&
        props.hardWired.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            Nothing.
          </Typography>
        ) : null}
      </Section>
    </Box>
  );
}

import { ReactElement, useEffect, useState } from "react";
import {
  Checkbox,
  FormControlLabel,
  FormGroup,
  MenuItem,
  Switch,
  TextField,
  Typography,
} from "@mui/material";
import {
  OptionsEditorColumn,
  OptionsEditorControl,
  OptionsEditorGrid,
  OptionsEditorGroup,
} from "@perses-dev/components";
import { DatasourceSelect } from "@perses-dev/plugin-system";
import {
  DEFAULT_EDGE_QUERY,
  DEFAULT_EXTERNAL_LABEL,
  DEFAULT_FALLBACK_QUERY,
  DEFAULT_STAY_LABEL,
  DEFAULT_THRESHOLDS,
  DEFAULT_WINDOW,
  DependencyMapChartEditorProps,
  DependencyMapChartOptions,
  FREQUENCIES,
  FrequencyThresholds,
  Mode,
  PROMETHEUS_DATASOURCE_KIND,
  Scenario,
} from "./dependency-map-chart-types";
import { FREQUENCY_LABELS } from "./format";
import { parseMapping } from "./mapping";

/** `1=Wave 1 (March)` per line, to and from the wave label map. */
export function parseWaveLabels(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s*=\s*(.+?)\s*$/.exec(line);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}
export function formatWaveLabels(
  labels: Record<string, string> | undefined,
): string {
  return Object.entries(labels ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

/** `Name: host1, host2` per line, to and from scenarios. */
export function parseScenarios(text: string): Scenario[] {
  const out: Scenario[] = [];
  for (const line of text.split("\n")) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const name = line.slice(0, i).trim();
    const down = line
      .slice(i + 1)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (name && down.length > 0) out.push({ name, down });
  }
  return out;
}
export function formatScenarios(s: Scenario[] | undefined): string {
  return (s ?? []).map((x) => `${x.name}: ${x.down.join(", ")}`).join("\n");
}

/** A multi-line text field that keeps its own text and reports a parsed value on every change. */
function LinesControl<T>({
  label,
  description,
  placeholder,
  value,
  format,
  parse,
  onChange,
}: {
  label: string;
  description: string;
  placeholder: string;
  value: T;
  format: (v: T) => string;
  parse: (s: string) => T;
  onChange: (v: T) => void;
}): ReactElement {
  const [text, setText] = useState(() => format(value));
  return (
    <OptionsEditorControl
      label={label}
      description={description}
      control={
        <TextField
          size="small"
          multiline
          minRows={2}
          placeholder={placeholder}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            onChange(parse(e.target.value));
          }}
        />
      }
    />
  );
}

function TextControl({
  label,
  description,
  placeholder,
  value,
  multiline,
  onChange,
}: {
  label: string;
  description?: string;
  placeholder?: string;
  value: string | undefined;
  multiline?: boolean;
  onChange: (v: string | undefined) => void;
}): ReactElement {
  return (
    <OptionsEditorControl
      label={label}
      description={description}
      control={
        <TextField
          size="small"
          multiline={multiline}
          placeholder={placeholder}
          value={value ?? ""}
          onChange={(e) =>
            onChange(e.target.value === "" ? undefined : e.target.value)
          }
        />
      }
    />
  );
}

export function DependencyMapChartSettingsEditor(
  props: DependencyMapChartEditorProps,
): ReactElement {
  const { onChange, value } = props;
  const set = (patch: Partial<DependencyMapChartOptions>): void =>
    onChange({ ...value, ...patch });
  const thresholds: FrequencyThresholds = {
    ...DEFAULT_THRESHOLDS,
    ...(value.frequencyThresholds ?? {}),
  };
  const filter =
    value.edgeFilter && value.edgeFilter.length > 0
      ? value.edgeFilter
      : FREQUENCIES;

  // Mapping problems are shown while typing; the panel shows them too.
  const [mappingErrors, setMappingErrors] = useState<string[]>([]);
  useEffect(() => {
    const t = setTimeout(
      () => setMappingErrors(parseMapping(value.mapping ?? "").errors),
      300,
    );
    return () => clearTimeout(t);
  }, [value.mapping]);

  return (
    <OptionsEditorGrid>
      <OptionsEditorColumn>
        <OptionsEditorGroup title="Data">
          <OptionsEditorControl
            label="Datasource"
            control={
              <DatasourceSelect
                datasourcePluginKind={PROMETHEUS_DATASOURCE_KIND}
                value={value.datasource ?? { kind: PROMETHEUS_DATASOURCE_KIND }}
                onChange={(datasource) => set({ datasource })}
              />
            }
          />
          <TextControl
            label="OBI edge query"
            description="One series per caller, callee and port, values per hour. Clear to turn off."
            multiline
            value={value.queries?.edge ?? DEFAULT_EDGE_QUERY}
            onChange={(edge) =>
              set({ queries: { ...value.queries, edge: edge ?? "" } })
            }
          />
          <TextControl
            label="Fallback query"
            description="The fallback script's depmap_connection_seen. Clear to turn off."
            multiline
            value={value.queries?.fallback ?? DEFAULT_FALLBACK_QUERY}
            onChange={(fallback) =>
              set({ queries: { ...value.queries, fallback: fallback ?? "" } })
            }
          />
          <TextControl
            label="Volume query"
            description="Optional bytes per hour per edge, when the edge query has none"
            multiline
            value={value.queries?.volume}
            onChange={(volume) =>
              set({ queries: { ...value.queries, volume } })
            }
          />
          <TextControl
            label="Window"
            description="How far back to look, ending at the dashboard's end time. Up to 365d."
            placeholder={DEFAULT_WINDOW}
            value={value.window}
            onChange={(window) => set({ window })}
          />
        </OptionsEditorGroup>
        <OptionsEditorGroup title="Mapping">
          <OptionsEditorControl
            label="Mapping (YAML or JSON)"
            description="Services, instances, owners, waves, HA groups and external endpoints. See collect/mapping.example.yaml."
            control={
              <TextField
                size="small"
                multiline
                minRows={10}
                maxRows={30}
                value={value.mapping ?? ""}
                onChange={(e) => set({ mapping: e.target.value })}
                inputProps={{
                  spellCheck: false,
                  style: { fontFamily: "monospace", fontSize: 12 },
                }}
              />
            }
          />
          {mappingErrors.length > 0 ? (
            <Typography
              variant="caption"
              color="error.main"
              component="div"
              role="alert"
            >
              {mappingErrors.slice(0, 10).map((e) => (
                <div key={e}>{e}</div>
              ))}
            </Typography>
          ) : null}
        </OptionsEditorGroup>
      </OptionsEditorColumn>
      <OptionsEditorColumn>
        <OptionsEditorGroup title="Frequency">
          {(["constantly", "hourly", "daily", "weekly"] as const).map((k) => (
            <OptionsEditorControl
              key={k}
              label={`${FREQUENCY_LABELS[k]}: seen in at least (% of hours)`}
              control={
                <TextField
                  size="small"
                  type="number"
                  inputProps={{ step: "any", min: 0, max: 100 }}
                  value={Math.round(thresholds[k] * 10000) / 100}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    if (e.target.value === "" || !Number.isFinite(n)) return;
                    set({
                      frequencyThresholds: {
                        ...value.frequencyThresholds,
                        [k]: n / 100,
                      },
                    });
                  }}
                />
              }
            />
          ))}
          <OptionsEditorControl
            label="Shown when the panel opens"
            control={
              <FormGroup row>
                {FREQUENCIES.map((f) => (
                  <FormControlLabel
                    key={f}
                    control={
                      <Checkbox
                        size="small"
                        checked={filter.includes(f)}
                        onChange={() => {
                          const next = filter.includes(f)
                            ? filter.filter((x) => x !== f)
                            : [...filter, f];
                          set({
                            edgeFilter:
                              next.length === FREQUENCIES.length
                                ? undefined
                                : next,
                          });
                        }}
                      />
                    }
                    label={FREQUENCY_LABELS[f]}
                  />
                ))}
              </FormGroup>
            }
          />
        </OptionsEditorGroup>
        <OptionsEditorGroup title="Display">
          <OptionsEditorControl
            label="Opens in"
            control={
              <TextField
                select
                size="small"
                value={value.defaultMode ?? "map"}
                onChange={(e) => set({ defaultMode: e.target.value as Mode })}
              >
                <MenuItem value="map">Map</MenuItem>
                <MenuItem value="failure">What if (failure scenarios)</MenuItem>
                <MenuItem value="needs">Needs</MenuItem>
              </TextField>
            }
          />
          <LinesControl
            label="Wave labels"
            description="One per line: 1=Wave 1 (March)"
            placeholder="1=Wave 1"
            value={value.lanes?.waveLabels}
            format={formatWaveLabels}
            parse={(s) => {
              const l = parseWaveLabels(s);
              return Object.keys(l).length > 0 ? l : undefined;
            }}
            onChange={(waveLabels) =>
              set({ lanes: { ...value.lanes, waveLabels } })
            }
          />
          <TextControl
            label="Stays label"
            placeholder={DEFAULT_STAY_LABEL}
            value={value.lanes?.stayLabel}
            onChange={(stayLabel) =>
              set({ lanes: { ...value.lanes, stayLabel } })
            }
          />
          <TextControl
            label="External label"
            placeholder={DEFAULT_EXTERNAL_LABEL}
            value={value.lanes?.externalLabel}
            onChange={(externalLabel) =>
              set({ lanes: { ...value.lanes, externalLabel } })
            }
          />
          <OptionsEditorControl
            label="Show external and unknown"
            control={
              <Switch
                checked={value.lanes?.showExternal ?? true}
                onChange={(_, showExternal) =>
                  set({ lanes: { ...value.lanes, showExternal } })
                }
              />
            }
          />
        </OptionsEditorGroup>
        <OptionsEditorGroup title="Links and scenarios">
          <TextControl
            label="Node link"
            description="${service}, ${name}, ${host}, ${hosts}. http(s) or relative only."
            value={value.linkTemplates?.node}
            onChange={(node) =>
              set({ linkTemplates: { ...value.linkTemplates, node } })
            }
          />
          <TextControl
            label="Edge link"
            description="${source}, ${target}, ${port}"
            value={value.linkTemplates?.edge}
            onChange={(edge) =>
              set({ linkTemplates: { ...value.linkTemplates, edge } })
            }
          />
          <LinesControl
            label="Failure scenarios"
            description="One per line: Name: host1, host2. Empty: the worst single-server failures."
            placeholder="LDAP split: ldap01, ldap02"
            value={value.scenarios}
            format={formatScenarios}
            parse={(s) => {
              const l = parseScenarios(s);
              return l.length > 0 ? l : undefined;
            }}
            onChange={(scenarios) => set({ scenarios })}
          />
        </OptionsEditorGroup>
      </OptionsEditorColumn>
    </OptionsEditorGrid>
  );
}

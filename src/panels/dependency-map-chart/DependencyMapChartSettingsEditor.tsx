import { ReactElement, useEffect, useState } from "react";
import {
  Button,
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
import { stringify } from "yaml";
import {
  DEFAULT_EDGE_QUERY,
  DEFAULT_FALLBACK_QUERY,
  DEFAULT_CLUSTER_LABEL,
  DEFAULT_CLUSTER_NAME,
  DEFAULT_INTERNET_TOP,
  DEFAULT_MONITORING_PATTERN,
  DEFAULT_THRESHOLDS,
  DependencyMapChartEditorProps,
  DependencyMapChartOptions,
  FREQUENCIES,
  FrequencyThresholds,
  Mode,
  RATE_UNITS,
  RateUnit,
  PROMETHEUS_DATASOURCE_KIND,
} from "./dependency-map-chart-types";
import { FREQUENCY_LABELS } from "./format";
import { parseMapping } from "./mapping";
import { DEFAULT_INTERNET_PROVIDERS } from "./places";

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
            description="How far back to look, ending at the dashboard's end time, e.g. 30d. Empty: the dashboard's time range. Up to 365d."
            placeholder="the dashboard's time range"
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
          <OptionsEditorControl
            label="Internet providers"
            description="Without places.internet the panel uses built-in ranges for common providers. Copy them as YAML to edit them in the mapping; an empty list turns them off."
            control={
              <Button
                size="small"
                variant="outlined"
                sx={{ textTransform: "none" }}
                onClick={() =>
                  void navigator.clipboard
                    ?.writeText(
                      stringify({
                        places: { internet: DEFAULT_INTERNET_PROVIDERS },
                      }),
                    )
                    .catch(() => undefined)
                }
              >
                Copy default providers
              </Button>
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
                value={
                  value.defaultMode === "outage" ||
                  value.defaultMode === "failure"
                    ? "outage"
                    : "map"
                }
                onChange={(e) => set({ defaultMode: e.target.value as Mode })}
              >
                <MenuItem value="map">Map</MenuItem>
                <MenuItem value="outage">If unreachable</MenuItem>
              </TextField>
            }
          />
          <OptionsEditorControl
            label="Rates in"
            control={
              <TextField
                select
                size="small"
                value={value.rateUnit ?? "s"}
                onChange={(e) => set({ rateUnit: e.target.value as RateUnit })}
              >
                {RATE_UNITS.map((u) => (
                  <MenuItem key={u} value={u}>
                    {u === "auto" ? "Auto" : `per ${u}`}
                  </MenuItem>
                ))}
              </TextField>
            }
          />
          <TextControl
            label="Cluster label"
            description="Label holding the Kubernetes cluster name; one block per value"
            placeholder={DEFAULT_CLUSTER_LABEL}
            value={value.clusterLabel}
            onChange={(clusterLabel) => set({ clusterLabel })}
          />
          <TextControl
            label="Cluster name"
            description="Used when no series carries the cluster label"
            placeholder={DEFAULT_CLUSTER_NAME}
            value={value.clusterName}
            onChange={(clusterName) => set({ clusterName })}
          />
          <OptionsEditorControl
            label="Internet addresses listed by name"
            description="Per provider page; the rest are counted"
            control={
              <TextField
                size="small"
                type="number"
                inputProps={{ min: 0, step: 1 }}
                placeholder={String(DEFAULT_INTERNET_TOP)}
                value={value.internetTopAddresses ?? ""}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  set({
                    internetTopAddresses:
                      e.target.value === "" || !Number.isFinite(n)
                        ? undefined
                        : Math.max(0, Math.floor(n)),
                  });
                }}
              />
            }
          />
          <TextControl
            label="Monitoring pattern"
            description="Regular expression over namespace and workload names for Hide monitoring"
            placeholder={DEFAULT_MONITORING_PATTERN}
            value={value.monitoringPattern}
            onChange={(monitoringPattern) => set({ monitoringPattern })}
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
        <OptionsEditorGroup title="Links">
          <TextControl
            label="Node link"
            description="${service}, ${name}, ${host}, ${hosts}. http(s) or relative only."
            value={value.linkTemplates?.node}
            onChange={(node) =>
              set({ linkTemplates: { ...value.linkTemplates, node } })
            }
          />
        </OptionsEditorGroup>
      </OptionsEditorColumn>
    </OptionsEditorGrid>
  );
}

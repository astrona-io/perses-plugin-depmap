# Plan

How the dependency map is built. The spec is [PROMPT.md](PROMPT.md); choices it left open are in
[DECISIONS.md](DECISIONS.md).

## Pieces

1. **Collection kit** (`collect/`): OBI on Linux servers that can run it, the snapshot script
   (`ss` or `Get-NetTCPConnection`) everywhere else, both scraped by Prometheus. A mapping file adds
   what traffic cannot tell: names, owners, waves, HA groups.
2. **Panel** (`src/panels/dependency-map-chart/`): reads both metric sources over a 30-day window,
   joins them with the mapping, draws the map and answers the failure and migration questions.
3. **Dev stack** (`dev/`): a fake legacy estate in containers, Prometheus with a month of backfilled
   history, Perses with the plugin and a ready dashboard.

## Data flow

```
Prometheus range queries (step 1h, window 30d)
  OBI edge query ─┐
  fallback query ─┼─ seriesToSamples ─> EdgeSample[] (src IP, dst IP, port, hours seen, bytes, last seen)
  volume query ───┘
loadQuery per service (instant) ─> load %

mapping text ─ parseMapping ─> Mapping (services, instances, VIPs, externals) + errors

buildModel(mapping, samples, thresholds, windowHours) ─> Model
  nodes: services, externals, unknown IPs (one node each), with instances
  edges: service -> service per port, with frequency class, bytes/day, last seen,
         caller instance -> callee instances (pairs) and hard-wired flags (pins)

Model + filters ─> layout (lanes) ─> chart option ─> GraphCanvas (ECharts)
Model + down hosts ─> evaluate (failure.ts) ─> state and reason per node
Model ─> loseOneServer, hardWiredClients, needsOf, firewallRules
```

## Pure modules (all unit-tested)

| Module | Does |
| --- | --- |
| `mapping.ts` | Parse YAML/JSON, validate against the schema with paths in errors, keep what is valid, write a changed wave back with comments kept |
| `queries.ts` | Window parsing, Prometheus matrix to `EdgeSample`, OBI and fallback labels, inbound series turned around |
| `model.ts` | IP to node resolution (instances, VIPs, CIDR and name externals, unknowns), frequency classes, edges, pairs, hard-wired detection |
| `failure.ts` | Per-service state from instances down (single, active-passive, active-active with minUp and load, quorum), transitive propagation to callers, at-risk callers, hard-wired breakage, lose-one-server ranking, transitive needs |
| `firewall.ts` | Zones per wave (new, old, outside), rules per instance for edges that cross zones, VIP handling, copyable text |
| `layout.ts` | Lane columns: waves, stays, outside; sub-columns when a lane is crowded; no overlaps |
| `chart-option.ts` | ECharts graph option: nodes, chips, lane headers, edge styles per class and state, tooltips |

## Component tree

```
DependencyMapChart (PanelPlugin)
├─ DependencyMapChartComponent      queries (useDepmapData), parse, model, empty/error states
│  └─ DependencyMapView             mode, filters, selection, down set, wave overrides
│     ├─ toolbar                    Map / What if / Needs, frequency checkboxes, sources, details toggle
│     ├─ GraphCanvas                ECharts canvas (from perses-plugin-servicegraph)
│     └─ SidePanel                  scenario summary, presets, lose one server, hard-wired clients,
│                                   service or edge details, wave selector, firewall rules, easy to miss
└─ DependencyMapChartSettingsEditor every spec option
```

## Schema

`schemas/panels/dependency-map-chart/dependency-map-chart.cue`: `datasource`, `queries` (edge,
fallback, volume), `mapping`, `window`, `frequencyThresholds`, `lanes` (waveLabels, stayLabel,
externalLabel, showExternal), `edgeFilter`, `linkTemplates` (node, edge), `scenarios`, `defaultMode`.
Valid and invalid examples under `tests/`.

## Open questions (answered in DECISIONS.md)

- Where does OBI run in dev/? (3: nowhere, rootless podman cannot create BPF maps.)
- Does the map need OBI application metrics? (4: no.)
- What does the scenario do with filtered edges? (7: evaluates what is shown.)
- How does a monthly job appear in a demo? (11: accelerated clock plus backfill.)

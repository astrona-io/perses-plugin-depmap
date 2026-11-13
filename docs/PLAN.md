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

Model + filters ─> estate (estate.ts) ─> EstateView: drill-down, place pages, dependencies
Model + estate + unreachable units ─> simulate (outage.ts) ─> state and reason per service and machine
Model + estate ─> rankUnits (every unit alone, worst first), firewallRules per cluster and wave
```

## Pure modules (all unit-tested)

| Module | Does |
| --- | --- |
| `mapping.ts` | Parse YAML/JSON, validate against the schema with paths in errors, keep what is valid, write a changed wave back with comments kept |
| `queries.ts` | Window parsing, Prometheus matrix to `EdgeSample`, OBI and fallback labels, inbound series turned around |
| `model.ts` | IP to node resolution (instances, VIPs, CIDR and name externals, unknowns), frequency classes, edges, pairs, hard-wired detection |
| `estate.ts` | Machines, clusters and places from the model; hops between locations; workloads per machine |
| `outage.ts` | Units that can be unreachable (machines, clusters, servers, places, storage hosts); what stops, loses a dependency, may break, runs on fewer machines or has less headroom; pinned callers; the ranking of single units |
| `firewall.ts` | Zones per wave (new, old, outside), rules per instance for edges that cross zones, VIP handling, copyable text |

## Component tree

```
DependencyMapChart (PanelPlugin)
├─ DependencyMapChartComponent      queries (useDepmapData), parse, model, empty/error states
│  └─ DependencyMapView             mode, filters, rate unit, details toggle
│     ├─ toolbar                    Map / If unreachable, frequency checkboxes, sources, details toggle
│     └─ EstateView                 Map: drill-down and side panel; If unreachable: units, impact,
│                                   ranking, the chain an effect breaks along
└─ DependencyMapChartSettingsEditor every spec option
```

## Schema

`schemas/panels/dependency-map-chart/dependency-map-chart.cue`: `datasource`, `queries` (edge,
fallback, volume), `mapping`, `window`, `frequencyThresholds`, `lanes` (only showExternal is
used), `edgeFilter`, `linkTemplates` (node), `defaultMode` (map or outage). `scenarios`, `defaultView`,
the other `lanes` fields and `linkTemplates.edge` are accepted and ignored, so older dashboards load.
Valid and invalid examples under `tests/`.

## Open questions (answered in DECISIONS.md)

- Where does OBI run in dev/? (3: nowhere, rootless podman cannot create BPF maps.)
- Does the map need OBI application metrics? (4: no.)
- What does If unreachable do with filtered edges? (7: evaluates what is shown.)
- How does a monthly job appear in a demo? (11: accelerated clock plus backfill.)

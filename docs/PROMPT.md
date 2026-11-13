You are a senior TypeScript/React engineer and Perses contributor, comfortable with Linux, eBPF tooling and Prometheus. Build the Perses plugin and its data collection kit described below in this repository (perses-plugin-depmap). Work autonomously: plan, build, test, document. Open a PR when it's done.

# Part 1: What to build. Dependency and impact map (depmap)

Repo: astrona-io/perses-plugin-depmap. Plugin kind(s): Panel: DependencyMapChart. No new datasource: data comes from the upstream Prometheus datasource (and optionally Tempo). The interactive concept page is private; this prompt is the spec. Screenshots of the built panel are in docs/images/.

## Why

The owner has to migrate old, badly documented software from a classic datacenter onto new VMs. Nobody knows all the dependencies. This panel shows what really talks to what (discovered from network traffic, not documentation), and answers the migration questions:

- What breaks if this server or service goes down, including HA setups (2 or 3 nodes, primary/standby, quorum)?
- What does this service need, so it can move together?
- Which connections cross between old DC and new VMs per migration wave, as firewall rules?
- Which dependencies are rare (monthly batch jobs) or unknown (IPs nobody owns)?

## Deliverable 1: the data collection kit (collect/)

The panel is useless without data, so build this first and document it for people who aren't eBPF experts.

### A. OBI on Linux servers (preferred)

- OpenTelemetry eBPF Instrumentation (OBI) runs as root on each Linux server, with no changes to the observed software. Requirements: kernel 5.8+, or RHEL-family 4.18+ with eBPF backports, and BTF.
- Provide collect/obi/config.yaml with network flow metrics enabled (metrics.features: [network], network.cidrs for the server subnets) and export to Prometheus (OTLP via an OpenTelemetry Collector, or OBI's Prometheus endpoint).
- Provide a systemd unit and an install script (download a pinned release, verify checksum, install, enable).
- Read the current OBI docs (setup, security/permissions, service discovery, network metrics, export) and use their exact config keys. Document the exact Prometheus metric and label names OBI produces (e.g. the network flow bytes metric) in docs/metrics.md. Don't guess.
- If the network flow metrics don't carry process names or ports needed for the map, also enable OBI's application/service-graph metrics for HTTP/gRPC/SQL services and combine both, documenting which question each one answers.

### B. Fallback script for old Linux and Windows servers

- Linux (collect/fallback/depmap-snapshot.sh): every 60 s, run `ss -tnpH` (established TCP), and write a node_exporter textfile collector file with a counter-like gauge per connection, e.g. `depmap_connection_seen{src_host, src_process, src_port_kind="ephemeral|listen", dst_ip, dst_port, direction="out|in"} 1`. Collapse ephemeral client ports. Never record payloads.
- Windows (collect/fallback/depmap-snapshot.ps1): same idea with Get-NetTCPConnection + Get-Process, writing a windows_exporter textfile.
- Include install instructions (cron/systemd timer, Windows scheduled task) and a removal procedure.

### C. The mapping file (collect/mapping.example.yaml)

This is where humans add what traffic can't tell: names, owners, waves and HA groups. Define and validate a schema, e.g.:

```yaml
services:
  - id: oracle-db
    name: oracle-db
    owner: DBA
    wave: 0            # 0 = stays in old DC, 1..n = migration wave
    ha: active-passive # single | active-active | active-passive | quorum
    instances:
      - {host: db01, ip: 10.1.2.11, role: primary}
      - {host: db02, ip: 10.1.2.12, role: standby}
    vip: 10.1.2.10     # optional virtual/cluster address
  - id: portal
    ha: active-active
    minUp: 1
    loadQuery: 'sum(rate(process_cpu_seconds_total{job="portal"}[5m]))'  # optional, for capacity checks
    instances: [{host: app01, ip: 10.1.3.21}, {host: app04, ip: 10.1.3.24}]
external:
  - {match: "ftp.partner.example", name: ftp.partner, owner: Partner}
```

Unmatched IPs show up as "unknown" nodes. Version 1 loads this mapping from the panel options (paste YAML or JSON into the editor). Document how a future datasource (Git file or CMDB) could supply it instead.

## Deliverable 2: the panel

Data it reads (Prometheus range queries over the observation window):

- Edges from OBI network flow metrics and/or depmap_connection_seen, aggregated by source IP/host, destination IP and port.
- Frequency per edge: query with a 1 h step over the window (default 30 days) and classify by the share of hours the edge was seen: constantly / hourly / daily / weekly / monthly. Keep thresholds configurable.
- Volume per edge: bytes per day where available (OBI), else connection count.
- Last seen per edge.
- Load per HA service: from loadQuery in the mapping, as % of total capacity.

Model:

- Nodes are services from the mapping; each has one or more instances (hosts/IPs). IPs not in the mapping become "unknown" nodes (or external, if they match external).
- Edges are service → service. They also keep which instances the caller actually connected to.
- Pinned (hard-wired) client: a caller that only ever connects to one instance of an HA service (not the VIP or other members) is flagged, because failover won't help it. Detect it from the instance-level data. This is one of the most valuable findings, so make it prominent.

Modes (toolbar):

- Map: layout in columns: wave 1…n (moving to new VMs), stays in old DC, external/unknown. Click a service for details. Hover an edge for port, frequency, volume and last seen.
- Failure scenario: each node shows its instances as chips (P/S for primary/standby). Clicking a chip takes that instance down; several can be down at once. Presets for common scenarios. Evaluate:
  - single: instance down → service down
  - active-passive: primary down + standby up → failing over; standby down only → degraded, no failover left; both down → down
  - active-active (minUp): fewer than minUp up → down; otherwise check load: load × n / up > 100% → overloaded, else degraded but up
  - quorum: majority up → degraded but up; otherwise down
  - Then propagate to callers: a caller of a down service, or a caller pinned to a down instance, breaks; their callers break through others (transitively); callers of failing-over or overloaded services are at risk. Show the reason on every affected node ("hard-wired to db01, failover can't help", "quorum lost (1 of 3)", "needs 130% capacity").
- What does it need?: click a service and highlight everything it transitively depends on. That's the set that must move together or stay reachable.

Side panel:

- Scenario summary: counts (out / degraded or at risk / unaffected) and grouped list with reasons.
- Lose one server: automatically try every single instance down, list the ones that take any service out, ranked by impact, with a "Try" button. Also list all hard-wired clients.
- Service details: owner, HA type, instances, inbound/outbound connections, and a wave selector that moves the service between columns live (planning only, not saved to the mapping in v1; offer "Copy updated mapping" instead).
- Firewall rules per wave: for connections that cross between old DC, new VMs and outside once that wave moves, list src host → dst host:port/tcp per instance (every HA node needs its own rule), with a Copy button.
- Easy to miss: rare edges (monthly/weekly) and services/IPs without an owner.

Spec (options → CUE schema):

- queries: roles for edge query (OBI), fallback query, volume query
- mapping: YAML/JSON text (validated against the schema in Deliverable 1C)
- window (default 30d), frequencyThresholds
- lanes: wave labels, and whether to show external/unknown
- edgeFilter: which frequencies to show by default
- linkTemplates: per node (e.g. to a host dashboard) and per edge

Reuse: start from astrona-io/perses-plugin-servicegraph, the owner's existing service graph panel, for graph rendering, pan/zoom and theming. Copy or extract shared code and record the choice in docs/DECISIONS.md.

## Acceptance criteria

- dev/ brings up a small fake legacy estate with docker compose: about 10 "servers" as containers (web, app, db primary + standby, 3-node ldap, mq, nfs, batch jobs including one that only runs "monthly" via an accelerated clock, a hard-wired client), OBI (where the host kernel allows) or the fallback script, Prometheus, Perses, and this plugin with a ready dashboard and mapping file.
- Failure logic is a pure, fully unit-tested module covering every HA type, pinned clients, transitive propagation, overload, and multiple instances down at once. The scenarios from the concept page give the expected results.
- "Lose one server" finds every single point of failure in the dev estate, including both hard-wired clients.
- Firewall rules are correct per wave and per instance. Unit-tested.
- 150 services / 600 edges stay usable (layout under 1 s, smooth hover).
- Readable without colour: states also have text and icons.
- README: a step-by-step "map your legacy estate in 30 days" guide (install collectors, write mapping, wait a month-end, read the map, plan waves, export firewall rules, remove collectors).

## The plugin family this belongs to

This repo is part of the astrona-io Perses plugin set. Already built (read them before you start, and match their structure, tooling, CI and README style): perses-plugin-oat-results, perses-plugin-sankey, perses-plugin-statetimeline, perses-plugin-honeycomb, perses-plugin-geomap, perses-plugin-servicegraph, all under https://github.com/astrona-io.

# Part 2: How to build it (Perses plugin guide)

You are building a Perses plugin in this repository. Perses is the CNCF dashboard project (https://github.com/perses/perses). Its core plugins live in https://github.com/perses/plugins.

## Ground rules

- Copy upstream conventions; don't invent your own. Before writing code, clone perses/plugins next to this repo and read 2–3 plugins close to this one. Panels: timeserieschart, statushistorychart, heatmapchart, table. Datasources: prometheus, tempo, victorialogs. Match their folder layout, package.json (including the perses section), the CUE schema layout, and the rsbuild / module-federation config.
- Scaffold with percli. Never hand-build the directory structure. Check the real flags with `percli plugin --help` and `percli plugin generate --help`. Flags change between releases, so don't trust memory or this file over --help.
  - `percli plugin generate …` scaffolds the module or plugin
  - `percli plugin start` runs it against a local Perses dev server
  - `percli plugin test-schemas` validates the CUE schemas and JSON examples
  - `percli plugin build` produces the distributable archive
- Use the latest stable Perses release. Pin @perses-dev/* package versions to the release you develop against. Write that release in the README.
- Use the shared building blocks: @perses-dev/plugin-system (plugin types and hooks: useDataQueries, time range, variables), @perses-dev/components (UI pieces, legends, tooltips, ECharts wrapper), @perses-dev/core (value formatting, units, thresholds). Reuse the shared CUE types (common.#format, common.#thresholds, …) in schemas.
- Theme-aware only. No hard-coded colours. Use the MUI theme and the Perses chart theme so light and dark mode both work.
- Accessibility. Status must never be shown by colour alone. Use icon, label or pattern too. Everything clickable must be reachable by keyboard.
- Performance. Stay smooth at the "large" size named in Part 1. Memoise transforms. Don't re-render on hover.
- Licence. Apache-2.0, same as Perses. Only add dependencies with compatible licences. Prefer libraries already used upstream (ECharts, MUI).
- Stay upstreamable. Same code style, lint config, tests and docs format as perses/plugins. Before you start, search perses/plugins issues and PRs for this plugin. If someone is already building it, stop and report that.

## Local dev environment

Add a dev/ folder with a docker-compose.yaml that starts Perses (official image), the data backend (Prometheus), and a fake-data generator emitting the metrics in Part 1 with realistic labels and failure cases. Provision a demo dashboard (dev/dashboards/*.json), so `docker compose up` followed by `percli plugin start` shows it working.

## Definition of done

- Scaffolded with percli. Layout matches upstream plugins.
- CUE schema plus at least one JSON example. `percli plugin test-schemas` passes.
- Grafana migration (migrate/ CUE) if Part 1 names a Grafana equivalent.
- Panel options editor for every option in the spec, with sensible defaults.
- Unit tests (Jest + React Testing Library) for data transforms and rendering. Cover the empty state, error state and large-data cases.
- Works in light and dark theme. Includes screenshots of both in docs/.
- `percli plugin build` produces an archive. CI builds it on every PR.
- A GitHub Actions release workflow attaches the archive to a GitHub release on v* tags.
- README covers what it does, install, the data it expects, the options, a screenshot, and the Perses version it was tested with.
- Every acceptance criterion in Part 1 is checked off in the PR description.

## Working style

- Plan first. Write docs/PLAN.md covering the data model, component tree, schema and open questions before writing code.
- Small commits with conventional messages (feat:, fix:, docs:, test:).
- If something in Part 1 is unclear or seems wrong, record your decision in docs/DECISIONS.md and keep going.

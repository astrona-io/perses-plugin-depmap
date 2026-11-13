# perses-plugin-depmap

A [Perses](https://perses.dev) panel plugin, `DependencyMapChart`, for moving old, badly documented
software out of a classic data centre. It draws what really talks to what, discovered from network
traffic rather than documentation, and answers the questions a migration has to answer:

- What breaks if this server or service goes down, with its HA setup (primary/standby, active-active,
  quorum) taken into account?
- Which clients are **hard-wired** to one node of an HA service, so failover cannot help them?
- What does this service need, so it can move together?
- Which connections cross between the old data centre, the new VMs and outside once a wave moves,
  as firewall rules per instance?
- Which dependencies are rare (the monthly batch job) or unknown (the IP nobody owns)?

The data comes from Prometheus, through the upstream Prometheus datasource: network flow metrics from
[OpenTelemetry eBPF Instrumentation](https://opentelemetry.io/docs/zero-code/obi/) (OBI) where it can
run, and a small snapshot script everywhere else. The kit for both is in [collect/](collect/).

![Dark theme, map mode: waves 1 to 3, what stays and what is outside in columns; hard-wired edges dotted; an unknown address flagged; firewall rules for wave 1 in the side panel](docs/images/map-dark.jpg)

![Dark theme, what-if mode with ldap01 and ldap02 down: ldap has lost its quorum, portal is hard-wired to ldap01 and breaks, everything in front of it breaks through it](docs/images/what-if-dark.jpg)

| Light theme, map | Light theme, what if |
| --- | --- |
| ![Light theme, map mode](docs/images/map-light.jpg) | ![Light theme, what-if mode](docs/images/what-if-light.jpg) |

The screenshots come from the [dev/](dev/) stack: a made-up estate of twenty containers with 30 days
of history, collected by the fallback script.

## Supported versions

| Plugin | Perses | Status |
| --- | --- | --- |
| 0.1.x | v0.55.x | Tested with v0.55.1 |

Built against `@perses-dev/*` 0.55.1 and `percli` v0.55.1. Data collection was written against OBI
v1.0.0.

## What it does

The panel has three modes, picked in its toolbar.

**Map.** Services from your mapping in columns: one per migration wave (moving to new VMs), then what
stays in the old data centre, then what is outside (externals and unknown IPs). Each node shows its
name, owner, HA type and instances. Edges point from caller to callee:

| Edge | Means |
| --- | --- |
| solid | seen at least daily |
| dashed | weekly or monthly (rare) |
| dotted, warning colour | hard-wired: the caller only ever connected to one member of an HA service |

Hover an edge for its port, frequency (seen in how many of the window's hours), bytes per day (OBI)
and last seen. Click a service or edge for details in the side panel. Checkboxes in the toolbar hide
frequency classes (constantly, hourly, daily, weekly, monthly / rare), and the panel says how many
edges are hidden.

**What if.** Every node shows its instances as chips (`P` and `S` for primary and standby). Click a
chip to take that instance down, again to bring it back; take down as many as you like, or pick a
preset. The panel evaluates every service:

| HA type | Rule |
| --- | --- |
| `single` | instance down: service down |
| `active-passive` | primary down, standby up: failing over. Standby down only: degraded, no failover left. Both down: down |
| `active-active` | fewer than `minUp` up: down. Otherwise the survivors need `load × n / up` percent: over 100 is overloaded, else reduced |
| `quorum` | a majority up: degraded. Otherwise down |

Then it follows the callers: a caller of a down service breaks, and so does a caller hard-wired to a
down instance even if the service failed over; their callers break through them, transitively. Callers
of a failing-over or overloaded service are at risk. Every affected node says why ("hard-wired to
ldap01, failover can't help", "quorum lost (1 of 3)", "needs 130% capacity"). Every state has a text
label and a symbol, not only a colour: `✕ down`, `↯ breaks`, `⇄ failing over`, `▲ overloaded`,
`◐ degraded`, `◐ reduced`, `△ at risk`, `● ok`.

**Needs.** Click a service to light up everything it depends on, transitively: the set that must move
with it or stay reachable from where it moves to.

The side panel (open by default on wide panels, behind **Show details** on narrow ones) has:

- **Scenario:** counts (out, degraded or at risk, unaffected) and the affected services with reasons.
- **Lose one server:** every single instance tried down on its own; the ones that take any service
  out, worst first, each with a **Try** button. Then every hard-wired client.
- **Service details:** owner, HA type, VIP, load, instances (as toggles in What if), inbound and
  outbound connections, and a wave selector that moves the service between columns live. That is
  planning only; **Copy updated mapping** copies the mapping with the new waves, comments kept.
- **Firewall rules** for a chosen wave: for every connection that crosses between the new VMs, the
  old data centre and outside once that wave has moved, one line per instance
  (`app01 (10.1.1.11) -> ldap01 (10.1.4.1):636/tcp`). Callers of a VIP get a rule to every member and
  the VIP; a hard-wired caller gets only its member. **Copy** puts the list on the clipboard.
- **Easy to miss:** rare edges, addresses nobody owns (shown as `? find owner`), and hard-wired
  instances.

## Data it expects

Two sources, both optional; the panel queries both and merges them. Exact metric and label names are
in [docs/metrics.md](docs/metrics.md).

| Source | Metric | Where |
| --- | --- | --- |
| OBI network flows | `obi_network_flow_bytes_total` with `src_address`, `dst_address`, `server_port` | Linux with kernel 5.8+ (or RHEL 4.18+ with eBPF backports) and BTF, run as root |
| Snapshot script | `depmap_connection_seen` with `src_host`, `src_ip`, `src_process`, `dst_ip`, `dst_port`, `direction` | Any Linux with `ss`, or Windows with PowerShell 5+, through the node_exporter / windows_exporter textfile collector |

The panel runs range queries with a one-hour step over its window (30 days by default). An edge's
frequency class is the share of those hours it was seen in. Prometheus must keep at least the window:
`--storage.tsdb.retention.time=35d`.

### The mapping

Traffic gives IPs and ports. The mapping, pasted into the panel's **Mapping** option as YAML or JSON,
gives them meaning. Start from [collect/mapping.example.yaml](collect/mapping.example.yaml); its schema
is [collect/mapping.schema.json](collect/mapping.schema.json).

```yaml
services:
  - id: db                 # required, unique
    name: orders database  # defaults to id
    owner: DBA team
    wave: 3                # 0 = stays in the old data centre, 1..n = migration wave
    ha: active-passive     # single (default) | active-active | active-passive | quorum
    vip: 10.0.2.10         # optional virtual address
    instances:
      - { host: db01, ip: 10.0.2.1, role: primary }   # role: primary | standby | member
      - { host: db02, ip: 10.0.2.2, role: standby }
  - id: portal
    ha: active-active
    minUp: 1               # active-active: instances that must be up (default 1)
    load: 65               # % of total capacity, or loadQuery: '<PromQL returning %>'
    instances: [{ host: web01, ip: 10.0.1.11 }, { host: web02, ip: 10.0.1.12 }]
external:
  - { match: 198.51.100.21, name: ftp.partner.example.com, owner: partner }  # IP, CIDR or name
```

An address in the traffic that matches no instance, VIP or external is drawn as an unknown node with
its IP. Mistakes in the mapping are listed in the panel with their path; the valid part still draws.

## Options

| Option | Default | |
| --- | --- | --- |
| `datasource` | default Prometheus datasource | A Prometheus datasource selector or variable |
| `queries.edge` | OBI query, see [docs/metrics.md](docs/metrics.md) | Bytes per hour per caller, callee and port. Empty turns it off |
| `queries.fallback` | snapshot script query | Empty turns it off |
| `queries.volume` | none | Bytes per hour per edge from another source |
| `mapping` | `services: []` | The mapping, YAML or JSON |
| `window` | `30d` | Observation window, ending at the dashboard's end time |
| `frequencyThresholds` | `constantly: 0.9`, `hourly: 0.2`, `daily: 0.02`, `weekly: 0.004` | Minimum share of the window's hours per class; less than `weekly` is monthly / rare |
| `lanes.waveLabels` | `Wave 1`, `Wave 2`, … | Label per wave number, e.g. `{"1": "Wave 1 (March)"}` |
| `lanes.stayLabel` | `Stays in old DC` | |
| `lanes.externalLabel` | `External / unknown` | |
| `lanes.showExternal` | `true` | Draw externals and unknown IPs |
| `edgeFilter` | all classes | Frequency classes shown when the panel opens |
| `linkTemplates.node` | none | Link in a service's details. `${service}`, `${name}`, `${host}`, `${hosts}` |
| `linkTemplates.edge` | none | Link in an edge's details. `${source}`, `${target}`, `${port}` |
| `scenarios` | none | Presets: `[{name: "LDAP split", down: [ldap01, ldap02]}]`. Without any, the worst single servers are offered |
| `defaultMode` | `map` | `map`, `failure` (What if) or `needs` |

Every option is in the panel editor. Variables (`$var`) are expanded in the queries.

## Map your legacy estate in 30 days

1. **Day 1: install the collectors.** On every Linux server whose kernel allows it, install OBI with
   `collect/obi/install.sh` (as root; it checks the kernel and stops if OBI cannot run). Everywhere
   else, install the snapshot script with its systemd timer, cron entry or Windows scheduled task.
   Scrape them all from one Prometheus with at least 35 days of retention. Details:
   [collect/README.md](collect/README.md).
2. **Day 1: add the panel.** Install the plugin (below), add a **Dependency Map** panel with the
   Prometheus datasource and an empty mapping. Within minutes it shows unknown nodes, one per IP.
   Check that every server you know appears; a missing one has no working collector.
3. **Week 1: write the mapping.** Start from `collect/mapping.example.yaml`. List services with their
   instances, owners and HA type. Every IP still shown as unknown is a question for someone: find its
   owner and add it as a service or an external. Leave `wave` at 0 for now.
4. **Wait past a month-end.** Monthly and quarterly jobs only show up when they run. Keep the window at
   30 days and check again on the 2nd of the month: new dashed edges are the jobs nobody mentioned.
5. **Read the map.** In **What if**, open **Lose one server**: every entry is a single point of
   failure. The hard-wired clients list shows callers that skip the VIP; fix their configuration
   before the migration or they will break when their node moves. **Easy to miss** collects the rare
   edges and the addresses without an owner.
6. **Plan the waves.** Click a service, use **Needs** to see what must move with it, and set its wave
   in the details. The columns move live. When the plan holds, **Copy updated mapping** and paste it
   into the panel settings, so the plan is saved with the dashboard.
7. **Export the firewall rules.** Pick a wave in **Firewall rules**: the list is every connection that
   crosses zones once it moves, per instance. Copy it into the change request. Repeat per wave.
8. **Remove the collectors** after the migration: `collect/obi/install.sh --remove`, and the removal
   steps for the script in [collect/README.md](collect/README.md). Nothing else was changed on the
   servers.

## Try it locally

The [dev/](dev/) stack starts Perses with the plugin, Prometheus with 30 days of history, and a fake
legacy estate: twenty containers acting as servers (a load balancer, an api gateway, a two-node
portal, billing, a Windows ERP sync, two batch servers, an Oracle primary, a message queue, a
three-node LDAP, NFS, SMTP, two VIPs, two external partners and one address nobody owns). Their
traffic follows [dev/estate/flows.tsv](dev/estate/flows.tsv); their mapping is
[dev/estate/mapping.yaml](dev/estate/mapping.yaml).

It contains the cases the panel is for:

- two hard-wired clients: the portal (both nodes) talks to `ldap01` only, and erp-sync to the Oracle
  primary `db01` instead of the VIP;
- a monthly job: `reports` uploads to a partner FTP on the last day of the month. The servers run on a
  clock 1440 times faster than real time that starts on 30 November 22:00 UTC, so the job runs a few
  seconds after start-up;
- an unknown address (`10.1.7.22`) that the Oracle server calls every night.

**The dev stack collects with the fallback script, not OBI.** OBI needs to create eBPF maps, and a
rootless podman container cannot, even on a kernel with BTF (details in
[docs/DECISIONS.md](docs/DECISIONS.md#3-obi-in-dev-not-possible-under-rootless-podman-the-fallback-script-runs-instead)).
The OBI side of the panel is covered by unit tests.

```bash
npm ci
percli plugin build                    # writes DepMap-0.1.0.tar.gz
cp DepMap-0.1.0.tar.gz dev/archive/
cd dev
podman compose up -d --build           # or docker compose
```

Open <http://localhost:18087/projects/demo/dashboards/dependency-map>. Prometheus is on
<http://localhost:18187>. Stop it with `podman compose down -v`.

The live part of the history runs on the fast clock, so the most recent hours look busier than they
are; the month before it was backfilled at normal speed.

## Install into Perses

Perses extracts every `*.tar.gz` in `plugin.archive_paths` into `plugin.path` at startup. Setting
`archive_paths` replaces the default, so keep the directory of bundled plugins in the list. Pick one
of the options below and restart Perses.

### Option A: release archive

Download `DepMap-<version>.tar.gz` from the
[GitHub releases](https://github.com/astrona-io/perses-plugin-depmap/releases), put it in a directory
Perses can read, and add that directory to the config:

```bash
curl -fLO https://github.com/astrona-io/perses-plugin-depmap/releases/download/v0.1.0/DepMap-0.1.0.tar.gz
curl -fLO https://github.com/astrona-io/perses-plugin-depmap/releases/download/v0.1.0/DepMap-0.1.0.tar.gz.sha256
sha256sum -c DepMap-0.1.0.tar.gz.sha256
```

```yaml
plugin:
  archive_paths:
    - /etc/perses/plugins-archive # plugins bundled with Perses
    - /etc/perses/plugins-archive-depmap # put DepMap-0.1.0.tar.gz here
```

### Option B: Kubernetes image volume

The `Containerfile` packages the archive as a plugin-only OCI image (`FROM scratch`, the archive at the
image root). Every release publishes it as `ghcr.io/astrona-io/perses-plugin-depmap:v<version>` for
linux/amd64 and linux/arm64. Mount it into the Perses pod as an
[image volume](https://kubernetes.io/docs/concepts/storage/volumes/#image) and add the mount path to
`archive_paths` as in option A. Image volumes need a cluster and container runtime that support them
(the `ImageVolume` feature).

```yaml
volumes:
  - name: depmap-plugin
    image:
      reference: ghcr.io/astrona-io/perses-plugin-depmap:v0.1.0
      pullPolicy: IfNotPresent
containers:
  - name: perses
    volumeMounts:
      - name: depmap-plugin
        mountPath: /etc/perses/plugins-archive-depmap
        readOnly: true
```

To build it for your own registry instead:

```bash
percli plugin build
podman build -t ghcr.io/<owner>/perses-plugin-depmap:<version> .
```

### Option C: custom Perses image

Copy the archive into the directory of bundled plugins. No config change is needed:

```dockerfile
FROM persesdev/perses:v0.55.1
COPY DepMap-0.1.0.tar.gz /etc/perses/plugins-archive/
```

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md). In short: `npm ci`, then `npm run lint`, `npm run type-check`,
`npm test`, `percli plugin test-schemas` and `percli plugin build`. The design is in
[docs/PLAN.md](docs/PLAN.md), the choices made along the way in [docs/DECISIONS.md](docs/DECISIONS.md),
and the original spec in [docs/PROMPT.md](docs/PROMPT.md).

## Licences and credits

The plugin is Apache-2.0 (`LICENSE`). Third-party material and its notices are listed in `NOTICE`.
The graph canvas, pan and zoom and theming come from
[perses-plugin-servicegraph](https://github.com/astrona-io/perses-plugin-servicegraph).

# Decisions

Choices made where the spec ([PROMPT.md](PROMPT.md)) left room, or where it did not fit what was
found. Newest last.

## 1. Rendering, pan/zoom and theming copied from perses-plugin-servicegraph

The spec says to start from astrona-io/perses-plugin-servicegraph. Its canvas is ECharts (`graph`
series, the `echarts` instance Perses already ships, `roam` for pan and zoom), themed from the MUI
theme and the Perses chart theme. That code is **copied**, not extracted into a shared package:

- `GraphCanvas.tsx` is servicegraph's canvas wrapper: `init` from the full `echarts` module that
  Perses shares with plugins (the trimmed build behind Perses' `EChart` component has no `graph`
  series), the Perses ECharts theme, resize with the panel, clicks out as ids, options merged so pan
  and zoom survive a refresh. Light and dark come from the theme, never from fixed colours.
- `chart-option.ts` follows servicegraph's option builder and palette (`Palette` built from
  `theme.palette`), with depmap's own lanes, chips and edge styles.

A shared package for two plugins would mean a third repo, a release train and version skew between
the plugins for a 76-line wrapper and a few helpers. If a third plugin needs the canvas, extract it then.
perses-plugin-servicegraph itself was read, never changed.

Not copied: servicegraph's force and hierarchical layouts. A migration map needs fixed columns (waves,
stays, outside), so `layout.ts` places nodes in lanes itself and ECharts gets `layout: "none"`.

## 2. Upstream overlap: perses/plugins #891 (canvas topology)

Searched perses/plugins issues and PRs for dependency map, dependency graph, network map, topology
and impact. The closest is perses/plugins PR #891 (merged), "Generate graphs in canvas from query
data", which lets the canvas panel draw nodes and edges from series labels with a force layout and
threshold colours (it closes perses/perses#4634). It overlaps only in "draw a graph from Prometheus
labels". It has no mapping file, HA model, failure evaluation, pinned-client detection, migration
waves or firewall rules, which are the point of this panel. Nobody is building this panel upstream,
so work went ahead. If the canvas panel grows a generic graph layer, depmap could later render through
it.

## 3. OBI in dev/: not possible under rootless podman, the fallback script runs instead

The spec asks for OBI "where the host kernel allows". The kernel allows it: the podman machine runs
Linux 7.1.4 with BTF (`/sys/kernel/btf/vmlinux`). Rootless podman does not. OBI v1.0.0 started in a
privileged container still failed to create its BPF maps:

```
setupNetO11y: can't start network metrics capture: resolving maps: failed to load shared map:
creating map: map create: operation not permitted (MEMLOCK may be too low, consider rlimit.RemoveMemlock)
```

A rootless container cannot get `CAP_BPF`/`CAP_SYS_ADMIN` in the initial user namespace, and that is
what map creation needs. So **the dev stack runs the fallback script on every fake server, not OBI**.
The OBI code path (default query, label parsing, bytes per day) is covered by unit tests with OBI's
documented label names, and `collect/obi/` is ready for real Linux servers, where it runs as root.

On a rootful Docker or podman host, OBI can be added to the stack; it was not, because the stack has
to come up on a laptop without extra privileges.

## 4. Process names come from the fallback script; OBI application metrics stay off

OBI's network flow metric carries addresses and ports but no process name. The spec says to enable
OBI's application metrics if the map needs process names or ports. It does not: the port is there
(`server.port`), and the mapping names the service behind each IP, so the map works without a process
name. Application metrics would instrument every HTTP, gRPC and SQL process on the server, which is
more change than a dependency inventory should make. They stay off in `collect/obi/config.yaml`; the
fallback script records `src_process` where it runs, and the mapping's `process` field documents it
for the rest.

## 5. Fallback labels: no `src_port_kind`, a `direction` instead

The spec suggests `src_port_kind="ephemeral|listen"`. The script instead never records the client's
ephemeral port at all and writes `direction="out|in"`: `out` when this server called out, `in` when
another address called one of this server's listening ports (then `dst_port` is that listening port).
That is the same information with one label less, and `in` series let a single collector describe
callers that have none. It also writes `src_ip`, because a server with several addresses must still
match the mapping.

## 6. The mapping lives in the panel options (v1)

As the spec says for version 1, the mapping is YAML or JSON text in the panel spec (`mapping`),
validated when parsed (errors are listed in the panel with their path) and described by
`collect/mapping.schema.json` for editors. Changing a wave in the panel is planning only;
"Copy updated mapping" puts the edited YAML, comments kept, on the clipboard.

A future version could read the mapping from a datasource instead, so it is maintained once for many
dashboards:

- a Git file datasource: the panel would fetch `mapping.yaml` through the Perses proxy from a Git
  host's raw endpoint, and "Copy updated mapping" would become a pull request;
- a CMDB datasource: a small Perses datasource plugin that queries the CMDB's API for hosts, owners
  and groups and returns the same structure.

The panel already separates the parsed `Mapping` from where it came from, so either is a new source
for the same type.

## 7. Failure evaluation runs on the edges currently shown

The frequency filter changes which edges exist for the scenario and for "Lose one server". Hiding
monthly edges therefore hides the dependencies of monthly jobs from the failure analysis too. That
is deliberate ("what breaks in normal daily operation"), and the side panel says how many edges are
hidden. With every class shown, as by default, nothing is left out.

## 8. Frequency classes

Share of the window's hours an edge was seen in: constantly at least 0.9, hourly 0.2, daily 0.02,
weekly 0.004, anything less is monthly (rare). Over 30 days that is: hourly means in about 5 of every
24 hours, daily about once a day (14 of 720 hours), weekly about once a week (3 of 720 hours), monthly
one or two hours a month. The classes are configurable (`frequencyThresholds`).

## 9. Hard-wired detection

A caller is hard-wired when it has an HA service as callee and, over the window, connected to exactly
one of that service's instances and never to its VIP. A caller that rotates over the members (as
erp-sync does over ldap in dev/) is not hard-wired. A caller that uses the VIP is never hard-wired,
even if the VIP always routed to the same member, because failover moves the VIP.

## 10. Active-active load

`load` (fixed, in the mapping) or `loadQuery` (instant query at the end of the range) is the
service's load as a percentage of its total capacity with every instance up. With `up` of `n`
instances left, the survivors need `load × n / up` percent. Over 100 is "overloaded" and the
service's callers are at risk; unknown load leaves it "degraded", not overloaded.

## 11. dev/: an accelerated clock and a backfill

A monthly job cannot be waited for. Each fake server runs on a clock 1440 times faster than real time
(one fake day per real minute) that starts at 2026-11-30 22:00 UTC, so the month-end job fires a few
seconds after `compose up`. Before Prometheus starts, a backfill writes 30 days of the same schedule
(from `dev/estate/flows.tsv`) as one sample per hour, so the map opens with a month of history. The
live part then adds an hour of fake time every 2.5 real seconds, which makes the most recent hours
look busier than they are; for a demo that is acceptable, and the classification over 30 days is
unaffected.

Externals keep their real source address: a fake external server adds its public test address
(`198.51.100.x/32`, RFC 5737) to its interface, and the callers route that address to it. So the
servers' snapshots see the same addresses they would in a real network. VIPs work the same way.

## 12. No mockup, a private concept page

There is no `docs/mockup.png`. The spec's concept page is private; [PROMPT.md](PROMPT.md) is the spec,
and the README screenshots were taken from the dev stack.

## 13. The Windows script is untested

`collect/fallback/depmap-snapshot.ps1` writes the same metric and labels as the Linux script, from
`Get-NetTCPConnection` and `Get-Process`. It has not been run on a Windows server for this release;
the README and `collect/README.md` say so.

## 14. No Grafana migration, no Tempo

The spec names no Grafana equivalent panel, so there is no `migrate/` schema. Tempo is optional in the
spec and not used in v1: network flows already give the edges, and traces would only add protocol
detail for instrumented services.

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

## 3. OBI in dev/: rootless podman cannot, the podman machine can

The spec asks for OBI "where the host kernel allows". The kernel allows it: the podman machine runs
Linux 7.1.4 with BTF (`/sys/kernel/btf/vmlinux`). Rootless podman does not. OBI v1.0.0 started in a
privileged rootless container, and as the DaemonSet on a kind cluster whose nodes are rootless podman
containers, fails to create its BPF maps:

```
setupNetO11y: can't start network metrics capture: resolving maps: failed to load shared map:
creating map: map create: operation not permitted (MEMLOCK may be too low, consider rlimit.RemoveMemlock)
```

A rootless container cannot get `CAP_BPF`/`CAP_SYS_ADMIN` in the initial user namespace, and that is
what map creation needs.

- **The VMs** (`dev/docker-compose.yaml`) run the fallback script, as in 0.1.
- **The kind nodes** (0.2, `dev/hybrid.sh`): the same OBI image and config run rootful *inside the
  podman machine*, one container per node, joined to that node's network namespace, with
  `--privileged --pid host` and the `obi` ServiceAccount's token for Kubernetes metadata. That is what
  a `hostNetwork` DaemonSet sees, and it works: the Kubernetes side of the dev estate is observed by
  real OBI. With a rootful runtime (`DEPMAP_OBI=daemonset`), `hybrid.sh` uses the DaemonSet from
  `collect/kubernetes/obi` unchanged. That path was not run here.
- **History**: 30 days of Kubernetes flows cannot be waited for, so `dev/backfill-k8s.mjs` writes
  synthetic history with the label sets OBI reported live. The README says which parts are real.

Running the VMs' OBI the same way was not done: the VMs are 0.1's fallback demo, and the panel merges
both sources anyway.

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

## 15. Identity resolution across the cluster boundary

`resolve.ts`, pure and unit-tested. Every address in a flow is resolved, in this order:

1. **OBI's Kubernetes labels on that side.** `Pod`: its workload (top owner) in its namespace, the
   pod as an instance, its node. `Service`: the workload behind it (the mapped workload that lists the
   Service, or the one named like it). `Node`: the cluster's node group.
2. **Addresses learnt from the labels** of other samples in the window: a pod address seen decorated
   once is that pod when it shows up undecorated (a VM's OBI or the fallback script sees pod
   addresses without labels). Node addresses come from the mapping (`ip`, `addresses`) and from
   `k8s_*_node_ip`.
3. **Pod-range gateways.** Bridge CNIs (kindnet, flannel, the bridge plugin) SNAT hairpin and probe
   traffic to the first address of the node's pod range. The inventory learns each node's `/24` from
   its decorated pods and takes `x.y.z.1` as that node. A range shared by pods of two nodes, or one
   seen only from host-network pods, is skipped. Only for addresses that are not decorated. A guess,
   but a narrow one: without it every kubelet probe drew an unknown address.
4. **NodePort and LoadBalancer.** A node address on a port in a workload's `nodePorts`, or its
   `loadBalancerIp`, is a call to that workload, entering through that node.
5. **The mapping** for everything else (instances, VIPs, externals), as in 0.1. Then unknown.

Unmapped workloads are drawn under their own name and namespace (`k8s:<cluster>/<ns>/<workload>`), so
a cluster with no mapping at all still shows its structure. Pods are instances only while seen in the
last two hours of the window, so a rolled-out ReplicaSet does not leave stale pods behind.

## 16. Stitching: SNAT, ClusterIP and NodePort, and its limits

`stitch.ts`, pure and unit-tested. One connection crossing the cluster boundary shows up more than
once, under different addresses:

| Seen | Done |
| --- | --- |
| pod -> VM, and node -> VM (same node, same destination and port, same hour) | **Egress SNAT.** The node-side hours explained by a pod-side sample are dropped; the edge is drawn from the pod's workload |
| node -> VM in hours no pod-side sample explains | Kept, from **`via node X (NAT, pod unknown)`** (`nat:<cluster>:<node>`), an honest node of its own, not a guess at the pod |
| pod -> Service ClusterIP:port, and pod -> pod:targetPort | **DNAT.** The Service sample is dropped when the same caller reached a pod of the same workload in the same hour; otherwise kept, as an edge to the workload on the Service port |
| VM -> node:nodePort | Kept: it names the client. Drawn as VM -> workload, through that node |
| node -> pod inside the cluster | Dropped (kube-proxy's SNAT with `externalTrafficPolicy: Cluster`, and kubelet probes; they cannot be told apart and name no client) |
| node <-> node, pod -> its own node, hidden namespaces | Dropped as plumbing |

Limits:

- **Granularity is one hour**, the query step. Two flows from the same node to the same address and
  port in the same hour are taken to be one connection. When a pod and something on the node itself
  (a host process) both call the same VM port in the same hour, the host process's traffic is folded
  into the pod's edge.
- **The VM side alone cannot be stitched.** A VM's fallback script sees `node -> VM`. Without OBI on
  that node the pod is unknown; that is the NAT node.
- **Inbound NodePort with `externalTrafficPolicy: Cluster`**: kube-proxy may forward to a pod on
  another node. The panel draws VM -> workload, not VM -> pod; the node it entered is recorded (see
  #17). With `Local`, the pod is on that node anyway.
- **LoadBalancer**: a call to `loadBalancerIp` is a call to the workload. Which node the load balancer
  picked is not visible from the flow; firewall rules list the LoadBalancer address.
- **Ingress controllers** are workloads like any other: VM -> ingress controller -> backend shows as
  two hops, which is what the network does.
- **Egress gateways and cloud NAT**: with `egressIps` in the mapping, those addresses are the cluster
  for firewall rules. Stitching across a separate egress gateway node works only when OBI runs on it.

## 17. Pinned NodePort callers

0.1 called a caller hard-wired when it only ever reached one member of an HA service. 0.2 applies the
same rule to NodePorts: a VM that only ever called one node's NodePort (a hard-coded node address
instead of a load balancer) is pinned to that node. In **What if**, that node down breaks the VM,
even though the workload survives on the other nodes. Pod-to-pod traffic is never pinned: the
Service picks the pod, so failover works.

A node down takes its pods down with it. The workload is then judged by its HA rule against the
desired `replicas` (missing pods count as down), and its reason notes that Kubernetes reschedules the
pods (about five minutes after a node is lost, with default tolerations). The panel shows the
moment after the loss, which is what a migration has to survive.

## 18. Firewall rules at the cluster boundary

A cluster is a zone of its own. Pods are never in a rule; their addresses change.

- Out of the cluster: from the mapping's `egressIps`, else from **every node address**, because a pod
  can run on any node. The NAT node: only its own node address.
- Into the cluster: to every node address on the NodePort, or only the pinned node for a pinned
  caller, and to the LoadBalancer address when there is one.
- Inside the cluster: no rules; that is NetworkPolicy, not the data-centre firewall.

## 19. Instance chip ids are per service

ECharts needs unique node ids. 0.1 named instance chips `chip:<host>`. In a hybrid estate one node
host appears as an instance of the cluster's node group and of its NAT node, and the duplicate id
crashed the chart (`Cannot set properties of undefined (setting 'dataIndex')`). Chips are now
`chip:<service>|<host>`; a click still takes the host down, so both chips go down together.

## 20. dev/: what the hybrid estate adds to the mapping

- `monitoring` (`mon01`, `10.1.0.9`): Prometheus scrapes OBI on the kind nodes over the old data
  centre network, so that traffic is mapped instead of drawn as an unknown address.
- `hideNamespaces: [kube-system, local-path-storage, depmap]`: kind's storage provisioner and the
  collector itself are plumbing, like `kube-system`.

## 21. OBI network attributes beyond flow edges

Checked against the OBI v1.0.0 network metrics docs, as asked for 0.2. Used: `src.cidr`/`dst.cidr`
(an edge lists the named ranges it crosses) and the Kubernetes attributes, node of each pod
included. Not used: `iface` and `iface.direction` (optional, one series per interface per flow and
every pod has its own veth; they tell the interface, not the zone), the inter-zone metric (computed
from cloud availability-zone node labels, which an on-premises estate does not have). OBI's network
metrics carry no TCP-level detail (retransmits, RTT). That is not enough for a separate network view,
so there is none; details in [metrics.md](metrics.md).

## 22. Default edge query: `max by`, not `sum by`

With OBI on every node and on VMs, one flow is counted by more than one OBI (both ends of a pod-to-pod
flow across nodes; the node and the VM for SNATed traffic). Summing doubled them. `max by` over the
full label set keeps one count per distinct flow description; stitching then removes the remaining
duplicates. Custom `queries.edge` from 0.1 keep working.

## 23. Estate view first, lanes kept

The lanes view answers migration questions (waves, firewall rules, What if) but not "where does this
run and what is around it" in a mostly-Kubernetes estate with storage, load balancers and the
internet. The estate view is a drill-down (estate, cluster, machine, namespace, workload) plus a page
per place and a dependency view. It is the map's default; lanes, What if and Needs are unchanged and
one click away. The mapped servers (VMs, bare metal) are a place in the estate with a button to the
lanes view, which is where their waves and firewall rules live.

## 24. Places are matched by address, in a fixed order

An address that is not a mapped instance or a pod is put in a place: load balancer, then storage, then
"clients" (it only ever calls, never is called), then LAN, then internet provider; what is left is
"other private" or "other internet" by RFC 1918 and friends. Load balancers and storage first, because
they usually sit inside a LAN range; clients before LANs, because a phone on the home LAN calling in is
a client, not a server on the LAN. The order is not configurable: one rule, written down, beats an
option nobody sets.

## 25. Rates over the window, split over instance pairs

Bytes are averaged over the window and shown per second (configurable), instead of per day: a day is
the wrong unit for a 6-hour dashboard. Where an edge joins several instance pairs (a workload on three
nodes calling a VIP), its rate is split evenly over them for the machine-level lines. That is an
estimate; the true split is not in the metric, and the side panel says so.

## 26. Unmeasured links are dashed, never invented

A load balancer appliance runs no collector, so its forwarding to the cluster is not in any flow.
`forwardsTo` in the mapping draws it dashed and labelled "not measured", without a rate. A flow that
confirms it turns the line solid.

## 27. Navigation state lives in the panel

Drill-down position, hops, expanded rows and Hide monitoring are React state in the panel, not URL
parameters or dashboard variables: Perses has no API for a panel to own query parameters, and writing
variables from a panel would change every other panel on the dashboard.


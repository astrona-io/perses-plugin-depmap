# Metrics the panel reads

The panel runs range queries with a one-hour step over its window (30 days by default) through a
Prometheus datasource. Two sources feed it; the panel queries both and merges the result, so an
estate can mix them server by server.

## OBI network flow metrics

Source: [OpenTelemetry eBPF Instrumentation](https://opentelemetry.io/docs/zero-code/obi/) (OBI)
v1.0.0, network metrics (`metrics.features: [network]`), exported on OBI's Prometheus endpoint
(`prometheus_export`). Names and attributes were taken from the OBI v1.0.0 documentation and its
attribute reference, not guessed. The configuration is in
[collect/obi/config.yaml](../collect/obi/config.yaml).

| OpenTelemetry name | Prometheus name | Type |
| --- | --- | --- |
| `obi.network.flow.bytes` | `obi_network_flow_bytes_total` | counter, bytes |

On the Prometheus endpoint, attribute dots become underscores (`src.address` is `src_address`).

Attributes the panel uses. All of them except `direction` are **hidden by default** because of their
cardinality; the shipped configs (`collect/obi/config.yaml`, `collect/kubernetes/obi/config.yaml`)
turn them on under `attributes.select.obi_network_flow_bytes.include`.
Without that block the metric exists but the panel has no addresses to draw.

| Attribute | Prometheus label | Meaning | Used for |
| --- | --- | --- | --- |
| `direction` | `direction` | `request`, `response` or `unknown`: which side of the flow, from initiator and port heuristics | The default query keeps `request` only, so an edge points from client to server |
| `src.address` | `src_address` | Source IP of the flow | Caller |
| `dst.address` | `dst_address` | Destination IP of the flow | Callee |
| `server.port` | `server_port` | The server side's port | Port of the edge and of the firewall rule |
| `dst.name` | `dst_name` | The name OBI has for the destination (selected, optional) | Matching `external` entries by name as well as by address |

| `src.cidr`, `dst.cidr` | `src_cidr`, `dst_cidr` | The name of the `network.cidrs` range each side is in | Shown on an edge: which ranges (old DC, pods, Services, internet) a connection crosses |
| `obi.ip` | `obi_ip` | The address of the host whose OBI reported the flow | Not in the default query; useful to tell which node saw a flow |
| `k8s.cluster.name` | `k8s_cluster_name` | Cluster name (`OTEL_EBPF_KUBE_CLUSTER_NAME`, or detected) | Matching the mapping's clusters |
| `k8s.src.type`, `k8s.dst.type` | `k8s_src_type`, `k8s_dst_type` | `Pod`, `Service` or `Node` | Which resolution applies to that side |
| `k8s.src.namespace`, `k8s.dst.namespace` | `k8s_src_namespace`, `k8s_dst_namespace` | Namespace (empty for a node) | Grouping, matching workloads, hidden namespaces |
| `k8s.src.name`, `k8s.dst.name` | `k8s_src_name`, `k8s_dst_name` | Pod, Service or node name | Instances of a workload (pods), the node a NodePort call entered |
| `k8s.src.owner.name`, `k8s.dst.owner.name` | `k8s_src_owner_name`, `k8s_dst_owner_name` | The pod's top owner (Deployment, StatefulSet, DaemonSet, ...); the Service or node itself otherwise | Matching `kubernetes.services[].workload` |
| `k8s.src.owner.type`, `k8s.dst.owner.type` | `k8s_src_owner_type`, `k8s_dst_owner_type` | `Deployment`, `StatefulSet`, `Service`, `Node`, ... | Shown as the workload's kind |
| `k8s.src.node.name`, `k8s.dst.node.name` | `k8s_src_node_name`, `k8s_dst_node_name` | Node a pod runs on | SNAT stitching (same node), node failure taking its pods down |
| `k8s.src.node.ip`, `k8s.dst.node.ip` | `k8s_src_node_ip`, `k8s_dst_node_ip` | That node's address | Recognising the node's own addresses |

The Kubernetes attributes appear only with Kubernetes metadata on (`attributes.kubernetes.enable`,
`OTEL_EBPF_KUBE_METADATA_ENABLE`) and only when selected; the label sets above are the ones OBI v1.0.0
reported in `dev/` on a kind cluster. A side that is neither a pod, a Service nor a node (a VM, the
internet) has no `k8s_*` labels.

`network.guess_ports: ordinal` is required: port guessing is off by default since OBI v0.7.0, and
without it `server_port` is empty or `0`.

Default edge query (option `queries.edge`):

```promql
max by (src_address, dst_address, server_port, dst_name, src_cidr, dst_cidr,
        k8s_cluster_name,
        k8s_src_type, k8s_src_namespace, k8s_src_name, k8s_src_owner_name, k8s_src_owner_type,
        k8s_src_node_name, k8s_src_node_ip,
        k8s_dst_type, k8s_dst_namespace, k8s_dst_name, k8s_dst_owner_name, k8s_dst_owner_type,
        k8s_dst_node_name, k8s_dst_node_ip) (
  increase(obi_network_flow_bytes_total{direction="request"}[1h])
) > 0
```

`max by`, not `sum by` (0.1 used `sum`): with OBI on every node, a pod-to-pod flow across two nodes is
counted by both nodes' OBI, and a VM's OBI counts the same flow as the node's. Summing would double
them. The labels without a Kubernetes side are empty and group as one, so a VM estate without
Kubernetes gets the same result as before. (The panel keeps the query as one line; it is wrapped here
for reading.)

### What OBI offers beyond flow edges, and what the panel uses

Checked against the OBI v1.0.0 network metrics documentation:

| OBI provides | Used |
| --- | --- |
| `src.cidr` / `dst.cidr` from `network.cidrs` | Yes: an edge shows the ranges it crosses (`old-dc -> pods`) |
| Kubernetes attributes on the flow metric, including the node of each pod | Yes, above |
| `obi.ip`, the reporting host | Selected in the shipped configs, not read by the default query |
| `iface`, `iface.direction` (network interface and ingress/egress on it) | No. Optional, high cardinality (one series per interface per flow, and every pod has its own veth); it says which interface, not which zone. Add it to `include` if you want it in Prometheus |
| `transport` | Not selected: TCP and UDP are summed |
| An inter-zone metric | Not usable here: it is computed from cloud availability-zone node labels, which an on-premises estate does not have |
| TCP-level detail (retransmits, RTT, connection states) | Not provided by OBI's network metrics |

Each sample is bytes in that hour; an hour with a sample counts as "seen" for the frequency class,
and the sum over the window divided by its length in seconds gives the average rate, shown per
second, minute or hour.

What OBI's network metrics do **not** carry is the process name. The map does not need it (the
mapping names the service behind each IP), and the fallback script records it where it runs. OBI's
application metrics (HTTP, gRPC, SQL spans and their service graph) would add process and protocol
detail, but they instrument every process on the server, which is more than a dependency inventory
needs. Version 1 leaves them off; see [DECISIONS.md](DECISIONS.md).

## Fallback script

Source: [collect/fallback/depmap-snapshot.sh](../collect/fallback/depmap-snapshot.sh) (Linux, `ss`) or
[depmap-snapshot.ps1](../collect/fallback/depmap-snapshot.ps1) (Windows, `Get-NetTCPConnection`), once a
minute, through the node_exporter or windows_exporter textfile collector.

| Metric | Type | Value |
| --- | --- | --- |
| `depmap_connection_seen` | gauge | `1` while a TCP connection of this kind was seen in the last `DEPMAP_RETAIN` seconds (300 by default) |
| `depmap_snapshot_last_run_timestamp_seconds` | gauge | Unix time of the last run, label `src_host` |

Labels of `depmap_connection_seen`:

| Label | Meaning |
| --- | --- |
| `src_host` | The server that ran the script (`hostname -s`, or `DEPMAP_HOST`) |
| `src_ip` | This server's address on the connection |
| `src_process` | The local process (`ss -p` as root; empty without root) |
| `dst_ip` | The other end's address |
| `dst_port` | `out`: the remote server port. `in`: this server's listening port |
| `direction` | `out`: this server called `dst_ip`. `in`: `dst_ip` called this server |

The client's ephemeral port is never a label: one series per caller, callee and server port, however
many connections there are. Inbound series let a server with the script describe callers that have
no collector of their own; the panel turns them around (caller `dst_ip`, callee `src_ip`).

Default fallback query (option `queries.fallback`):

```promql
max by (src_ip, src_host, src_process, dst_ip, dst_port, direction) (
  max_over_time(depmap_connection_seen[1h])
)
```

There is no byte count. Edges from the fallback show how often they were seen, not volume.

## Optional queries

- `queries.volume`: bytes per hour per edge from somewhere else, with the labels `src_address`,
  `dst_address` and `server_port`. Used when the edge query does not carry bytes.
- `loadQuery` per service in the mapping: an instant query giving the service's load as a percentage
  of its total capacity, for the active-active overload check. A fixed `load` in the mapping does the
  same without a query.

## Retention

Prometheus must keep at least the panel's window: `--storage.tsdb.retention.time=35d` for the default
30 days. A monthly batch job appears only if the month-end is inside the retention.

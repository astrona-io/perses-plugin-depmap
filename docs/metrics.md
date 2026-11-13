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
cardinality; `collect/obi/config.yaml` turns them on under `attributes.select.obi_network_flow_bytes.include`.
Without that block the metric exists but the panel has no addresses to draw.

| Attribute | Prometheus label | Meaning | Used for |
| --- | --- | --- | --- |
| `direction` | `direction` | `request`, `response` or `unknown`: which side of the flow, from initiator and port heuristics | The default query keeps `request` only, so an edge points from client to server |
| `src.address` | `src_address` | Source IP of the flow | Caller |
| `dst.address` | `dst_address` | Destination IP of the flow | Callee |
| `server.port` | `server_port` | The server side's port | Port of the edge and of the firewall rule |
| `dst.name` | `dst_name` | The name OBI has for the destination (selected, optional) | Matching `external` entries by name as well as by address |

Other attributes exist (`src.name`, `transport`, `iface`, `iface.direction`, `dst.port`,
`src.cidr`/`dst.cidr` when `network.cidrs` is set, Kubernetes attributes). The panel does not need
them. `transport` is not selected, so UDP and TCP flows are summed together.

Default edge query (option `queries.edge`):

```promql
sum by (src_address, dst_address, server_port, dst_name) (
  increase(obi_network_flow_bytes_total{direction="request"}[1h])
) > 0
```

Each sample is bytes in that hour; an hour with a sample counts as "seen" for the frequency class,
and the sum over the window divided by its days gives bytes per day.

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

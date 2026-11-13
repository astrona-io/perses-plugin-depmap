# Collecting the connections

The Dependency map panel reads Prometheus. Something on each server has to report who it talks to.
There are two collectors, OBI and a fallback script, and you can mix them across the estate: the panel
queries both and merges the result. OBI runs in three ways:

| Mode | Where | How |
| --- | --- | --- |
| a. Container | A Docker or Podman host (rootful) | [container/compose.yaml](container/compose.yaml) |
| b. DaemonSet | Every node of a Kubernetes cluster | `kubectl apply -k kubernetes/obi` |
| c. On the server | A Linux server | `obi/install.sh`, a systemd unit |

Where none of them can run, the fallback script does.

**What is eBPF, in one paragraph.** eBPF lets a small, verified program run inside the Linux kernel.
OBI loads one that counts the bytes of every network flow as the kernel handles it: no proxy, no
packet copies, no change to the applications. That is why it needs root (or a privileged container)
and a kernel with BTF type information, and why it sees every connection, however short.

| | OBI (preferred) | Fallback script |
| --- | --- | --- |
| What | [OpenTelemetry eBPF Instrumentation](https://opentelemetry.io/docs/zero-code/obi/) network metrics | `ss` (Linux) or `Get-NetTCPConnection` (Windows) once a minute |
| Needs | Linux kernel 5.8+ with BTF, root or eBPF capabilities | bash and iproute2, or PowerShell 5+; node_exporter or windows_exporter |
| Sees | every flow, with bytes | connections open at the moment of a snapshot (plus a 5 minute memory) |
| Misses | nothing on supported kernels | connections shorter than the snapshot interval |
| Metric | `obi_network_flow_bytes_total` | `depmap_connection_seen` |

Metric names and labels are listed in [docs/metrics.md](../docs/metrics.md).

Prometheus must keep **at least as much history as the panel's window** (30 days by default):
`--storage.tsdb.retention.time=35d` or more. A batch job that runs once a month needs a month of
data to show up at all.

## OBI on a server (mode c)

```bash
# on each Linux server, as root
sudo ./obi/install.sh            # downloads OBI v1.0.0, checks its SHA-256, installs a systemd unit
sudo ./obi/install.sh --remove   # removes everything it installed
```

The script checks the kernel (5.8+, `/sys/kernel/btf/vmlinux`) and stops if OBI cannot run there;
use the fallback on those servers. It installs:

- `/usr/local/bin/obi`
- `/etc/obi-depmap/config.yaml` (from [obi/config.yaml](obi/config.yaml): network metrics only, no
  application instrumentation, the address and port labels the panel needs)
- `obi-depmap.service`, which exports on port 9400

Then scrape it:

```yaml
scrape_configs:
  - job_name: obi
    static_configs:
      - targets: ["10.0.1.11:9400", "10.0.1.12:9400"]
```

Keep the `attributes.select` block from `obi/config.yaml`, or the panel has no addresses to draw,
and `network.guess_ports: ordinal`, or OBI leaves the server port empty.

## OBI in a container (mode a)

On a host that runs containers, one OBI container sees the host's own connections and every
container's: it shares the host's process list and network.

```bash
# on the container host, with a rootful engine
docker compose -f container/compose.yaml up -d      # or: sudo podman compose -f ... up -d
docker compose -f container/compose.yaml down       # removes it again
```

What the compose file sets, and why:

| Setting | Why |
| --- | --- |
| `privileged: true` | Loading eBPF programs and maps needs it (OBI docs: run as a privileged container, or grant the capabilities the enabled features need) |
| `pid: host` | OBI sees the host's processes (OBI docs) |
| `network_mode: host` | OBI sees the host's interfaces, so every container's traffic, and serves its metrics on the host's port 9400. The same reason the Kubernetes DaemonSet uses `hostNetwork` |
| `OTEL_EBPF_CONFIG_PATH` | The same `obi/config.yaml` as on a server |

Rootless Docker and rootless Podman cannot create the eBPF maps; OBI then stops with
`map create: operation not permitted`. Use the fallback script on such hosts.

Scrape `<host>:9400` as in mode c.

## OBI on Kubernetes (mode b)

One OBI per node, as a DaemonSet, with Kubernetes metadata on every flow: which namespace, pod,
workload (Deployment, StatefulSet, DaemonSet, ...) and node each side is.

```bash
# edit kubernetes/obi/config.yaml and daemonset.yaml first: your cluster name, your ranges
kubectl apply -k kubernetes/obi
kubectl -n depmap rollout status daemonset/obi
kubectl delete -k kubernetes/obi    # removes it again
```

The kustomization creates:

- namespace `depmap`;
- ServiceAccount `obi`, ClusterRole and ClusterRoleBinding `depmap-obi`: `list` and `watch` on pods,
  services, nodes and replicasets. Read-only; OBI needs them to decorate flows (a ReplicaSet leads
  from a pod to its Deployment);
- ConfigMap `obi-depmap-config` from [kubernetes/obi/config.yaml](kubernetes/obi/config.yaml);
- DaemonSet `obi`: `hostNetwork: true` (it must see the node's interfaces: the pod side of a flow on
  the pod's veth, and the same flow after SNAT on the uplink), `hostPID`, privileged, tolerating every
  taint so control-plane nodes are covered too, metrics on each node's port 9400.

Settings to check:

| Where | Key | |
| --- | --- | --- |
| `daemonset.yaml` | `OTEL_EBPF_KUBE_CLUSTER_NAME` | The cluster's name as the mapping names it (`k8s_cluster_name`) |
| `daemonset.yaml` | `OTEL_EBPF_KUBE_METADATA_ENABLE: "true"` | Turns on Kubernetes metadata |
| `config.yaml` | `attributes.kubernetes.enable: true` | The same, in the config file |
| `config.yaml` | `attributes.select.obi_network_flow_bytes.include` | The `k8s.*` attributes the panel reads |
| `config.yaml` | `network.cidrs` | Your pod, Service, node and old data centre ranges, named |
| `config.yaml` | `network.guess_ports: ordinal` | Required, or `server_port` stays empty |

Scrape every node, for example with Kubernetes service discovery:

```yaml
scrape_configs:
  - job_name: obi
    kubernetes_sd_configs: [{ role: node }]
    relabel_configs:
      - source_labels: [__address__]
        regex: "([^:]+):.*"
        target_label: __address__
        replacement: "$1:9400"
```

What you get on the map: pod to pod, pod to Service and pod to outside, each named by namespace and
workload; calls from outside the cluster to a node's NodePort; and pod traffic leaving the cluster
under its node's address (SNAT), stitched back to the pod. Then add the cluster to the mapping
(below).

Kubernetes limits:

- A node without OBI shows its pods' outbound calls only as the node calling, after SNAT: the panel
  draws them from **via node X (NAT, pod unknown)**.
- Inbound NodePort traffic with `externalTrafficPolicy: Cluster` is forwarded to a pod on any node,
  under the node's address again. That leg cannot be told from kubelet probes, so the panel draws the
  call as caller -> workload through the node it entered, not to one particular pod.
- On clusters running Cilium, keep `network.source: socket_filter`, as the OBI docs advise. This
  project ran this image and config on kind (kindnet) only, not on other CNIs.

## Fallback: Linux

Needs node_exporter with the textfile collector
(`--collector.textfile.directory=/var/lib/node_exporter/textfile_collector`).

```bash
sudo install -m 0755 fallback/depmap-snapshot.sh /usr/local/bin/depmap-snapshot.sh
# with systemd
sudo install -m 0644 fallback/depmap-snapshot.service fallback/depmap-snapshot.timer /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now depmap-snapshot.timer
# or with cron
sudo install -m 0644 fallback/depmap-snapshot.cron /etc/cron.d/depmap-snapshot
```

Remove:

```bash
sudo systemctl disable --now depmap-snapshot.timer
sudo rm -f /etc/systemd/system/depmap-snapshot.{service,timer} /etc/cron.d/depmap-snapshot \
  /usr/local/bin/depmap-snapshot.sh /var/lib/node_exporter/textfile_collector/depmap.prom
sudo rm -rf /var/lib/depmap
```

Settings are environment variables, documented at the top of the script: `DEPMAP_TEXTFILE`,
`DEPMAP_STATE`, `DEPMAP_RETAIN` (seconds a connection is remembered, default 300), `DEPMAP_HOST`,
`DEPMAP_IGNORE_PORTS` (e.g. `"22 9100"` to leave SSH and the exporter itself off the map).

The script only reads `ss`; it opens no connections. Run as root to get process names; without root
everything else still works.

## Fallback: Windows

Needs [windows_exporter](https://github.com/prometheus-community/windows_exporter) with the textfile
collector (on by default, directory `C:\Program Files\windows_exporter\textfile_inputs`).

```powershell
# in an elevated PowerShell
.\fallback\depmap-snapshot.ps1 -Install   # copies itself to C:\ProgramData\depmap, scheduled task every minute as SYSTEM
.\fallback\depmap-snapshot.ps1 -Remove    # removes the task, the copy and the output file
```

The PowerShell script writes the same metric with the same labels as the Linux one. It has not been
run on a real Windows server by this project yet; please report problems.

## Mapping

Traffic gives IPs and ports. Names, owners, migration waves and HA groups come from the mapping you
paste into the panel's options: start from [mapping.example.yaml](mapping.example.yaml). Its structure
is in [mapping.schema.json](mapping.schema.json). For Kubernetes, the `kubernetes` section lists each
cluster with its node names and node addresses, and the workloads by namespace and workload name; no
pod addresses.

## What these collectors do not do

- No packet payloads are read, only addresses, ports, process names and (OBI) byte counts.
- UDP is not collected by the fallback script; OBI reports it with `transport="udp"` but the panel's
  default query does not filter on transport.
- Connections between two processes on the same server (loopback) are left out.

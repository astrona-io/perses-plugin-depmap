# Collecting the connections

The Dependency map panel reads Prometheus. Something on each server has to report who it talks to.
There are two ways to do that, and you can mix them across the estate: the panel queries both and
merges the result.

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

## OBI

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

OBI also runs as a container or a Kubernetes DaemonSet; see its documentation. Keep the
`attributes.select` block from `obi/config.yaml`, or the panel has no addresses to draw.

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
is in [mapping.schema.json](mapping.schema.json).

## What these collectors do not do

- No packet payloads are read, only addresses, ports, process names and (OBI) byte counts.
- UDP is not collected by the fallback script; OBI reports it with `transport="udp"` but the panel's
  default query does not filter on transport.
- Connections between two processes on the same server (loopback) are left out.

#!/usr/bin/env bash
# depmap-snapshot.sh: one snapshot of this server's TCP connections, written as Prometheus metrics for
# node_exporter's textfile collector. The fallback for servers where OBI cannot run (old kernels, no
# BTF, no root for eBPF). Run it every minute from cron or the systemd timer next to this file.
#
# It reads `ss` (iproute2) and never opens a connection itself. Output, one series per connection kind:
#
#   depmap_connection_seen{src_host, src_ip, src_process, dst_ip, dst_port, direction} 1
#
#   direction="out": this server called dst_ip:dst_port.
#   direction="in":  dst_ip called this server on its listening port dst_port (useful when the
#                    caller has no collector of its own).
#
# A connection stays in the file for DEPMAP_RETAIN seconds after it was last seen, so a job that
# connects for a few seconds between two snapshots is still scraped. Connections shorter than the
# snapshot interval can be missed: that is the price of not using eBPF.
#
# Settings (environment):
#   DEPMAP_TEXTFILE   output file. Default /var/lib/node_exporter/textfile_collector/depmap.prom
#   DEPMAP_STATE      state file. Default /var/lib/depmap/state
#   DEPMAP_RETAIN     seconds a connection is kept after it was last seen. Default 300
#   DEPMAP_HOST       src_host label. Default: hostname -s
#   DEPMAP_IGNORE_PORTS  space-separated local ports to ignore entirely (e.g. "22 9100")
#
# Needs: bash 4+, ss (iproute2), awk. Run as root to get process names (ss -p); without root the
# src_process label is empty and everything else still works.
set -euo pipefail

TEXTFILE="${DEPMAP_TEXTFILE:-/var/lib/node_exporter/textfile_collector/depmap.prom}"
STATE="${DEPMAP_STATE:-/var/lib/depmap/state}"
RETAIN="${DEPMAP_RETAIN:-300}"
HOST="${DEPMAP_HOST:-$(hostname -s 2>/dev/null || hostname)}"
IGNORE="${DEPMAP_IGNORE_PORTS:-}"
NOW="$(date +%s)"

mkdir -p "$(dirname "$TEXTFILE")" "$(dirname "$STATE")"
touch "$STATE"

# Listening ports: a connection whose local port is one of these is inbound.
listening="$(ss -Htln 2>/dev/null | awk '{ n = split($4, a, ":"); print a[n] }' | sort -u | tr '\n' ' ')"

# Established TCP connections: local, peer, process. -n numeric, -p processes (root only).
current="$(ss -Htnp state established 2>/dev/null || ss -Htn state established)"

new_state="$(mktemp "${STATE}.XXXXXX")"
trap 'rm -f "$new_state" "${TEXTFILE}.$$"' EXIT

{
  # Fresh observations: key<TAB>last_seen
  printf '%s\n' "$current" | awk -v host="$HOST" -v now="$NOW" -v listening="$listening" -v ignore="$IGNORE" '
    function split_addr(s, out,   n) {
      # [v6]:port, v4:port or ::ffff:v4:port
      n = match(s, /:[0-9]+$/)
      out["port"] = substr(s, RSTART + 1)
      out["ip"] = substr(s, 1, RSTART - 1)
      gsub(/^\[|\]$/, "", out["ip"])
      sub(/^::ffff:/, "", out["ip"])
      sub(/%.*$/, "", out["ip"])
    }
    BEGIN {
      n = split(listening, l, " "); for (i = 1; i <= n; i++) listen[l[i]] = 1
      n = split(ignore, g, " "); for (i = 1; i <= n; i++) skip[g[i]] = 1
    }
    NF >= 4 {
      # With "state established" ss prints: Recv-Q Send-Q Local Peer [Process]
      split_addr($3, loc); split_addr($4, peer)
      if (loc["ip"] ~ /^127\./ || loc["ip"] == "::1" || peer["ip"] ~ /^127\./ || peer["ip"] == "::1") next
      if (loc["port"] in skip) next
      proc = ""
      if (match($0, /users:\(\("[^"]+"/)) { proc = substr($0, RSTART + 9, RLENGTH - 10) }
      if (loc["port"] in listen) {
        key = sprintf("src_host=\"%s\",src_ip=\"%s\",src_process=\"%s\",dst_ip=\"%s\",dst_port=\"%s\",direction=\"in\"", host, loc["ip"], proc, peer["ip"], loc["port"])
      } else {
        key = sprintf("src_host=\"%s\",src_ip=\"%s\",src_process=\"%s\",dst_ip=\"%s\",dst_port=\"%s\",direction=\"out\"", host, loc["ip"], proc, peer["ip"], peer["port"])
      }
      print key "\t" now
    }'
  # Earlier observations still within the retention window.
  awk -F'\t' -v now="$NOW" -v retain="$RETAIN" 'NF == 2 && now - $2 <= retain' "$STATE"
} | awk -F'\t' '{ if (!($1 in seen) || $2 > seen[$1]) seen[$1] = $2 } END { for (k in seen) print k "\t" seen[k] }' \
  | sort >"$new_state"
mv "$new_state" "$STATE"

{
  echo "# HELP depmap_connection_seen 1 while a TCP connection of this kind was seen in the last DEPMAP_RETAIN seconds."
  echo "# TYPE depmap_connection_seen gauge"
  awk -F'\t' '{ print "depmap_connection_seen{" $1 "} 1" }' "$STATE"
  echo "# HELP depmap_snapshot_last_run_timestamp_seconds When depmap-snapshot.sh last ran."
  echo "# TYPE depmap_snapshot_last_run_timestamp_seconds gauge"
  echo "depmap_snapshot_last_run_timestamp_seconds{src_host=\"$HOST\"} $NOW"
} >"${TEXTFILE}.$$"
# Atomic: node_exporter never reads a half-written file.
mv "${TEXTFILE}.$$" "$TEXTFILE"

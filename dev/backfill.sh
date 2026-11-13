#!/bin/sh
# Writes 30 days of history for the example estate into Prometheus's data directory before Prometheus
# starts, so the map has a month to classify (constantly / hourly / daily / weekly / monthly) the
# moment the stack is up. Runs in the prom/prometheus image (busybox sh, awk, promtool).
#
# One sample per hour in which a flow ran, at half past, with the labels depmap-snapshot.sh writes
# (direction="out", plus the job and instance Prometheus adds when it scrapes node_exporter). The
# schedules follow the same rules as the servers and src/test-utils/estate.ts, in real time.
# History ends one hour before now; the live servers take over from there.
set -eu
DAYS="${DEPMAP_BACKFILL_DAYS:-30}"
OUT=/prometheus
if [ -f "$OUT/.depmap-backfilled" ]; then
  echo "backfill: already done"
  exit 0
fi
now="$(date +%s)"
end=$((now / 3600 - 1))
start=$((end - DAYS * 24 + 1))
tmp="$(mktemp -d)"

awk -F'\t' -v start="$start" -v end="$end" '
  # days since 1970-01-01 to day of month (Howard Hinnant civil_from_days)
  function mday(z,   era, doe, yoe, doy, mp) {
    z += 719468
    era = int(z / 146097)
    doe = z - era * 146097
    yoe = int((doe - int(doe / 1460) + int(doe / 36524) - int(doe / 146096)) / 365)
    doy = doe - (365 * yoe + int(yoe / 4) - int(yoe / 100))
    mp = int((5 * doy + 2) / 153)
    return doy - int((153 * mp + 2) / 5) + 1
  }
  function runs(s, hour,   hod, day, dow, a, b) {
    hod = hour % 24
    day = int(hour / 24)
    dow = (day + 4) % 7
    if (s == "constant") return 1
    if (s ~ /^every:[0-9]+h\+[0-9]+$/) { split(substr(s, 7), a, "h\\+"); return hour % a[1] == a[2] + 0 }
    if (s ~ /^daily@/) return hod == substr(s, 7) + 0
    if (s ~ /^weekly@/) { split(substr(s, 8), b, "@"); return dow == b[1] + 0 && hod == b[2] + 0 }
    if (s == "monthly") return mday(day + 1) == 1 && hod == 23
    return 0
  }
  !/^#/ && NF >= 6 {
    labels = sprintf("{direction=\"out\",dst_ip=\"%s\",dst_port=\"%s\",instance=\"node-exporter:9100\",job=\"node\",src_host=\"%s\",src_ip=\"%s\",src_process=\"%s\"}", $4, $5, $1, $2, $3)
    for (h = start; h <= end; h++) if (runs($6, h)) print "depmap_connection_seen" labels " 1 " (h * 3600 + 1800)
  }
' /estate/flows.tsv >"$tmp/series"
{
  echo "# HELP depmap_connection_seen 1 while a TCP connection of this kind was seen."
  echo "# TYPE depmap_connection_seen gauge"
  cat "$tmp/series"
  echo "# EOF"
} >"$tmp/backfill.om"
echo "backfill: $(wc -l <"$tmp/series") samples from $(date -u -d "@$((start * 3600))" '+%F %H:00') to $(date -u -d "@$((end * 3600))" '+%F %H:00') UTC"
promtool tsdb create-blocks-from openmetrics --max-block-duration=24h "$tmp/backfill.om" "$OUT"
touch "$OUT/.depmap-backfilled"
rm -rf "$tmp"

#!/usr/bin/env bash
# One server of the fake estate. Reads dev/estate/flows.tsv and
#   - listens on every port other servers call on this IP (or on DEPMAP_EXTRA_IPS),
#   - keeps its "constant" connections open, reconnecting when they drop,
#   - runs its scheduled connections on an accelerated clock (DEPMAP_CLOCK_SPEED, default 1440: one real
#     second is 24 minutes, a day passes in a minute, a month in half an hour). The clock starts at
#     DEPMAP_CLOCK_START (epoch seconds; default 2026-11-30 22:00 UTC, so the monthly job fires within
#     seconds of starting the stack), and each job holds its connection DEPMAP_JOB_HOLD real seconds,
#   - runs collect/fallback/depmap-snapshot.sh every DEPMAP_SNAPSHOT_EVERY seconds (unless
#     DEPMAP_SNAPSHOT=0), writing /textfile/<host>.prom for node_exporter.
# Every client and listener is a copy of socat named after the process in flows.tsv, so `ss -p` shows
# that name, as it would on the real server.
set -u
FLOWS=/estate/flows.tsv
HOST="${DEPMAP_HOST:?}"
IP="${DEPMAP_IP:?}"
EXTRA=" ${DEPMAP_EXTRA_IPS:-} "
SPEED="${DEPMAP_CLOCK_SPEED:-1440}"
START="${DEPMAP_CLOCK_START:-1796076000}"
HOLD="${DEPMAP_JOB_HOLD:-90}"
SNAPSHOT="${DEPMAP_SNAPSHOT:-1}"
EVERY="${DEPMAP_SNAPSHOT_EVERY:-15}"
SOCAT="$(command -v socat)"
mkdir -p /opt/procs /run/jobs

log() { echo "$(date -u +%H:%M:%S) $HOST: $*"; }
as() { # copy socat under a process name, return its path
  local p="/opt/procs/$1"
  [[ -x "$p" ]] || cp "$SOCAT" "$p"
  echo "$p"
}

# Externals answer on their public address: add it to eth0. Callers route it via the external's
# estate address (DEPMAP_ROUTES="198.51.100.21=10.1.9.21 ..."), so traffic keeps its real source IP.
for a in ${DEPMAP_EXTRA_IPS:-}; do ip addr add "$a/32" dev eth0 && log "address $a"; done
for r in ${DEPMAP_ROUTES:-}; do ip route add "${r%%=*}/32" via "${r#*=}" && log "route ${r%%=*} via ${r#*=}"; done

listener_name() {
  case "$1" in
    1521) echo tnslsnr ;; 636) echo slapd ;; 2049) echo nfsd ;; 1414) echo mqbroker ;;
    25) echo master ;; 21) echo vsftpd ;; 8443 | 8080) echo java ;; 443) echo nginx ;; *) echo "listen$1" ;;
  esac
}

# Listeners.
for port in $(awk -F'\t' -v ip="$IP" -v extra="$EXTRA" \
  '!/^#/ && NF >= 6 && ($4 == ip || index(extra, " " $4 " ")) { print $5 }' "$FLOWS" | sort -un); do
  "$(as "$(listener_name "$port")")" -u "TCP-LISTEN:$port,fork,reuseaddr" OPEN:/dev/null &
  log "listening on $port"
done

# This server's flows: index process dst port schedule
mapfile -t MINE < <(awk -F'\t' -v h="$HOST" '!/^#/ && NF >= 6 && $1 == h { print NR "\t" $3 "\t" $4 "\t" $5 "\t" $6 }' "$FLOWS")

connect() { # process dst port seconds
  sleep "$4" | "$(as "$1")" -u STDIN "TCP:$2:$3,connect-timeout=3" 2>/dev/null
}

sleep 3 # let the other servers start listening
for f in "${MINE[@]}"; do
  IFS=$'\t' read -r _ proc dst port sched <<<"$f"
  if [[ "$sched" == constant ]]; then
    (while :; do connect "$proc" "$dst" "$port" 86400; sleep 2; done) &
    log "constant $proc -> $dst:$port"
  fi
done

runs() { # schedule fake-hour -> 0 when the flow runs in that hour (same rules as src/test-utils/estate.ts)
  local s="$1" hour="$2" hod dow tomorrow
  read -r hod dow <<<"$(date -u -d "@$((hour * 3600))" '+%H %w')"
  hod=$((10#$hod))
  case "$s" in
    every:*)
      local n="${s#every:}" o
      o="${n#*h+}"; n="${n%%h+*}"
      ((hour % n == o)) ;;
    daily@*) ((hod == 10#${s#daily@})) ;;
    weekly@*)
      local d="${s#weekly@}"
      ((dow == ${d%%@*} && hod == 10#${d#*@})) ;;
    monthly)
      tomorrow="$(date -u -d "@$((hour * 3600 + 86400))" +%d)"
      ((10#$tomorrow == 1 && hod == 23)) ;;
    *) return 1 ;;
  esac
}

real0="$(date +%s)"
last_hour=$((START / 3600))
next_snapshot=0
while :; do
  now="$(date +%s)"
  fake=$((START + (now - real0) * SPEED))
  while ((last_hour < fake / 3600)); do
    last_hour=$((last_hour + 1))
    for f in "${MINE[@]}"; do
      IFS=$'\t' read -r idx proc dst port sched <<<"$f"
      [[ "$sched" == constant ]] && continue
      runs "$sched" "$last_hour" || continue
      pidfile="/run/jobs/$idx"
      if [[ -f "$pidfile" ]] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then continue; fi
      connect "$proc" "$dst" "$port" "$HOLD" &
      echo $! >"$pidfile"
      log "fake $(date -u -d "@$((last_hour * 3600))" '+%Y-%m-%d %H:00') $sched: $proc -> $dst:$port"
    done
  done
  if [[ "$SNAPSHOT" == 1 ]] && ((now >= next_snapshot)); then
    DEPMAP_HOST="$HOST" DEPMAP_TEXTFILE="/textfile/$HOST.prom" DEPMAP_STATE="/var/lib/depmap/state" \
      bash /dev-depmap/depmap-snapshot.sh || log "snapshot failed"
    next_snapshot=$((now + EVERY))
  fi
  sleep 1
done

#!/usr/bin/env bash
# Installs OpenTelemetry eBPF Instrumentation (OBI) v1.0.0 as a systemd service that exports network
# flow metrics for the dependency map. Run as root on each Linux server you want on the map.
#
#   sudo ./install.sh            install or upgrade, then start
#   sudo ./install.sh --remove   stop and remove everything this script installed
#
# Requirements: Linux kernel 5.8 or newer with BTF (/sys/kernel/btf/vmlinux), x86_64 or arm64, root
# (or CAP_BPF, CAP_NET_ADMIN, CAP_PERFMON, CAP_SYS_RESOURCE). Servers that cannot run it use
# collect/fallback/ instead.
#
# The download is checked twice: against the release's SHA256SUMS and against the hashes pinned here.
set -euo pipefail

VERSION="v1.0.0"
declare -A PINNED=(
  [amd64]="962a7f05245ccfec0c1c54c4d3671fa22cd497d807e78fc23eddffbe5593a10f"
  [arm64]="1d1de239301bd257e93ca2c89e5876888d1327dfa181ea6f77bf429992f4bed0"
)
BASE="https://github.com/open-telemetry/opentelemetry-ebpf-instrumentation/releases/download/${VERSION}"
HERE="$(cd "$(dirname "$0")" && pwd)"

if [[ "${1:-}" == "--remove" ]]; then
  systemctl disable --now obi-depmap.service 2>/dev/null || true
  rm -f /etc/systemd/system/obi-depmap.service /usr/local/bin/obi
  rm -rf /etc/obi-depmap
  systemctl daemon-reload
  echo "OBI removed."
  exit 0
fi

[[ $EUID -eq 0 ]] || { echo "Run as root." >&2; exit 1; }
[[ -r /sys/kernel/btf/vmlinux ]] || { echo "No BTF (/sys/kernel/btf/vmlinux): use collect/fallback/ on this server." >&2; exit 1; }
read -r major minor _ < <(uname -r | tr '.-' '  ')
if (( major < 5 || (major == 5 && minor < 8) )); then
  echo "Kernel $(uname -r) is older than 5.8: use collect/fallback/ on this server." >&2
  exit 1
fi
case "$(uname -m)" in
  x86_64) ARCH=amd64 ;;
  aarch64 | arm64) ARCH=arm64 ;;
  *) echo "Unsupported architecture $(uname -m)." >&2; exit 1 ;;
esac

TARBALL="obi-${VERSION}-linux-${ARCH}.tar.gz"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -fsSL -o "$TMP/$TARBALL" "$BASE/$TARBALL"
curl -fsSL -o "$TMP/SHA256SUMS" "$BASE/SHA256SUMS"
(cd "$TMP" && grep " ${TARBALL}\$" SHA256SUMS | sha256sum -c -)
echo "${PINNED[$ARCH]}  $TMP/$TARBALL" | sha256sum -c -
tar -xzf "$TMP/$TARBALL" -C "$TMP" obi

install -m 0755 "$TMP/obi" /usr/local/bin/obi
install -d -m 0755 /etc/obi-depmap
install -m 0644 "$HERE/config.yaml" /etc/obi-depmap/config.yaml
install -m 0644 "$HERE/obi-depmap.service" /etc/systemd/system/obi-depmap.service
systemctl daemon-reload
systemctl enable --now obi-depmap.service
sleep 3
if curl -fsS http://127.0.0.1:9400/metrics >/dev/null; then
  echo "OBI ${VERSION} is running; metrics on :9400/metrics. Add this server to Prometheus."
else
  echo "OBI did not answer on :9400 yet. Check: journalctl -u obi-depmap -n 50" >&2
fi

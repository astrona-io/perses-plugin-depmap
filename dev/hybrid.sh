#!/usr/bin/env bash
# The hybrid example estate: the legacy servers of docker-compose.yaml plus a kind cluster whose nodes
# sit in the same old data centre, with OBI on every node.
#
#   dev/hybrid.sh up      start everything (idempotent)
#   dev/hybrid.sh down    delete the cluster, OBI and the compose stack with its volumes
#
# What runs where:
#   - compose (project perses-plugin-depmap): the servers with the fallback script, Prometheus, Perses.
#   - kind cluster perses-plugin-depmap (podman provider, or docker): namespace shop with orders and
#     pricing (kind/shop.yaml). Its nodes join the compose network olddc as 10.1.8.10-12, so pods reach
#     the Oracle VIP and the bank API leaving SNATed to their node, and billing (app03) calls the orders
#     NodePort on 10.1.8.12:30080.
#   - OBI on every node, network flows with Kubernetes metadata (kind/obi-config.yaml). On Linux with a
#     rootful runtime it is the DaemonSet of collect/kubernetes/obi. Under rootless podman (podman
#     machine on macOS) the DaemonSet cannot create its eBPF maps, so the same OBI image runs rootful in
#     the podman machine, in each node's network namespace: what a hostNetwork DaemonSet sees.
#   - 30 days of Kubernetes history (backfill-k8s.mjs): synthetic, with OBI's real label sets.
#
# Environment: COMPOSE (default "podman compose"), KIND_EXPERIMENTAL_PROVIDER (default podman),
# DEPMAP_KUBECONFIG (default dev/.kubeconfig; the script never touches your own kubeconfig),
# DEPMAP_OBI=daemonset|machine (default: machine when `podman machine` is running).
set -euo pipefail
cd "$(dirname "$0")"

NAME=perses-plugin-depmap
COMPOSE="${COMPOSE:-podman compose}"
export KIND_EXPERIMENTAL_PROVIDER="${KIND_EXPERIMENTAL_PROVIDER:-podman}"
KCFG="${DEPMAP_KUBECONFIG:-$PWD/.kubeconfig}"
RUNTIME="${KIND_EXPERIMENTAL_PROVIDER}"
NET="${NAME}_olddc"
OBI_IMAGE=docker.io/otel/ebpf-instrument:v1.0.0
PROM_IMAGE=docker.io/prom/prometheus:v3.5.0
VMDIR=/var/tmp/$NAME/obi
ROLES="control-plane worker worker2"

k() { kubectl --kubeconfig "$KCFG" "$@"; }
log() { echo "hybrid: $*"; }
ip_of() { case "$1" in control-plane) echo 10.1.8.10 ;; worker) echo 10.1.8.11 ;; worker2) echo 10.1.8.12 ;; esac; }
obi_mode() {
  if [[ -n "${DEPMAP_OBI:-}" ]]; then echo "$DEPMAP_OBI"; return; fi
  if [[ "$RUNTIME" == podman ]] && podman machine inspect --format '{{.State}}' 2>/dev/null | grep -qx running; then
    echo machine
  else
    echo daemonset
  fi
}
vm() { podman machine ssh "$@"; }

up() {
  log "compose up"
  # podman sometimes fails to start the last container ("internal libpod error"); a second up starts it.
  $COMPOSE up -d --build || $COMPOSE up -d

  if ! kind get clusters 2>/dev/null | grep -qx "$NAME"; then
    log "kind create cluster $NAME"
    kind create cluster --config kind/cluster.yaml --kubeconfig "$KCFG"
  fi
  kind export kubeconfig --name "$NAME" --kubeconfig "$KCFG" >/dev/null

  log "load the server image into the nodes"
  local tar
  tar="$(mktemp -d)/server.tar"
  "$RUNTIME" save -o "$tar" localhost/perses-plugin-depmap-server:dev
  kind load image-archive "$tar" --name "$NAME"
  rm -rf "$(dirname "$tar")"

  for r in $ROLES; do
    local n="$NAME-$r"
    if ! "$RUNTIME" inspect "$n" --format '{{json .NetworkSettings.Networks}}' | grep -q "\"$NET\""; then
      log "connect $n to olddc as $(ip_of "$r")"
      "$RUNTIME" network connect --ip "$(ip_of "$r")" "$NET" "$n"
    fi
    # The external endpoints answer on their public address via their estate address (as in compose).
    "$RUNTIME" exec "$n" ip route replace 198.51.100.43/32 via 10.1.9.43
    "$RUNTIME" exec "$n" ip route replace 198.51.100.21/32 via 10.1.9.21
  done

  log "workloads"
  k apply -f kind/shop.yaml
  k -n shop rollout status deploy/orders deploy/pricing --timeout=180s

  log "OBI ($(obi_mode))"
  # Namespace, ServiceAccount, RBAC and DaemonSet from collect/, with this estate's ranges.
  k apply -k ../collect/kubernetes/obi
  k -n depmap create configmap obi-depmap-dev --from-file=config.yaml=kind/obi-config.yaml \
    --dry-run=client -o yaml | k apply -f -
  k -n depmap set env daemonset/obi OTEL_EBPF_KUBE_CLUSTER_NAME=example-cluster >/dev/null
  k -n depmap patch daemonset obi --type=json -p \
    '[{"op":"replace","path":"/spec/template/spec/volumes/0/configMap/name","value":"obi-depmap-dev"}]' >/dev/null
  if [[ "$(obi_mode)" == machine ]]; then
    k -n depmap delete daemonset obi --ignore-not-found >/dev/null
    obi_in_machine
  else
    k -n depmap rollout status daemonset/obi --timeout=180s
  fi

  backfill_k8s
  log "ready: http://localhost:${PERSES_PORT:-18087}/projects/demo/dashboards/dependency-map"
}

# OBI rootful in the podman machine, one container per node, in that node's network namespace. It
# reads Kubernetes metadata with the obi ServiceAccount's token, through the API server's Service
# address (reachable from the node's namespace).
obi_in_machine() {
  vm "sudo mkdir -p $VMDIR/sa && sudo chmod 700 $VMDIR/sa"
  vm "sudo tee $VMDIR/config.yaml >/dev/null" <kind/obi-config.yaml
  k -n depmap create token obi --duration=48h | vm "sudo tee $VMDIR/sa/token >/dev/null"
  k config view --raw --minify -o jsonpath='{.clusters[0].cluster.certificate-authority-data}' |
    base64 -d | vm "sudo tee $VMDIR/sa/ca.crt >/dev/null"
  echo depmap | vm "sudo tee $VMDIR/sa/namespace >/dev/null"
  vm "sudo tee $VMDIR/sa/kubeconfig >/dev/null" <<'EOF'
apiVersion: v1
kind: Config
clusters:
  - name: kind
    cluster:
      server: https://10.96.0.1:443
      certificate-authority: /var/run/secrets/kubernetes.io/serviceaccount/ca.crt
users:
  - name: obi
    user:
      tokenFile: /var/run/secrets/kubernetes.io/serviceaccount/token
contexts:
  - name: obi
    context: { cluster: kind, user: obi }
current-context: obi
EOF
  for r in $ROLES; do
    local c="$NAME-obi-$r" pid
    vm "sudo podman rm -f $c >/dev/null 2>&1 || true"
    # The node container's PID as the machine's root sees it (rootless podman runs inside the machine).
    pid="$(vm "podman inspect --format '{{.State.Pid}}' $NAME-$r" | tr -d '\r')"
    vm "sudo podman run -d --name $c --hostname $NAME-$r --privileged --pid host \
      --network ns:/proc/$pid/ns/net \
      -v $VMDIR/config.yaml:/config/config.yaml:ro \
      -v $VMDIR/sa:/var/run/secrets/kubernetes.io/serviceaccount:ro \
      -e KUBECONFIG=/var/run/secrets/kubernetes.io/serviceaccount/kubeconfig \
      -e OTEL_EBPF_CONFIG_PATH=/config/config.yaml \
      -e OTEL_EBPF_KUBE_METADATA_ENABLE=true \
      -e OTEL_EBPF_KUBE_CLUSTER_NAME=example-cluster \
      $OBI_IMAGE" >/dev/null
    log "OBI on $NAME-$r"
  done
}

backfill_k8s() {
  local vol="${NAME}_prometheus"
  if "$RUNTIME" run --rm -v "$vol:/prometheus" --entrypoint /bin/sh "$PROM_IMAGE" \
    -c 'test -f /prometheus/.depmap-k8s-backfilled'; then
    log "Kubernetes history: already there"
    return
  fi
  k get pods,services,nodes -A -o json | node backfill-k8s.mjs 30 14 >.k8s-backfill.om
  "$RUNTIME" run --rm -v "$vol:/prometheus" -v "$PWD/.k8s-backfill.om:/k8s.om:ro,z" \
    --entrypoint /bin/sh "$PROM_IMAGE" -c \
    'promtool tsdb create-blocks-from openmetrics --max-block-duration=24h /k8s.om /prometheus && touch /prometheus/.depmap-k8s-backfilled'
  rm -f .k8s-backfill.om
  # No restart needed: Prometheus picks up new blocks in its data directory on its next reload of
  # the TSDB (within a minute or two).
  log "Kubernetes history written; Prometheus loads it within a couple of minutes"
}

down() {
  if [[ "$RUNTIME" == podman ]] && podman machine inspect >/dev/null 2>&1; then
    vm "sudo podman rm -f $NAME-obi-control-plane $NAME-obi-worker $NAME-obi-worker2 >/dev/null 2>&1; sudo rm -rf /var/tmp/$NAME" || true
  fi
  if kind get clusters 2>/dev/null | grep -qx "$NAME"; then
    kind delete cluster --name "$NAME" --kubeconfig "$KCFG"
  fi
  $COMPOSE down -v
  [[ "$KCFG" == "$PWD/.kubeconfig" ]] && rm -f "$KCFG"
  return 0
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  *) echo "usage: $0 up|down" >&2; exit 2 ;;
esac

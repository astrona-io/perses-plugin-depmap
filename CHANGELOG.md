# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.0] - 2026-11-13

### Added

- Hybrid estates: an optional `kubernetes` section in the mapping (clusters with node names and
  addresses, `egressIps`, `hideNamespaces`; workloads by namespace and workload name with `replicas`,
  `minUp`, `nodePorts`, `loadBalancerIp`), no pod addresses. Mappings from 0.1 stay valid.
- Identity resolution (`resolve.ts`): pod address to workload and namespace, Service ClusterIP to the
  workload behind it, node addresses, NodePort and LoadBalancer calls, pod-range gateways; unmapped
  workloads drawn under their own name.
- Stitching (`stitch.ts`): egress SNAT (node -> VM matched to pod -> VM on the same node, address,
  port and hour), ClusterIP DNAT folding, NodePort calls through a node; unexplained node traffic
  drawn as "via node X (NAT, pod unknown)".
- A Kubernetes lane per cluster between the waves and what stays; hop chains highlighted across the
  boundary.
- What if across the boundary: a node down takes its pods; workloads judged against desired
  replicas; callers pinned to one node's NodePort break with that node.
- Firewall rules at the cluster boundary: node or egress addresses as sources, NodePorts and
  LoadBalancer addresses as destinations.
- Edges list the named OBI ranges (`src_cidr` -> `dst_cidr`) they cross.
- Collection: OBI as a privileged container (`collect/container/compose.yaml`) and as a DaemonSet
  with RBAC (`collect/kubernetes/obi`, kustomize).
- `dev/hybrid.sh`: a kind cluster beside the legacy estate, with real OBI on its nodes and a
  VM -> NodePort -> pod -> VM chain.

### Changed

- Default edge query uses `max by` and the Kubernetes and CIDR labels; `sum by` double-counted flows
  seen by two OBIs.
- OBI configs set `network.guess_ports: ordinal`; without it OBI leaves `server_port` empty.

### Fixed

- Instance chips with the same host in two services crashed the chart; chip ids are now per service.
- Graph nodes are reachable from the keyboard.
- A pan that ended on a node no longer selects it.

## [0.1.0] - 2026-11-13

### Added

- `DependencyMapChart` panel: services from a mapping file in columns per migration wave, what
  stays and what is outside; edges discovered from network traffic, classified by how often they
  were seen over 30 days, with port, bytes per day and last seen.
- Hard-wired client detection: callers that only ever reach one member of an HA service.
- What-if mode: take instances down, evaluate single, active-passive, active-active (with load) and
  quorum services, propagate to callers with a reason on every node; presets; "Lose one server"
  ranking of every single point of failure.
- Needs mode: everything a service depends on, transitively.
- Firewall rules per wave and per instance, copyable; a live wave planner with "Copy updated mapping".
- Collection kit in `collect/`: OBI v1.0.0 config, systemd unit and install script with checksum
  check; snapshot scripts for Linux (`ss`) and Windows (`Get-NetTCPConnection`); mapping example
  and JSON Schema.
- A `dev/` stack: a fake legacy estate of twenty containers on an accelerated clock, 30 days of
  backfilled history, Prometheus and Perses with a ready dashboard.

[Unreleased]: https://github.com/astrona-io/perses-plugin-depmap/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/astrona-io/perses-plugin-depmap/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/astrona-io/perses-plugin-depmap/releases/tag/v0.1.0

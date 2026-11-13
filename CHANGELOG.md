# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/astrona-io/perses-plugin-depmap/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/astrona-io/perses-plugin-depmap/releases/tag/v0.1.0

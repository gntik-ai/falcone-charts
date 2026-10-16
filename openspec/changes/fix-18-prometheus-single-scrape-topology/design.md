# Design

## Deterministic mode selection

Read the existing automount flag with a safe false default. A true flag renders only
`falcone-pods`, preserving the namespaced pod role, annotation opt-in, path/port rewrites and
component/namespace/pod relabeling. No cluster lookup or additional permission is needed.

A false or missing flag renders `falcone-control-plane` and `falcone-control-plane-executor`
with `dns_sd_configs` of type A, never static Service targets. Each references a headless Service
in the release namespace. DNS returns individual ready pod IPs, preserving independent counters.
The metrics port follows the existing `prometheus.io/port` pod annotation (default 8080), so it
does not accidentally use a remapped ClusterIP Service port. Both jobs relabel component from
the same component identity used by the pod selectors. APISIX keeps its existing contract.

## Headless Services

Create Services only in token-less mode. Names use the component service-name helper plus a
distinct `-metrics` suffix; long names retain a hash of the helper result and component alias so truncation does not
collapse the two new Services. Select exactly the component name and release instance, matching
the workload selector. Expose one metrics port with `clusterIP: None`; no application or admin
ports are added. No new values key or RBAC change is required.

## Regression boundary and historical evidence

Tests render the public chart and parse both Kubernetes objects and the mounted `prometheus.yml`.
They assert one owning job per workload, per-pod discovery, stable labels, preserved relabeling,
namespace scope, metrics-only selectors, custom ports/names and all existing scrape limits.
The real historical Helm reuse-values contract checks the acquired DNS topology and limits.

Historical hash values remain unchanged. The existing scrape-limits normalizer first verifies
the exact new Services and DNS blocks, removes only those Services, restores the previous static
blocks and pod job, then subtracts the previously reviewed limits. Any unrelated drift remains
visible to the approved hashes.

## Release evidence and continuity

Prometheus must load the rendered configuration after its pod restarts. Operators verify
`sum by (component)(rate(falcone_http_requests_total[5m]))` for control-plane against that query
restricted to its single owning job: ratio approximately 1.0. They verify
`count by (job)(up{component="control-plane-executor"})` equals executor replicas and inspect
`resets(falcone_http_requests_total[1h])` for spurious resets. External dashboards/alerts using
`component=executor` or static job selectors require migration review. Rollback restores the
previous config and removes the added Services; it also restores the prior duplicate-scrape bug.

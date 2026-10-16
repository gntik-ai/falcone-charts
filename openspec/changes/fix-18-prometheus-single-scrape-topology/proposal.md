# Change: Scrape each Falcone workload once, per pod

## Why

The chart unconditionally configured both Service-DNS jobs and annotated-pod discovery for
control-plane and executor. Authenticated installs ingested each pod twice, inflating dashboard
rates. The Service jobs also load-balanced across independent replica counters. Token-less base
installs cannot authenticate pod discovery and must retain a working per-pod metrics path.

## What Changes

- Select exactly one topology using `observability.serviceAccount.automountToken`.
- With a token, retain namespace-scoped `falcone-pods` and its existing relabeling only.
- Without a token, use DNS A discovery on two chart-owned, metrics-only headless Services.
- Keep the component label equal to the pod's `app.kubernetes.io/name`: `control-plane` and
  `control-plane-executor` by default. Remove the legacy `executor` label.
- Retain configurable sample and label-length limits and historical reuse-values compatibility.
- Extend render contracts and subtract only this change from approved historical hash fixtures.

## Impact

Deployment templates, their tests and this OpenSpec package only. No image, RBAC, migration,
OpenBao, application metrics or Grafana expression changes. APISIX scraping remains a separate
issue. External queries using the old job topology or `component=executor` need review.

Operators must verify deployed rates and replica counts after promotion; this ChangeSet performs
no deployment, upgrade or rollback.

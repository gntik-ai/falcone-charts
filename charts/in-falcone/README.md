# in-falcone chart

Operational guidance for Temporal bootstrap lifecycle, readiness, fail-forward
recovery, and admin-tools image migration is in the [Temporal bootstrap
readiness runbook](docs/temporal-bootstrap-readiness.md).

Prometheus applies `observability.scrapeLimits.sampleLimit` (default 1,000,000
samples per target per scrape) and `observability.scrapeLimits.labelValueLengthLimit`
(default 512 bytes) to the `falcone-control-plane`, `falcone-control-plane-executor`
and `falcone-pods` jobs. Both values can be overridden in environment values.
Older releases upgraded with `--reuse-values` use the same defaults when keys are absent.

The sample default leaves headroom above approximately 191 route templates × 8
bounded methods × 10 common statuses × 15 HTTP metric samples (229,200), and above
the services' 16,384-key HTTP registry cap (245,760 samples), plus other metrics.
The length default accommodates static route templates and discovery labels.
Exceeding either limit fails the entire target scrape; monitor `up == 0` and size
environment overrides against observed legitimate counts before lowering limits.

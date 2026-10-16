# Deployment and operations delta

## MODIFIED Requirements

### Requirement: Each workload is scraped once, per pod

The chart SHALL render exactly one owning scrape job for control-plane and exactly one for
executor. Every target for these workloads SHALL resolve to an individual pod, using Kubernetes
pod discovery or DNS discovery on a chart-owned headless Service. It SHALL NOT target their
ClusterIP Service DNS names or render overlapping static and discovery jobs.

#### Scenario: Authenticated namespace-scoped discovery

- **WHEN** `observability.serviceAccount.automountToken=true`
- **THEN** `falcone-pods` covers both workloads through the existing namespace-scoped pod role
- **AND** the two dedicated workload jobs and headless metrics Services are absent
- **AND** existing annotation, path, port, component, namespace and pod relabeling is preserved

#### Scenario: Hardened token-less base installation

- **WHEN** the automount flag is false or absent from historical stored values
- **THEN** `falcone-pods` is absent
- **AND** both dedicated workload jobs use DNS A discovery against metrics-only headless Services
- **AND** each Service selects only its workload's pods in the release
- **AND** base installations retain `falcone_*` metrics without an API token

### Requirement: Stable labels and bounded ingestion

The component label SHALL match the pod's `app.kubernetes.io/name`, defaulting to `control-plane`
and `control-plane-executor` in both modes. Executor SHALL NOT emit `component=executor`.
Each active Falcone workload scrape job SHALL retain `sample_limit` and
`label_value_length_limit` from `observability.scrapeLimits`, defaulting to 1000000 and 512
even with historical reused values. APISIX remains outside this change.

#### Scenario: Single-job rates and replica evidence

- **WHEN** operators verify the deployed scrape configuration
- **THEN** the control-plane request-rate sum equals the sum restricted to its owning job
  (ratio approximately 1.0 rather than 2.0)
- **AND** executor up-series count equals executor replicas under `component=control-plane-executor`
- **AND** changing scrape targets between replicas does not produce spurious counter resets

### Requirement: Preserve deployment safety boundaries

Mode selection SHALL depend only on values, without lookup or cluster access. The change SHALL
preserve namespaced RBAC, image versions, migration gates and External Secrets/OpenBao wiring.
Historical approved render hashes SHALL remain unchanged; fixture normalization SHALL subtract
only the independently verified scrape-topology additions.

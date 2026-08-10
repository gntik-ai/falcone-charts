# Deployment and operations delta

## MODIFIED Requirements

### Requirement: A failed upgrade SHALL NOT leave the control plane scaled down

The webhook key maintenance window SHALL be ordered so that no `pre-upgrade` hook can
fail while the control plane is quiesced. The `webhook-key-lifecycle` Job SHALL carry a
`helm.sh/hook-weight` strictly greater than that of every other `pre-upgrade` hook
rendered by the chart and its sub-charts, and its ServiceAccount, Role and RoleBinding
SHALL sort before it. The Secret-producing `webhook-key-credential` and
`webhook-db-credential` Jobs SHALL continue to precede it.

#### Scenario: Hook failure restores availability

- **WHEN** the control plane has been scaled down for a maintenance window and a later
  hook fails
- **THEN** the replica count is restored before the release reports failure
- **AND** no `pre-upgrade` hook is rendered at or after the quiesce, so no such hook
  exists to fail inside the window

#### Scenario: Successful upgrade is unchanged

- **WHEN** the upgrade completes
- **THEN** the control plane is running at its configured replica count, as today
- **AND** the lifecycle Job retains `deployments/scale` patch authority on the control
  plane only, and gains no other Deployment write verb

#### Scenario: A later hook cannot silently re-open the window

- **WHEN** a chart or sub-chart adds a `pre-upgrade` hook at a weight at or above the
  quiesce
- **THEN** the rendered-manifest suite fails and names the offending hooks and weights

#### Scenario: An upgrade without key lifecycle work does not quiesce

- **WHEN** a release requests neither legacy adoption nor a rotation action
- **THEN** no quiesce Job, ServiceAccount, Role or RoleBinding is rendered
- **AND** the remaining `pre-upgrade` Jobs run with the control plane serving

#### Scenario: The outage is detectable

- **WHEN** the control plane is scaled to zero
- **THEN** the platform health surface reflects it, rather than `/healthz` continuing to
  answer 200 from the gateway
- **NOT SATISFIED BY THIS CHANGE** — the chart ships zero Prometheus rule groups, so an
  alert added here would be evaluated by nothing. Tracked on `charts#19`.

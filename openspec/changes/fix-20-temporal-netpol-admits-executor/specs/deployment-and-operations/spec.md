# Deployment and operations delta

## ADDED Requirements

### Requirement: Every NetworkPolicy selector SHALL name pods the chart renders

No NetworkPolicy this chart ships SHALL declare a `podSelector` — as its own target, or as an
ingress or egress peer without a `namespaceSelector` — whose `matchLabels` are carried by no pod
template rendered in that same values profile. Pod labels SHALL be read from the pod template,
including `spec.template` of Knative Services, and never from the parent object.

An exemption SHALL be admissible only for pods created at runtime, and only when it names both the
code that pins the label on the pod template and the test asserting it. An exemption that no longer
matches an unresolved selector SHALL fail.

#### Scenario: An allow-list entry admits nothing

- **WHEN** a NetworkPolicy admits a component label no rendered pod carries
- **THEN** the rendered-manifest suite fails, naming the policy, the profile and the selector
- **AND** the message states that the entry silently denies the component it was meant to admit

#### Scenario: A policy target protects nothing

- **WHEN** a NetworkPolicy's own `podSelector` matches no rendered pod
- **THEN** the suite fails, rather than the policy existing while enforcing nothing

#### Scenario: The label is on the Knative Service instead of its pod template

- **WHEN** a selector names a label present only on a Knative Service object
- **THEN** the suite fails, because pod labels are read from `spec.template` only

#### Scenario: Each values profile is judged on its own render

- **WHEN** a selector resolves under one values profile and not another
- **THEN** the profile where it resolves to nothing fails
- **AND** resolving elsewhere in the repository does not excuse it

## MODIFIED Requirements

### Requirement: The component that starts workflows can reach the Temporal frontend

The chart SHALL admit `control-plane-executor` — the only component that constructs a Temporal
client — into the Temporal frontend ingress policy, alongside `flows-worker` and Temporal's own
pods. The allow-list SHALL NOT retain `flows-api`, which names a component no chart artifact
renders.

#### Scenario: Flow execution

- **WHEN** a tenant starts a flow
- **THEN** the executor reaches `falcone-temporal-frontend:7233` and a workflow execution is created

#### Scenario: The executor is admitted in every topology that renders it

- **WHEN** a values profile renders a `control-plane-executor` Deployment
- **THEN** its pod labels satisfy at least one ingress peer of the Temporal frontend policy
- **AND** this holds for the flows e2e profile, which previously worked around the policy by
  labelling the control plane `flows-api`

#### Scenario: The workaround is gone

- **WHEN** the flows e2e values are rendered
- **THEN** no pod is stamped `app.kubernetes.io/component: flows-api`
- **AND** the suite exercises the chart's default allow-list rather than a patched one

# Design

## Which component actually needs the frontend

`apps/control-plane-executor` is the only place a Temporal client is constructed —
`runtime/flow-executor.mjs`, `runtime/flow-trigger-registry.mjs`, `runtime/flow-monitoring-executor.mjs`,
`runtime/main.mjs`, `runtime/server.mjs`. `apps/control-plane` has none; it reaches flows over HTTP.

Rendered pod-template `app.kubernetes.io/component` labels:

| Deployment | component |
|---|---|
| `falcone-control-plane` | *(none)* |
| `falcone-control-plane-executor` | `control-plane-executor` |
| `falcone-workflow-worker` | `flows-worker` |

So `flows-worker` was already admitted and worked; `control-plane-executor` was the whole gap, and
`flows-api` named a component that does not exist in any render. Hence
`[control-plane-executor, flows-worker]` — no additive `flows-api` kept "just in case", because an
entry that matches nothing is precisely what this change makes impossible.

## Aligning labels to the policy was the wrong direction

The alternative was to stamp `app.kubernetes.io/component: flows-api` on the executor by default,
matching the policy to the existing label. Rejected:

- `app.kubernetes.io/component` describes what a pod **is**, not what it is allowed to reach. The
  executor's component genuinely is `control-plane-executor`, and it is already selected by that
  value in the FerretDB and SeaweedFS policies.
- The key can hold one value, so adopting `flows-api` would have to displace the real component
  label and break those other selectors.
- It preserves the fiction that a `flows-api` component exists.

## Scope of the guard

For every NetworkPolicy in a render:

- **target** — `spec.podSelector.matchLabels`, when non-empty. An empty selector matches every pod
  in the namespace and always resolves.
- **peers** — `ingress[].from[]` and `egress[].to[]` entries carrying `podSelector.matchLabels`.

A peer that also carries a `namespaceSelector` names pods in another namespace, which the render
cannot see, so it is skipped rather than guessed at.

Pod labels are collected from `spec.template.metadata.labels` of Deployment, StatefulSet, DaemonSet,
ReplicaSet and Job, from `spec.jobTemplate.spec.template` of CronJob, and from `spec.template` of
Knative `serving.knative.dev/*` Services. That last one is deliberate: the `#972` trap is a label
present on the Knative Service object but absent from its pod template. Job pods additionally get
`job-name` and `batch.kubernetes.io/job-name`, which the Job controller injects and which the
SeaweedFS policy legitimately selects.

## Per-profile, not per-repo

The suite checks each values profile independently — defaults, `staging`, `prod`, `kind`, and the
flows e2e file (rendered with `--skip-schema-validation`, matching how `tests/e2e/stack.sh` in the
falcone repo actually renders it).

"It resolves in *some* profile" would be the wrong rule, and is exactly how this defect survived:
the e2e values stamped `flows-api`, so a repo-wide check would have found the label somewhere and
passed while every real deployment was broken.

## The exemption list is the load-bearing part

Some selectors legitimately name pods no chart artifact renders. Hosted MCP servers are Knative
Services the control plane creates per tenant at runtime, so
`falcone-mcp-server-internal-only` selects `in-falcone.io/component: mcp-server` and resolves to
nothing in any render.

`RUNTIME_CREATED` carries that one entry, and an entry is only admissible if it names the code that
pins the label **on the pod template** plus the test asserting it — here
`apps/control-plane-executor/src/mcp-custom-hosting.mjs` writing into `spec.template.metadata.labels`,
asserted by `mcp-custom-hosting.test.mjs` ("pod label for NetworkPolicy"). An exemption justified by
a label on the parent object is the `#972` bug, so the suite requires the justification to say
"pod template".

A final check fails if any exemption stops being matched, so a stale entry cannot sit there
absorbing a future real defect.

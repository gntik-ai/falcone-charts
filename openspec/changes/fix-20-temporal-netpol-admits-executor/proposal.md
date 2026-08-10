# Change: Admit the component that starts workflows into the Temporal frontend

## Why

`temporal.networkPolicy.allowedComponents` was `[flows-api, flows-worker]`. `flows-api` was
reserved for `add-flows-control-plane-api` (#365), and **no pod any chart artifact produces has
ever carried it**. Flow execution lives in `control-plane-executor`, whose pod template is
labelled `app.kubernetes.io/component: control-plane-executor`, so it was denied.

Every flow execution on every tenant failed closed with `503 TEMPORAL_UNAVAILABLE`. **Zero
workflows have ever run since deployment**, and cron and webhook trigger registration are broken
with it. `gntik-ai/falcone-charts#20` carries the live probe: executor pods `ECONNREFUSED` to
`falcone-temporal-frontend:7233`, worker pods `CONNECT OK`.

The template predicted its own failure in a comment — *"If those changes ship different labels,
flows traffic to Temporal will be silently blocked"* — and nothing enforced it.

### Why it shipped, and kept shipping

`tests/e2e/values-flows-e2e.yaml` stamped `app.kubernetes.io/component: flows-api` onto the
**control plane**, with a comment explaining that the policy required it. The only suite that
exercised this path patched the label instead of catching the defect.

That stamp was doubly wrong: `apps/control-plane` builds **no Temporal client at all** — every one
lives in `apps/control-plane-executor` (`flow-executor`, `flow-trigger-registry`,
`flow-monitoring-executor`, `runtime/main`, `runtime/server`). Admitting the control plane never
made a flow execution work. And the e2e topology does render a real `control-plane-executor`, which
was denied there too, so the workaround did not even fix e2e's own execution path.

## What Changes

- `allowedComponents` → `[control-plane-executor, flows-worker]`: the components this chart
  actually renders, and the only ones that hold a Temporal client.
- Remove the `flows-api` pod-label workaround from `tests/e2e/values-flows-e2e.yaml`, so that
  suite exercises the default policy rather than a patched one.
- Rewrite the label-contract comments in `values.yaml` and `templates/temporal/networkpolicy.yaml`,
  which documented the contract that broke.
- Add `tests/networkpolicy-selector-reality.test.mjs`: across **all five** values profiles this
  repo ships, no NetworkPolicy selector may match zero rendered pods — checked for allow-list
  peers *and* for policy targets.
- Deliberately **no chart version bump** — `0.4.11` is the pinned staging-recovery target.

## Impact

Affected source is `charts/in-falcone/values.yaml`,
`charts/in-falcone/templates/temporal/networkpolicy.yaml`, `tests/e2e/values-flows-e2e.yaml`, one
new test, the CI test script and this OpenSpec package. No Falcone product API or source change.

Unblocks `gntik-ai/falcone#997` (flow execution plane returns `TEMPORAL_UNAVAILABLE`) and the S6 /
S7 / S9 / S10 / S12 slices that depend on a workflow ever running.

## Why the guard is the larger half

A selector that matches nothing fails silently in **both** directions, and neither shows up in any
status:

- an **allow-list** entry that matches nothing quietly denies a component that needs access — this
  defect;
- a **policy target** that matches nothing quietly protects nothing, while still satisfying an
  audit that greps for the existence of a policy.

`gntik-ai/falcone#972` is the second kind waiting to happen: the obvious fix — a `podSelector` on
`in-falcone.function=true` — selects zero pods, because that label sits on the Knative Service
rather than on its pod template. It would be applied, report success, leave the hole open, and pass
review. The new suite reads Knative `spec.template` labels specifically so that fix cannot land
looking correct.

## Exclusions and gates

No cluster was contacted for this change; the evidence is the rendered manifest plus the live probe
already recorded on `charts#20`. **Live re-verification is not possible yet**: `in-falcone-staging`
is at revision 23 `failed`, so no chart fix is adopted until the forward recovery runs. The first
honest live proof of this fix — a flow execution returning something other than 503 — comes after
that recovery.

`charts#16` remains open and is the other half of Kafka/NetworkPolicy tenant isolation; this change
does not touch it. Rule 7 applies: NetworkPolicy is tenant-isolation surface, so human review is
required before merge.

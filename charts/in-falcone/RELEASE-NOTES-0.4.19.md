# in-falcone 0.4.19

Chart 0.4.19 is the immutable correction for the revision-24 packaged
auth-reconcile guard. It is for P18 release engineers, P3 operators, P4
auditors, P7 workspace capability owners, P12 service workloads, P13 isolation
reviewers, and P17 documentation-only responders. It changes no application
image, values/schema, ServiceAccount/RBAC, probe, network, storage/PVC, public
API, credential scope, or tenant/workspace boundary relative to 0.4.18.

## Why a new package is required

The exact real 0.4.18 package rendered a valid forced-recovery Job, but its
distributed CLI guard located the generic text
`bao write -format=json auth/kubernetes/login` with `script.index`. That selected
the lexically earlier dedicated `login_json` branch instead of the later
semantic canary and failed `REVISION24_AUTH_RECONCILE_RENDER_DRIFT` before
`kubectl create`.

The 0.4.18 JIT authorization was consumed. No 0.4.18 Job, ClusterSecretStore
patch, ExternalSecret owner patch, Helm operation, new release revision, Secret
read, or PVC operation occurred. OCI packages remain immutable: do not overwrite
0.4.18 or reuse its digest, evidence, or one-use JIT. A published 0.4.19 digest,
fresh package-bound backup/parity evidence, and a new exact r24-to-0.4.19
confirmation are mandatory.

## Semantic canary and complete structural guard

The embedded Python guard now accepts exactly one command substitution that:

- assigns to `canary_json`;
- runs `bao write -format=json auth/kubernetes/login`;
- passes exact `role="$role"`; and
- reads the JWT from `/canary/token`.

The match object's captured `start()` position is the canary position. The
guard does not use `str.index`, `str.rindex`, or a bare login substring to select
it. The dedicated `login_json` branch remains lexically earlier and remains the
unchanged routine authentication path. Missing, duplicate, renamed, differently
roled, differently sourced, or partial canaries fail closed before create.

The guard also requires strict order:

```text
platform snapshot
-> auth-reconcile snapshot
-> platform hash verification
-> auth-reconcile hash verification
-> auth_source=recovery_root result=accepted
-> platform policy write
-> auth-reconcile policy write
-> openbao-init role
-> openbao-auth-reconcile role
-> ESO role
-> semantic canary
-> auth/token/lookup-self
-> auth/token/revoke-self
-> terminal changed/unchanged result block
```

All 0.4.18 guardrails remain: one Job and reconciler container, byte- and
SHA-bound HCL, private `emptyDir` policy volumes, no canonical policy ConfigMap
mount, exact recovery Secret mount, least-privilege platform/auth policy content,
`restartPolicy: Never`, `backoffLimit: 0`, 300-second active deadline, and
credential-silent markers. The generated attempt records quoted attested chart
version `0.4.19`, the full package digest, target
`in-falcone-0.4.19`, and source revision `24`.

## Authorization and mutation boundary

Acceptance of the exact one-use target confirmation records and prints:

```text
authorization_consumed=true
```

Package pull, Helm render and the structural guard remain read-only. A render or
guard rejection before create reports:

```text
REVISION24_AUTH_RECONCILE_RENDER_DRIFT
mutation_started=false
```

It does not print `FORWARD_RECOVERY_REQUIRED`, because no cluster mutation was
attempted. The consumed authorization still cannot be reused. Immediately before
the CLI invokes `kubectl create`, it records `mutation_started=true`. A create
error or response-loss ambiguity therefore reports:

```text
REVISION24_AUTH_RECONCILE_CREATE_FAILED
mutation_started=true
FORWARD_RECOVERY_REQUIRED
```

Every later failure remains fail-forward. The Job is retained; retry reruns all
package/live/history gates and creates a new digest-derived identity.

## Exact r24 history fence

The only immutable Job anchors are:

- 0.4.14 `openbao-auth-reconcile-r24-859e037a14be-7v86n`, UID
  `352c1698-ac65-4af2-a25a-00bd183e9a11`, digest
  `sha256:859e037a14be87dce1419737b2bda09e9a66125cd0384f51b842e5f65eafbe70`;
- 0.4.16 `openbao-auth-reconcile-r24-10828ffdf9f1-f65tk`, UID
  `979dac0c-507c-4b19-9f07-2c5e98a66acc`, digest
  `sha256:10828ffdf9f134501f32af35d96e61c3db33f6071bb0bc015fc2ceac0c3b025e`;
- 0.4.17 `openbao-auth-reconcile-r24-4cd761dd8b0a-qjnfw`, UID
  `c8fd1c27-f68b-4d33-b10f-3b832c741cd3`, digest
  `sha256:4cd761dd8b0a855cdae29a8f808382333918beb9ab7d0b485dffaaf81a677328`.

Each anchor must retain exactly six annotations: its exact package digest,
target chart and source revision plus the three exact Helm hook annotations. It
has `failed=1`, `succeeded` absent or zero, and exactly the uniquely typed
`FailureTarget` and `Failed` conditions, both
`True/BackoffLimitExceeded`. Condition order, messages, timestamps and
resourceVersion remain dynamic.

Zero or more extra Jobs are admitted only as unique, fully attested attempts for
the current 0.4.19 digest/target and its digest-derived generated prefix. Each
has exactly seven annotations: the same six provenance/hook annotations plus
`falcone.gntik.ai/attested-chart-version=0.4.19`. Its sole allowed terminal is
either Failed (`failed=1`, `succeeded` absent or zero, and exactly
`Failed`+`FailureTarget`, both `True/BackoffLimitExceeded`) or Kubernetes v1.36
Successful (`succeeded=1`, `failed` absent or zero, and exactly
`Complete`+`SuccessCriteriaMet`, both `True/CompletionsReached`). Names and UUID
UIDs are unique across anchors and attempts; any annotation, identity,
provenance or terminal drift fails closed.

This fence runs after the exact Store and fourteen-ExternalSecret precursor is
validated on every admitted r24/0.4.19 retry. It is unconditional across Store
states, including Store `Ready`/`complete` after a Successful auth Job followed
by a downstream failure; no admitted Store state can bypass the history read or
permit create before it.

Chart 0.4.15 remains published but unapplied. Chart 0.4.18 is published and
pre-create-failed, not a Job or rollback anchor. Any Job name, generated prefix,
target annotation, or alleged anchor for 0.4.18 fails
`REVISION24_AUTH_RECONCILE_HISTORY_DRIFT` before mutation.

## Operator procedure and expected evidence

Do not target shared staging before independent review and disposable
install/upgrade/failure/forward-recovery proof. The CLI defaults to metadata-only
preflight. A real r24 apply must use the package digest reported by the immutable
OCI artifact in both evidence documents and in this fresh confirmation:

```text
default/in-falcone-staging/falcone@24/in-falcone-0.4.11->in-falcone-0.4.19/sha256:PUBLISHED_PACKAGE_DIGEST
```

```bash
charts/in-falcone/migrations/revision-20-repair.sh \
  --phase-a --apply \
  --backup-attestation /secure/path/revision20-backup.json \
  --parity-attestation /secure/path/revision20-parity.json \
  --confirm-target 'default/in-falcone-staging/falcone@24/in-falcone-0.4.11->in-falcone-0.4.19/sha256:PUBLISHED_PACKAGE_DIGEST'
```

The auth Job completes within five minutes, after which the CLI accepts exactly
one `auth_source=recovery_root result=accepted` line from that freshly created
Job and exactly one paired terminal result: `changed/AUTH_METADATA_CONVERGED` or
`unchanged/AUTH_METADATA_MATCHED`, both with `canary=passed`. Only then may the
store CAS handoff/readiness, fourteen separate ten-minute ExternalSecret waits,
and two non-global-wait Phase-A passes proceed. The second pass remains
recovery-root-disabled. External ESO-to-OpenBao reachability remains an operator
prerequisite; Falcone neither owns nor changes that controller or its network.
No retained Successful Job relaxes or substitutes this fresh marker requirement.

## Fresh install, routine upgrade, security, and rollback

Fresh installation keeps full OpenBao bootstrap before auth reconciliation.
Routine upgrade keeps both recovery flags false, uses only the dedicated
Kubernetes login, and renders no recovery Secret mount, policy snapshot volume,
embedded HCL, or policy write. Secret payloads and credentials are never read or
logged. ESO and workload identities remain exact-scope, and P13 cross-tenant or
adjacent-workload access must continue to fail closed.

A pre-create failure needs no cluster restoration. At or after the create
attempt, recovery may only forward-apply the exact 0.4.19 package. Helm rollback
to 0.4.11 through 0.4.18 is forbidden. Phase-B PVC deletion remains a separate
JIT-gated irreversible boundary; data-bearing storage needs a separately
approved backup/restore and P13 isolation-parity design.

## Provenance and release verification

Implementation baseline is `origin/main`
`c7cd7bbde9b41f0c218f77c4c43c6923c9272739`; maker verification date is
2026-08-13. Before publication, record the reviewed source commit, generated
archive SHA-256 and registry-reported OCI digest. Required release evidence is
strict Helm lint/schema, fresh/routine/forced real renders, package version and
digest checks, shell syntax, exact real-package public CLI bbx091-bbx098,
historical black-box compatibility, OpenSpec strict validation, secret-silence
checks, and diff hygiene. Live install, upgrade, isolation and cleanup evidence
is separately gated and is not claimed by this source-only implementation.

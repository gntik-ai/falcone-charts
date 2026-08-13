# Deployment and operations delta

## ADDED Requirements

### Requirement: Falcone SHALL preserve externally managed ESO ownership

Falcone SHALL render no namespaced object in the external controller namespace,
SHALL NOT adopt or mutate its owner, and SHALL grant only exact TokenRequest and
TokenReview authority needed for OpenBao Kubernetes authentication. Repair
preflight SHALL compare a secret-suppressed semantic diff against the sanitized
metadata-only 21-resource owner inventory, including cluster-scoped objects,
and SHALL compare exact owner metadata before and after every apply pass. It
SHALL NOT read a Helm release manifest or Secret payload.

#### Scenario: External controller is reused

- **WHEN** staging selects externally managed ESO with exact namespace and ServiceAccount
- **THEN** Falcone renders its store, fourteen declarations and auth identity
- **AND** it renders no object into `external-secrets` and no adoption path for
  any administrator-owned ESO object
- **AND** create, update, removal, or owner-metadata drift of any protected ESO
  resource fails before the next mutation

#### Scenario: Existing Falcone declarations lack Helm ownership

- **WHEN** the exact fourteen Falcone-owned `ExternalSecret` declarations match
  the target render but all three Helm owner markers are absent
- **THEN** dry-run reports the exact adoptable set without mutation
- **AND** apply validates all fourteen before atomically patching only their
  owner metadata with UID and resourceVersion tests
- **AND** exact already-owned retries are idempotent
- **AND** partial or foreign ownership, identity/spec drift, or concurrency drift
  fails before Helm upgrade
- **AND** no generated Secret or administrator-owned ESO object is read or
  adopted and broad `--take-ownership` is forbidden

### Requirement: OpenBao upgrades SHALL reconcile auth metadata only

OpenBao SHALL use its rotating pod-local Kubernetes reviewer credential. Full
KV/policy bootstrap SHALL be fresh-install-only. Routine reconciliation SHALL be
idempotent and SHALL NOT read/mutate KV payloads or policy documents. The server,
bootstrap and routine reconciler SHALL use distinct Kubernetes ServiceAccounts.
The server identity SHALL have only TokenReview authority; bootstrap Secret
authority SHALL be assigned only to the bootstrap identity; and routine metadata
authority SHALL be assigned only to the reconciler identity. The ESO login role
SHALL set `token_no_default_policy=true`; every token it issues to ESO or the
canary SHALL contain exactly `functions,gateway,iam,platform` and SHALL NOT
contain `default` or any additional policy.

#### Scenario: Kubernetes identities are least-privilege and separate

- **WHEN** a fresh install and a routine upgrade are rendered
- **THEN** the StatefulSet, bootstrap Job and reconciler Job use three distinct
  ServiceAccounts
- **AND** the server cannot read or write platform/recovery Secrets
- **AND** the bootstrap identity is not granted TokenRequest or TokenReview
- **AND** the reconciler cannot access KV, mounts, audit configuration or policy
  documents

#### Scenario: Static reviewer credential is present

- **WHEN** auth metadata reports a persisted reviewer JWT
- **THEN** reconciliation clears static reviewer JWT/CA mode, normalizes the exact role,
  verifies metadata and runs a no-KV login/lookup/revoke canary

#### Scenario: Metadata already matches

- **WHEN** config and role metadata match
- **THEN** it performs no metadata write and reports `result=unchanged`

#### Scenario: Matching role remains denied

- **WHEN** the exact role matches but canary login returns denied
- **THEN** it fails with `ROLE_MATCHES_AUTH_STILL_DENIED` without touching KV/policies

#### Scenario: Auth reconcile excludes the default policy from ESO tokens

- **WHEN** auth reconciliation normalizes `eso-role` and either the canary or
  `eso-system/eso-openbao-auth` authenticates through that role
- **THEN** the role SHALL have `token_no_default_policy=true`
- **AND** token lookup SHALL expose exactly the normalized policy set
  `functions,gateway,iam,platform`, with neither `default` nor any other policy
- **AND** the canary SHALL report `canary=passed` only after that exact metadata
  check succeeds

#### Scenario: Platform policy grants only OpenBao token self-service capabilities

- **WHEN** the `platform` OpenBao policy is rendered for fresh install or
  revision-24 recovery
- **THEN** its `auth/token/` paths SHALL be exactly
  `auth/token/lookup-self` with `read` and `auth/token/revoke-self` with `update`
- **AND** it SHALL NOT grant `default`, wildcards, token creation, renewal, role
  access, or any additional capability

#### Scenario: Auth reconciliation installs the platform policy before no-default canary validation

- **WHEN** the explicitly authorized recovery-root auth Job repairs revision 24
- **THEN** it SHALL materialize the byte-equal package platform-policy snapshot
  in private `emptyDir`, verify its package-rendered SHA-256, and write that exact
  policy before changing or validating `eso-role` and before canary login
- **AND** it SHALL NOT mount the live canonical platform-policy ConfigMap
- **AND** policy write failure SHALL emit `PLATFORM_POLICY_BOOTSTRAP_FAILED`,
  disclose no credential, and stop before store, ExternalSecret-owner, or Helm
  mutation
- **AND** fresh init SHALL continue to write the projected platform policy before
  creating `eso-role`, while the dedicated routine reconciler SHALL gain no
  policy-write, mount, Secret, or KV authority

### Requirement: FerretDB SHALL retain availability during the UID repair

The engine gate SHALL run as UID 999 with non-root hardening. The Deployment SHALL
use maxUnavailable 0, maxSurge 1 and retain the old Ready ReplicaSet until a
replacement passes readiness.

#### Scenario: Replacement never becomes Ready

- **WHEN** init/readiness fails
- **THEN** the old Ready endpoint count remains and rollout reaches its deadline

### Requirement: Storage and image repair SHALL be staging-only and immutable

Staging SHALL select local-path plus fsn1 and the six immutable digests built by
the successful image release for Falcone main
`d9cd0f6b56a4f8241e39d5336f3a7505afcdb9cc`. Base,
production, HA and OpenShift SHALL NOT inherit this storage choice. Vanilla
Kubernetes SHALL run APISIX as numeric UID/GID 636 and Prometheus as numeric
UID/GID 65534 while retaining `runAsNonRoot`. The OpenShift restricted profile
SHALL omit both fixed identities so its SCC can assign an allowed UID and GID.

#### Scenario: Staging render

- **WHEN** `values/staging.yaml` is rendered
- **THEN** pgvector selects local-path/fsn1 and all six images are digest-pinned
  to tag `0.6.6-main-d9cd0f6b` provenance

#### Scenario: Vanilla Kubernetes starts images that declare named users

- **WHEN** the base chart renders the APISIX named-user image and the existing
  Prometheus v3.2.1 digest
- **THEN** their container security contexts contain `runAsNonRoot: true` and
  numeric UID/GID 636 and 65534 respectively
- **AND** no image tag, digest, public API or staging storage contract changes

#### Scenario: OpenShift retains arbitrary UID assignment

- **WHEN** the OpenShift restricted overlay renders those same containers
- **THEN** their pod and container security contexts omit fixed `runAsUser` and
  `runAsGroup` values
- **AND** the non-root contract remains compatible with SCC-assigned identities

### Requirement: The revision-20 empty PVC transition SHALL be JIT-gated

The procedure SHALL default to dry-run. Apply SHALL require separate fresh
backup/parity attestations bound to exact source target, repair chart, and
package digest. Phase B SHALL additionally require a fresh Phase-A attestation
whose result matches the live revision/chart/package and proves recovery-root
disabled plus final health. Target confirmation SHALL contain current revision,
chart, and package digest. PVC confirmation SHALL remain a separate exact
name/UID confirmation.

The procedure SHALL delete no PVC until exact target, name, immutable UID,
Pending/no-volume/no-PV state are rechecked. It MAY admit the exact initial
Pending vector StatefulSet Pod reference, but SHALL scale only that StatefulSet
to zero, wait boundedly for termination, and then reread PVC, PV, Pod, and data
evidence after the confirmation boundary. State change SHALL invalidate
confirmation.

#### Scenario: PVC state changes

- **WHEN** the UID, phase, volumeName, PV claimRef or Pod evidence changes
- **THEN** deletion is forbidden and a data migration plan is required

#### Scenario: Evidence is opaque, stale, or targets another package

- **WHEN** backup, parity, or Phase-A evidence is missing, expired, malformed,
  reused, differently targeted, or does not match the live revision/chart/package
- **THEN** the tool emits a stable evidence error and performs no mutation

#### Scenario: Initial Pending vector Pod exists

- **WHEN** the exact vector StatefulSet controls its expected ordinal-zero Pod,
  the Pod is Pending, and the unbound claim has no PV or data evidence
- **THEN** the tool scales that exact StatefulSet to zero, waits boundedly, and
  performs the final evidence reread before the exact claim deletion

#### Scenario: Apply fails after deletion

- **WHEN** canonical local-path apply fails after the empty claim is deleted
- **THEN** the tool reports `FORWARD_RECOVERY_REQUIRED`, recovery reapplies 0.4.19,
  and neither path uses atomic upgrade or rollback to revision 20

#### Scenario: Packaged forward recovery invokes its repair delegate without executable mode

- **WHEN** the public Helm archive extracts `revision-20-repair.sh` without an
  executable bit and an admitted r22, r23, or r24 recovery delegates from
  `revision-20-forward-recovery.sh`
- **THEN** the forward-recovery CLI SHALL invoke the package-local repair script
  through Bash, preserve every validated argument, and SHALL NOT depend on the
  delegate executable mode

#### Scenario: Phase A encounters the admitted revision-22 immutable-field failure

- **WHEN** Helm history proves revision 22 failed on chart 0.4.8 after rejecting
  the exact four standalone PVCs and the filer/master StatefulSets
- **THEN** Phase A validates the bound PVC, SeaweedFS claim-template and child-PVC
  metadata without reading Secret or volume data
- **AND** every render, diff and upgrade explicitly preserves the validated
  non-secret storageClass and size values without `--reuse-values`
- **AND** any identity, status, chart, failure-description, UID, binding,
  storageClass, size, selector, serviceName or claim-template drift fails before
  mutation

#### Scenario: Phase A resumes the admitted revision-23 non-numeric image-user failure

- **WHEN** the latest Helm history entry is revision 23, failed on chart 0.4.9
  with the exact canceled-upgrade description, revision 20 is the exact deployed
  0.4.1 source, and revision 22 is the exact failed 0.4.8 immutable-storage event
- **AND** public Deployment and Pod evidence proves exactly one new APISIX and
  one new observability Pod are Pending with their full named-user
  `CreateContainerConfigError`, while three APISIX and one observability replicas
  from the prior ReplicaSets remain Ready
- **THEN** Phase A targets immutable chart 0.4.19 and requires fresh backup and
  parity evidence plus the exact source/target/package confirmation
- **AND** it delegates to the existing two-pass Phase-A implementation without a
  fabricated Phase-A attestation, rollback, atomic upgrade or PVC deletion
- **AND** any history, description, image, label, owner, rollout count,
  generation, availability, waiting reason/message, storage or cancellation
  drift fails before mutation

#### Scenario: Phase A admits only the exact revision-23 partial manual recovery

- **WHEN** the exact revision-20/revision-22/revision-23 history and immutable
  storage anchor still holds after a partial `kubectl-patch`
- **AND** APISIX generation 7 is exactly 3/3 Ready on one revision-7 ReplicaSet
  whose controller owner name and UID match the observed Deployment, each Pod
  owner name and UID match that ReplicaSet, each Pod has pod UID 636 but no pod
  GID, reports runtime UID/GID 636:636 with zero restarts, and mounts
  `falcone-apisix-standalone` at the exact standalone path
- **AND** that existing ConfigMap contains only `apisix.yaml` with the approved
  SHA-256, observability remains one Ready plus one exact Pending `nobody`
  named-user failure, and no other namespace has such a failure
- **THEN** Phase A targets immutable chart 0.4.19, makes the APISIX identity and
  mount declarative, and requires fresh 0.4.19-bound backup/parity evidence plus
  the exact one-use target/package confirmation
- **AND** the rendered target SHALL contain APISIX pod and container UID/GID
  636:636, and each post-upgrade health gate SHALL observe that APISIX state plus
  Prometheus container UID/GID 65534:65534 before the next pass may proceed
- **AND** render validation SHALL parse exactly one structurally matching APISIX
  Deployment locally and SHALL NOT invoke a Kubernetes create/apply verb
- **AND** Helm SHALL NOT create or adopt the existing standalone ConfigMap
- **AND** any precursor or render history, storage, generation, image, label,
  owner name/UID/revision, mount, mode, UID/GID, restart, count, readiness, error
  or ConfigMap-content drift SHALL fail before mutation
- **AND** any post-upgrade UID/GID or readiness drift SHALL fail its health gate,
  require forward recovery and prevent the next upgrade pass

#### Scenario: Phase A does not wait globally for the intentionally Pending vector workload

- **WHEN** the exact unbound vector PVC and its ordinal-zero StatefulSet Pod
  remain Pending until the separately confirmed Phase B
- **THEN** neither Phase-A Helm upgrade SHALL use global `--wait`
- **AND** each Helm upgrade SHALL use `--timeout 20m`, after which Phase A SHALL
  run `rollout status --timeout=10m` separately for every managed Deployment,
  every managed non-vector StatefulSet and the OpenBao StatefulSet
- **AND** after that rollout vector each health gate SHALL wait separately for
  FerretDB `Available` and `ClusterSecretStore/openbao-backend` `Ready`, each
  with `--timeout=10m`
- **AND** a rollout timeout or nonzero result SHALL stop before the next health
  gate, upgrade pass or completion and emit `FORWARD_RECOVERY_REQUIRED`; a
  first-pass or final health-gate failure SHALL additionally emit respectively
  `PHASE_A_HEALTH_GATE_FAILED` or `FINAL_HEALTH_GATE_FAILED`
- **AND** it SHALL NOT scale, delete or wait for the vector StatefulSet in
  Phase A
- **AND** Phase B SHALL retain global Helm wait after the empty claim is
  separately confirmed, deleted and recreated

#### Scenario: Legacy ClusterSecretStore hook is handed off before Phase A

- **WHEN** exactly one `ClusterSecretStore/openbao-backend` has the exact Helm
  owner tuple, revision-20 post-install/post-upgrade hook annotations and public
  provider spec whose sole desired drift is
  `external-secrets/eso-openbao-auth` to `eso-system/eso-openbao-auth`
- **THEN** dry-run SHALL report the handoff without mutation
- **AND** apply SHALL compare one unique desired rendered store, then use one
  JSON patch guarded by the live UID and resourceVersion to remove only the two
  hook annotations and replace only the public store spec
- **AND** retry of the exact desired store SHALL be idempotent
- **AND** the store and each canonical Falcone ExternalSecret —
  `gateway-apisix-credentials`, `gateway-shared-secret`,
  `iam-identity-client`, `iam-keycloak-credentials`, `iam-superadmin`,
  `platform-documentdb-credentials`, `platform-documentdb-replication`,
  `platform-encryption-key`, `platform-ferretdb-credentials`,
  `platform-kafka-credentials`, `platform-postgresql-credentials`,
  `platform-postgresql-vector-credentials`, `platform-s3-credentials`, and
  `platform-temporal-credentials` — SHALL become Ready through a separate
  `--timeout=10m` wait before Helm upgrade
- **AND** foreign owner, identity, spec, hook, cardinality, UID,
  resourceVersion or readiness drift SHALL fail before Helm mutation
- **AND** the procedure SHALL NOT read or patch a Secret, use
  `--take-ownership`, or mutate any administrator-owned ESO object

#### Scenario: Revision-24 recovery reconciles OpenBao auth before ESO handoff

- **WHEN** exact r24 recovery apply has validated the revision-20, revision-22,
  revision-23 and failed revision-24/chart-0.4.11 fingerprints plus fresh
  0.4.19 package-bound evidence and target confirmation
- **THEN** before mutating the ClusterSecretStore, any ExternalSecret owner
  metadata, or the Helm release, the CLI SHALL execute the official
  auth-reconcile Job rendered from that exact package with
  `allowRecoveryRoot=true`
- **AND** after validating that package-bound official Job, each attempt SHALL
  change only Job metadata: remove `metadata.name`; set `metadata.generateName`
  to `openbao-auth-reconcile-r24-<digest12>-`, where `<digest12>` is the first
  twelve lowercase hex characters following `sha256:` in the verified package
  digest; preserve all other metadata and every non-metadata field; and add
  annotations `in-falcone.io/recovery-package-digest=<full verified digest>`,
  `in-falcone.io/recovery-target-chart=in-falcone-0.4.19`, and
  `in-falcone.io/recovery-source-revision=24`
- **AND** the CLI SHALL create, never apply, the attempt with
  `kubectl create -f <attempt> -o name`; it SHALL accept exactly one newly
  returned ref matching
  `^job\.batch/openbao-auth-reconcile-r24-<digest12>-[a-z0-9]([-a-z0-9]*[a-z0-9])?$`
  whose generated name is DNS-valid, and SHALL reject empty, multiple, stale or
  otherwise drifting output
- **AND** the rendered Job SHALL set `spec.activeDeadlineSeconds=300`, and the
  CLI SHALL pass exactly that newly returned ref to the `Complete`
  `--timeout=5m` wait and subsequent log read
- **AND** expiration or failed completion SHALL leave the failed Job in
  `secret-store` for evidence and SHALL NOT delete it on the failure path
- **AND** the CLI SHALL NOT read any Kubernetes Secret resource or payload and
  neither the Job nor the CLI SHALL emit a credential

#### Scenario: Revision-24 recovery fails closed when auth reconciliation does not complete

- **WHEN** the package-bound auth-reconcile Job cannot be created, create output
  does not identify exactly one new digest-prefixed DNS-valid ref, that attempt
  reaches its 300-second active deadline, does not become `Complete` within the
  CLI's five-minute wait, exits unsuccessfully, or its terminal log is missing,
  duplicated, unpaired, or otherwise different from the two allowed success lines
- **THEN** r24 recovery SHALL fail closed and SHALL NOT mutate the
  ClusterSecretStore, any ExternalSecret owner metadata, or the Helm release
- **AND** render, create, create-ref, completion, log-read and log-content
  failures SHALL emit respectively `REVISION24_AUTH_RECONCILE_RENDER_FAILED` or
  `REVISION24_AUTH_RECONCILE_RENDER_DRIFT`,
  `REVISION24_AUTH_RECONCILE_CREATE_FAILED`,
  `REVISION24_AUTH_RECONCILE_CREATE_REF_DRIFT`,
  `REVISION24_AUTH_RECONCILE_INCOMPLETE`,
  `REVISION24_AUTH_RECONCILE_LOG_UNAVAILABLE`, or
  `REVISION24_AUTH_RECONCILE_EVIDENCE_DRIFT`, followed by
  `FORWARD_RECOVERY_REQUIRED` once auth execution has started
- **AND** every failed attempt SHALL remain in `secret-store` as evidence; retry
  SHALL repeat complete live/package preflight and create a new generated Job
  identity from the newly validated package-bound object, never delete, reuse,
  patch or reapply a prior attempt, and never accept a stale Job or log as current
  evidence

#### Scenario: Revision-24 auth preflight renders in Helm upgrade context

- **WHEN** exact revision-24 Phase-A recovery renders only the package-bound
  `openbao-auth-reconcile` Job before any mutation
- **THEN** the Helm template command SHALL include `--is-upgrade` while retaining
  the exact target version, namespace, values, recovery-root override, and
  `--show-only charts/openbao/templates/openbao-auth-reconcile-job.yaml`
- **AND** upgrade-only validation failure SHALL emit
  `REVISION24_AUTH_RECONCILE_RENDER_FAILED`, perform no mutation, and SHALL NOT
  weaken or bypass the chart's upgrade-only validation contract

#### Scenario: Revision-24 recovery admits only the exact 0.4.14 self-token policy failure

- **WHEN** live Helm still has failed revision 24/chart 0.4.11 and the desired
  `openbao-backend` store has the exact UID, labels, Helm owner and provider spec,
  no hook annotations, exact
  `in-falcone.io/reconcile-request=phase-a-0.4.12-auth-updated`, and one
  `Ready=False`/`ValidationFailed` condition whose literal message reports HTTPS
  GET of the OpenBao FQDN `/v1/auth/token/lookup-self`, code 403 and permission
  denied
- **AND** the same fourteen canonical ExternalSecrets exist uniquely in the
  exact namespace and all r20/r22/r23/r24, storage, workload, ESO-owner and JIT
  gates still match
- **THEN** preflight SHALL capture the store resourceVersion dynamically, admit
  that exact 0.4.14 partial precursor, and reject any URL, code, reason, message,
  spec, annotation, UID, or cardinality drift before
  mutation
- **AND** apply SHALL NOT patch the already-desired store; it SHALL create a new
  digest-bound 0.4.19 auth Job before waiting for the store and fourteen
  ExternalSecrets and before either Helm upgrade
- **AND** the retained 0.4.14 Job
  `openbao-auth-reconcile-r24-859e037a14be-7v86n` SHALL never be waited, logged,
  deleted, patched, reapplied, or accepted as the current execution; retry SHALL
  create a new 0.4.19 identity

#### Scenario: Revision-24 recovery admits only homogeneous ExternalSecret states for the exact self-token policy failure

- **WHEN** the store matches the exact admitted desired-store lookup-self 403
  fingerprint and all fourteen canonical ExternalSecrets are unique and in
  `in-falcone-staging`
- **THEN** preflight SHALL accept only one of two homogeneous sets: every object
  has exactly one condition with type `Ready` and status `True`; or every object
  has exactly one condition with type `Ready`, status `False`, reason
  `SecretSyncedError`, and message
  `could not get secret data from provider`
- **AND** both admitted sets SHALL run the fresh package-bound 0.4.19 auth Job
  first, SHALL NOT patch the already-desired store, and SHALL then wait for that
  store and all fourteen ExternalSecrets before either Helm upgrade
- **AND** ExternalSecret UIDs SHALL NOT be required or hardcoded

#### Scenario: Revision-24 recovery rejects ExternalSecret precursor drift before mutation

- **WHEN** the exact self-token policy store fingerprint is present but the
  ExternalSecret set has a missing, additional or duplicate name; a namespace
  drift; mixed readiness states; a missing or extra condition; or a different
  condition type, status, reason, or message
- **THEN** recovery SHALL emit
  `LEGACY_CLUSTERSECRETSTORE_EXTERNALSECRET_DRIFT` before creating the auth Job,
  patching the store or ExternalSecret ownership, or invoking Helm
- **AND** it SHALL NOT read Kubernetes Secret resources or payloads

#### Scenario: Revision-24 recovery targets only the corrected 0.4.19 package

- **WHEN** revision-24 Phase-A apply presents a confirmation targeting the
  published pre-create-failed chart 0.4.18 rather than chart 0.4.19
- **THEN** the early target gate SHALL emit `JIT_TARGET_CONFIRMATION_REQUIRED`
  before loading package-bound evidence or performing any mutation
- **AND** accepted evidence, confirmation, generated auth Job provenance, Helm
  upgrades, Phase-A attestation, and forward recovery SHALL bind only immutable
  chart 0.4.19 and its exact published digest

#### Scenario: Revision-24 recovery requires exact auth reconciliation evidence

- **WHEN** the package-bound pre-handoff auth-reconcile Job reports completion
- **THEN** the CLI SHALL accept exactly one paired terminal result:
  `result=changed code=AUTH_METADATA_CONVERGED canary=passed` or
  `result=unchanged code=AUTH_METADATA_MATCHED canary=passed`
- **AND** the CLI SHALL read and validate that terminal result only after the
  current package-bound execution becomes `Complete`, using exactly the fresh
  resource ref returned by that attempt's create for both wait and log; every
  retry SHALL validate only its newly created execution's log
- **AND** that fresh log SHALL contain exactly one
  `auth_source=recovery_root result=accepted` marker on every attempt; a retained
  current Successful Job SHALL NOT substitute or relax this requirement
- **AND** the successful attempt SHALL be retained at least until both Phase-A
  passes and final no-root health complete; no earlier successful or failed Job
  SHALL substitute for the current attempt
- **AND** a missing, duplicated, cross-paired, malformed, or otherwise drifting
  terminal result SHALL fail closed before the ClusterSecretStore, any
  ExternalSecret owner metadata, or the Helm release is mutated
- **AND** accepted logs SHALL contain no credential material

#### Scenario: Revision-24 recovery forces recovery-root authentication before the pre-handoff canary

- **WHEN** the package-bound isolated revision-24 Job renders with
  `allowRecoveryRoot=true` and `forceRecoveryRoot=true`
- **THEN** it SHALL NOT attempt the dedicated Kubernetes login, SHALL load the
  mounted recovery token directly without printing it, and SHALL emit exactly
  `auth_source=recovery_root result=accepted`
- **AND** it SHALL write the exact platform policy before any ESO role mutation
  or validation and before canary login
- **AND** invalid `forceRecoveryRoot=true` with `allowRecoveryRoot=false` SHALL
  fail render validation

#### Scenario: Routine OpenBao reconciliation remains dedicated-only and cannot write policies

- **WHEN** a canonical install or routine upgrade renders auth reconciliation
- **THEN** both recovery flags SHALL default to false, the Job SHALL use only its
  dedicated Kubernetes login, SHALL mount no recovery Secret, and SHALL contain
  no policy-write command
- **AND** the compatibility form `allowRecoveryRoot=true` with force false MAY
  retain root fallback only after dedicated login failure, without changing the
  canonical routine behavior

#### Scenario: Revision-24 recovery binds forced-root evidence to a fresh 0.4.19 Job

- **WHEN** exact r24 recovery creates its fresh digest-bound 0.4.19 Job
- **THEN** the structural guard SHALL require the forced-root flag, recovery
  Secret mount, source marker and policy-before-terminal ordering before create
- **AND** the CLI SHALL accept exactly one forced-root source marker and exactly
  one existing `AUTH_METADATA_CONVERGED|MATCHED` terminal success from the fresh
  returned Job ref
- **AND** the source marker SHALL be exactly
  `auth_source=recovery_root result=accepted` for every fresh Job, including a
  retry after a retained current-package Successful Job
- **AND** a missing or dedicated marker, render drift, timeout or terminal drift
  SHALL fail before store readiness/ownership or Helm mutation and retain the
  attempt as evidence

#### Scenario: Revision-24 recovery preserves the exact retained 0.4.14 and 0.4.16 failure anchors

- **WHEN** the exact Store lookup-self 403 and homogeneous fourteen-ExternalSecret
  provider-error precursor is present
- **THEN** preflight SHALL list public Jobs and require these two exact predecessor anchors whose
  names begin `openbao-auth-reconcile-r24-`: the retained 0.4.14 and 0.4.16 Jobs with
  their exact names, UIDs, and exactly six package-digest/target/source plus Helm
  hook annotations
- **AND** each SHALL have `failed=1` and exactly two uniquely typed conditions,
  `FailureTarget` and `Failed`, both status `True` and reason
  `BackoffLimitExceeded`, with `succeeded` absent or zero and without fixing
  condition order, messages,
  resourceVersion or timestamps
- **AND** every additional prefix-matching Job SHALL be an attempt for the
  current package digest and target, with the exact digest-derived generated-name
  prefix and valid suffix, a unique UUID UID, and exactly seven annotations: the
  six package/target/source plus Helm hooks and attested chart version 0.4.19
- **AND** every current attempt SHALL have exactly one allowed terminal: either
  `failed=1`, succeeded absent or zero, and only `Failed` plus `FailureTarget`
  `True/BackoffLimitExceeded`; or `succeeded=1`, failed absent or zero, and only
  `Complete` plus `SuccessCriteriaMet` `True/CompletionsReached` as emitted by
  Kubernetes v1.36;
  names and UIDs SHALL be unique across the entire admitted history
- **AND** a missing anchor or any name, UID, annotation or status drift SHALL emit
  `REVISION24_AUTH_RECONCILE_HISTORY_DRIFT` before mutation
- **AND** the separate current history requirement SHALL also require the exact
  0.4.17 anchor; recovery SHALL never wait, log, delete, patch, apply or reuse
  any retained Job and SHALL create a fresh 0.4.19 identity on every retry

#### Scenario: Forced revision-24 reconciliation uses package-bound policy snapshots

- **WHEN** exact revision-24 recovery renders the forced auth Job from the
  digest-verified 0.4.19 package while chart 0.4.11 remains live
- **THEN** canonical platform and auth-reconcile ConfigMaps and the forced Job
  snapshots SHALL derive from one HCL source per policy and contain byte-equal
  package-rendered content
- **AND** only the forced Job SHALL embed and materialize those snapshots in
  private `emptyDir` volumes, verify their package-rendered SHA-256 values, and
  SHALL NOT mount `openbao-policy-platform` or
  `openbao-policy-auth-reconcile`
- **AND** platform SHALL grant only its existing KV capabilities plus exact
  `auth/token/lookup-self` read and `auth/token/revoke-self` update; wildcard
  token paths, `sudo`, `default` policy and broader capabilities remain forbidden

#### Scenario: Forced revision-24 reconciliation writes policy snapshots before roles and canary

- **WHEN** forced recovery authenticates through the mounted recovery-root token
- **THEN** it SHALL emit the credential-silent accepted source marker, write the
  package platform snapshot, write the package auth-reconcile snapshot, reconcile
  bootstrap/reconciler/ESO roles, and only then perform the ESO canary login,
  lookup-self and revoke-self
- **AND** snapshot/hash/write or ordering drift SHALL fail before store readiness,
  ExternalSecret ownership or Helm mutation

#### Scenario: Forced revision-24 reconciliation retains terminal failure diagnostics

- **WHEN** the forced package-bound Job reaches a terminal error
- **THEN** it SHALL use `restartPolicy: Never` and `backoffLimit: 0`, leaving one
  failed Pod/container attempt and its credential-silent log attached to the
  retained Job
- **AND** retry SHALL repeat every package/live/history gate and create a fresh
  digest-bound identity rather than restart, delete, wait on, log or reuse that
  terminal attempt

#### Scenario: Routine OpenBao reconciliation remains dedicated-only and cannot consume recovery snapshots

- **WHEN** a canonical install or routine upgrade renders auth reconciliation
- **THEN** both recovery flags SHALL default false, the Job SHALL authenticate
  only with its dedicated Kubernetes role, and it SHALL mount neither recovery
  credentials nor snapshot volumes
- **AND** the routine Job SHALL embed no package HCL, execute no policy write and
  receive no additional Secret, policy, mount or KV capability

#### Scenario: Revision-24 recovery admits only the exact retained 0.4.14, 0.4.16, and 0.4.17 failure chain

- **WHEN** the exact Store lookup-self 403 and homogeneous fourteen-ExternalSecret
  precursor is present for target package 0.4.19
- **THEN** preflight SHALL require the exact 0.4.14 and 0.4.16 anchors already
  specified plus 0.4.17 Job
  `openbao-auth-reconcile-r24-4cd761dd8b0a-qjnfw`, UID
  `c8fd1c27-f68b-4d33-b10f-3b832c741cd3`, digest
  `sha256:4cd761dd8b0a855cdae29a8f808382333918beb9ab7d0b485dffaaf81a677328`,
  target `in-falcone-0.4.17`, source 24, exactly six provenance/Helm hook
  annotations, `failed=1`, `succeeded` absent or zero, and exactly
  `FailureTarget` plus `Failed`, both `True/BackoffLimitExceeded`
- **AND** zero or more additional prefix Jobs SHALL be admitted only as unique,
  fully attested Failed or Kubernetes v1.36 Successful terminal attempts for the
  current 0.4.19 digest/target, with exactly seven annotations versus the
  anchors' exact six
- **AND** missing/drifting anchors or current attempts SHALL fail before mutation;
  target 0.4.18 or older SHALL fail the early JIT target confirmation, and recovery SHALL
  create a fresh digest-bound 0.4.19 identity without reusing retained evidence

#### Scenario: External ESO network reachability remains an operator prerequisite

- **WHEN** the administrator-owned ESO controller cannot reach OpenBao because
  its externally managed network or egress prerequisite is absent after the
  auth-first gate and CAS store handoff
- **THEN** the readiness sequence SHALL gate the ClusterSecretStore followed by
  each canonical ExternalSecret with a separate `--timeout=10m` wait:
  `gateway-apisix-credentials`, `gateway-shared-secret`,
  `iam-identity-client`, `iam-keycloak-credentials`, `iam-superadmin`,
  `platform-documentdb-credentials`, `platform-documentdb-replication`,
  `platform-encryption-key`, `platform-ferretdb-credentials`,
  `platform-kafka-credentials`, `platform-postgresql-credentials`,
  `platform-postgresql-vector-credentials`, `platform-s3-credentials`, and
  `platform-temporal-credentials`
- **AND** the first readiness timeout SHALL stop the sequence before any
  ExternalSecret owner patch or Helm upgrade, retain prior mutation evidence, and emit
  `FORWARD_RECOVERY_REQUIRED` rather than roll back
- **AND** Falcone SHALL NOT create, adopt, or mutate the `external-secrets`
  namespace, its controller, or its administrator-owned network policy

#### Scenario: Phase A resumes only the exact revision-24 global-wait timeout

- **WHEN** the latest Helm entry is revision 24, failed chart 0.4.11, and its
  description contains the exact vector PVC Pending, vector StatefulSet 0/1,
  legacy store, deadline-exceeded fingerprint, and provider failures for exactly
  `gateway-apisix-credentials`, `gateway-shared-secret`,
  `iam-identity-client`, `iam-keycloak-credentials`, `iam-superadmin`,
  `platform-documentdb-credentials`, `platform-documentdb-replication`,
  `platform-encryption-key`, `platform-ferretdb-credentials`,
  `platform-kafka-credentials`, `platform-postgresql-credentials`,
  `platform-postgresql-vector-credentials`, `platform-s3-credentials`, and
  `platform-temporal-credentials`
- **AND** revisions 20, 22 and 23 retain their exact deployed/failed history,
  the vector PVC retains its exact UID/Pending/no-volume/no-PV state, all
  non-vector workloads are converged, APISIX is 3/3 at UID/GID 636,
  Prometheus is 1/1 at UID/GID 65534 and no named-user error remains
- **THEN** recovery SHALL target immutable chart 0.4.19 with fresh
  package-bound backup/parity evidence and exact r24→0.4.19 confirmation
- **AND** it SHALL complete the auth-first gate, the UID/resourceVersion-guarded
  idempotent store handoff, and the ten-minute-per-resource Ready gates for those
  exact fourteen identities in that order before either Helm upgrade
- **AND** it SHALL perform exactly two non-atomic Phase-A Helm upgrades without
  global wait and with `--timeout 20m`, and after each SHALL run
  `rollout status --timeout=10m` for deployments `falcone-apisix`,
  `falcone-control-plane`, `falcone-control-plane-executor`,
  `falcone-ferretdb`, `falcone-grafana`, `falcone-keycloak`,
  `falcone-observability`, `falcone-seaweedfs-s3`,
  `falcone-temporal-frontend`, `falcone-temporal-history`,
  `falcone-temporal-matching`, `falcone-temporal-web`,
  `falcone-temporal-worker`, `falcone-web-console`, and
  `falcone-workflow-worker`; StatefulSets `falcone-documentdb`,
  `falcone-kafka`, `falcone-postgresql`, `falcone-seaweedfs-filer`,
  `falcone-seaweedfs-master`, and `falcone-seaweedfs-volume`; and
  `secret-store/statefulset/openbao`, while never waiting for
  `falcone-postgresql-vector`
- **AND** each post-rollout health gate SHALL use `--timeout=10m` for FerretDB
  `Available` and the ClusterSecretStore `Ready`; a first or final gate failure
  SHALL emit respectively `PHASE_A_HEALTH_GATE_FAILED` or
  `FINAL_HEALTH_GATE_FAILED`, then `FORWARD_RECOVERY_REQUIRED`, stop before the
  next pass or success, and never roll back; the second pass SHALL run with
  recovery-root disabled
- **AND** any history, failure description, auth result/log, store,
  ExternalSecret, PVC, workload, identity or error-cardinality drift SHALL fail
  before the next mutation

### Requirement: Revision-24 package validation SHALL bind the semantic canary before mutation

The 0.4.19 public repair CLI SHALL validate the exact real package render before
creating its auth-reconcile Job. It SHALL bind the canary by semantic identity,
not by the position of a generic login substring, and SHALL preserve all
0.4.18 structural, policy, credential, ownership, readiness, storage and
fail-forward gates. A newly published 0.4.19 digest, fresh package-bound evidence
and a new one-use JIT SHALL be required; the consumed 0.4.18 JIT SHALL authorize
nothing.

#### Scenario: Revision-24 package guard binds exactly one semantic canary assignment

- **WHEN** the exact real 0.4.19 Helm render contains the earlier dedicated
  `login_json` branch and the later canary login
- **THEN** the guard SHALL require exactly one command substitution assigned to
  `canary_json` that contains `bao write -format=json auth/kubernetes/login`,
  exact `role="$role"`, and a JWT read from `/canary/token`
- **AND** it SHALL use that sole match object's captured start index for order
  validation and SHALL NOT use `str.index`, `str.rindex`, or a generic login
  substring to identify the canary
- **AND** the earlier dedicated login SHALL remain valid routine behavior and
  SHALL NOT satisfy or invalidate the semantic canary match

#### Scenario: Revision-24 package guard rejects canary identity drift before mutation

- **WHEN** the rendered canary assignment is absent or duplicated, is assigned
  to a name other than `canary_json`, changes the login command or role, reads a
  JWT from anything other than `/canary/token`, or only partially matches those
  facts
- **THEN** the CLI SHALL emit `REVISION24_AUTH_RECONCILE_RENDER_DRIFT` before
  `kubectl create`, ClusterSecretStore or ExternalSecret-owner mutation, or Helm
- **AND** it SHALL read no Secret resource or payload and disclose no credential

#### Scenario: Revision-24 package guard enforces the complete forced-recovery order

- **WHEN** the exact forced-recovery Job is structurally validated
- **THEN** the captured anchors SHALL occur strictly in this order: both package
  snapshots and their hash evidence, accepted recovery-root source, platform
  policy write, auth-reconcile policy write, all role reconciliation, semantic
  canary, `auth/token/lookup-self`, `auth/token/revoke-self`, and terminal result
- **AND** the guard SHALL continue to require exactly one Job/reconciler
  container, byte-equal HCL and SHA-256 values, private `emptyDir` policy
  volumes, no canonical policy ConfigMap mount, the recovery mount, exact policy
  capabilities and markers, `restartPolicy: Never`, and `backoffLimit: 0`
- **AND** any identity, cardinality, structure or order drift SHALL fail before
  create without weakening fresh-install or routine dedicated-only behavior

#### Scenario: Revision-24 public CLI validates the exact real packaged render

- **WHEN** release validation packages chart 0.4.19 and invokes the distributed
  public CLI with real Helm template output and substituted external effects
- **THEN** the exact render containing both login branches SHALL pass the guard
  and reach exactly one fresh digest-bound .19 `kubectl create` only after all
  read-only package/live/history gates
- **AND** negative assignment, role, JWT, duplicate, ordering and other
  structural drifts SHALL each stop before every cluster mutation
- **AND** a reduced or synthetic fixture that omits the dedicated branch SHALL
  NOT be sufficient release evidence by itself

#### Scenario: Revision-24 pre-create failure distinguishes authorization consumption from cluster mutation

- **WHEN** the fresh digest-bound 0.4.19 JIT has been accepted but package render
  or semantic/structural guard validation fails before `kubectl create`
- **THEN** the CLI SHALL report `authorization_consumed=true` and SHALL NOT report
  `mutation_started=true` or `FORWARD_RECOVERY_REQUIRED`
- **AND** it SHALL set `mutation_started=true` immediately before attempting
  `kubectl create`, so create response loss, create failure and every later
  failure conservatively retain the fail-forward instruction
- **AND** it SHALL NOT set the mutation marker only after create succeeds

#### Scenario: Revision-24 recovery preserves only historical anchors and current 0.4.19 retries

- **WHEN** exact r24 recovery validates prefix-matching auth-reconcile Job history
- **THEN** it SHALL require only the exact retained .14/.16/.17 anchors plus zero
  or more unique fully attested Failed or Kubernetes v1.36 Successful attempts
  for the current 0.4.19 package digest and target
- **AND** anchors SHALL have exactly six annotations and current attempts exactly
  seven, with exact name/UID uniqueness, provenance and one allowed terminal;
  any drift SHALL fail closed before fresh create
- **AND** the fence SHALL run after exact Store and fourteen-ExternalSecret
  precursor validation for every Store state admitted by exact r24 recovery,
  including Store `Ready`/`complete` after a Successful current Job followed by
  downstream failure; no admitted Store state SHALL bypass the history read or
  allow create before it
- **AND** because 0.4.18 failed before create, any .18 Job name, generated prefix,
  target annotation or purported anchor SHALL emit
  `REVISION24_AUTH_RECONCILE_HISTORY_DRIFT` before mutation
- **AND** .18 SHALL NOT be waited, logged, deleted, patched, applied, reused, or
  accepted as a Job/Helm rollback target

#### Scenario: Chart 0.4.19 preserves fresh-install and routine dedicated-only behavior

- **WHEN** chart 0.4.19 is installed into a clean namespace or rendered for a
  routine supported upgrade outside the isolated r24 forced-recovery path
- **THEN** fresh install SHALL retain full bootstrap ordering and routine upgrade
  SHALL authenticate only with its dedicated Kubernetes role
- **AND** defaults SHALL keep both recovery flags false, and routine rendering
  SHALL contain no recovery Secret mount, package snapshot volume or policy write
- **AND** values/schema, ServiceAccounts/RBAC, images, probes, network policy,
  storage semantics and application/public contracts SHALL remain compatible
  with 0.4.18

#### Scenario: Chart 0.4.19 preserves isolation and the forward-only rollback boundary

- **WHEN** P7/P12 capability health and P13 adjacent-tenant/workload isolation
  are verified after disposable 0.4.19 install or recovery
- **THEN** credentials SHALL remain exact-workload scoped, no Secret payload or
  foreign tenant/workspace metadata SHALL be exposed, and administrator-owned
  ESO resources SHALL remain external
- **AND** pre-create failure SHALL require no cluster restoration, while every
  possible post-create mutation SHALL be recovered only by forward-applying the
  exact .19 package
- **AND** Helm rollback to .11 through .18 SHALL remain forbidden, and Phase-B
  PVC deletion SHALL remain irreversible without a separately approved
  backup/restore and isolation-parity design

### Requirement: Phase-A completion SHALL prove final no-root health

Phase A SHALL run the owner, six-image, store, exact fourteen-secret, auth,
FerretDB replica, and Ready-endpoint gates after the recovery-root allowance is
removed. Final OpenBao reconciliation SHALL report unchanged and canary passed,
and SHALL prove the exact four-policy token set without `default`.

#### Scenario: Final pass regresses a dependency

- **WHEN** any owner, image, store, ExternalSecret, auth, FerretDB, or endpoint
  gate regresses after the no-root pass
- **THEN** Phase A fails with `FINAL_HEALTH_GATE_FAILED` and requires forward
  recovery rather than reporting a successful attestation point

# Falcone Charts

This repository contains the Helm deployment packaging for Falcone. Application
source code and container image publishing remain in
[gntik-ai/falcone](https://github.com/gntik-ai/falcone).

The umbrella chart is `charts/in-falcone`. Clone this repository as a sibling
of the application repository when using Falcone's development and validation
tooling:

```bash
git clone https://github.com/gntik-ai/falcone-charts.git ../falcone-charts
helm install falcone ../falcone-charts/charts/in-falcone \
  --namespace falcone --create-namespace
```

Fresh installation does not require a pre-existing database backup. Every
subsequent `helm upgrade` runs the applying webhook database authority Job,
including an action-none/no-op `0.3.1` replay, and therefore must set
`global.webhookDatabase.migration.backupVerified=true`,
`parityVerified=true`, and a non-secret `backupReference`. The chart rejects
the upgrade before emitting a manifest when any gate is absent.

The chart-release workflow packages `charts/in-falcone` and publishes it as an
OCI artifact at `oci://ghcr.io/gntik-ai/charts/in-falcone`. Releases must use a
new `version` in `charts/in-falcone/Chart.yaml`.

## Webhook signing-key reference

Chart `0.3.1` requires a C-25-compatible control-plane image at version `0.3.1`
or later and owns the
platform webhook master-key reference at `global.webhookSigningKey`. The chart
never accepts key material in values or `controlPlane.env`. A fresh managed
installation uses these defaults and creates an immutable retained Secret from
inside the credential hook:

```yaml
global:
  webhookSigningKey:
    create: true
    secretName: in-falcone-webhook-signing-key
    secretKey: key
    adoption: { mode: none, requestId: "" }
    rotation:
      action: none
      requestId: ""
      sourceSecretName: ""
      sourceSecretKey: ""
      rotationId: ""
      recoveryWindowSeconds: 604800
```

For externally managed custody, set `create: false` and provision the named
Secret/key through the external manager before installation. The hook validates
it with exact-name read-only RBAC. Managed mode uses the same exact-name `get`
rule plus a separate namespace-scoped `create` rule; neither mode grants Secret
list/watch/update/patch/delete. Never place the value in a values file, `--set`,
rendered YAML, shell arguments, or evidence.

The base, kind, OpenShift, and local install profiles all select the compatible
`0.3.1` control-plane image for the runtime and both hook Jobs. The published
artifact is pinned in `values.yaml` to
`sha256:a6f90cd0c3e6e5ee5e783bba1d9fbce3c03be10590c85753cde3339fbcd4ad1d`
(published as `ghcr.io/gntik-ai/in-falcone-control-plane:0.3.1-c25-pr909-r2`
from the Falcone PR #909 release candidate); registry rewriting preserves that
digest. Every Helm revision also changes the non-secret control-plane pod-template annotation
`in-falcone.io/release-revision`, forcing new pods to re-run the database
sentinel/state check even when an external Secret reference is unchanged. The
marker is not derived from Secret bytes. If an external manager mutates bytes in
place, new pods fail readiness/startup while existing pods that already resolved
the matching context remain safe; use a new Secret identity for supported
rotation.

Existing pre-0.3.1 ciphertext must first use an upgrade-only explicit
`adoption.mode: legacy` request with the exact historical value supplied through
an external Secret. Canonical `rotate`, forward `recover`, and `finalize` are
separate pre-upgrade maintenance actions with unique request/rotation IDs and a
distinct source/target Secret identity. They require a tested database backup,
matching retained key custody, and a maintenance window. Do not use Helm rollback
across a key transition; use the fixed chart's forward recovery lifecycle. The
detailed [operator runbook](https://github.com/gntik-ai/falcone/blob/main/docs-site/operations/webhook-signing-key-lifecycle.md)
defines the complete field/cross-field contract, preflight, backup/key-custody
coupling, maintenance drain, status and secret-safe evidence, retry/recovery,
restore, finalization/deletion boundaries, and fail-closed incident response.
Its image/chart publication and live rehearsal requirements are release gates
outside this code-adjacent configuration reference.

## Webhook PostgreSQL principals

C-25 preserves the global control-plane `DB_URL`/`PG*` contract while adding
four Secret-backed webhook-only DSNs for schema, runtime, encrypted writes, and
lifecycle work. A dedicated credential hook creates or read-only validates the
immutable retained credential Secret; a PostgreSQL 16 authority bootstrap
establishes the exact role graph and bounded ownership handoff before
application DDL/listen. The PostgreSQL administrator Secret is referenced only
by that bootstrap path, never by the control-plane or lifecycle Job.
Before that bootstrap can mutate any role, membership, schema ACL, or owner, it
authenticates every pre-existing bounded LOGIN through its retained credential
and rejects a mismatch without changing database authority.

The credential hook's ServiceAccount, Role, RoleBinding, support ConfigMap, and
Job are removed after the complete hook succeeds. With Helm 4.1.4, a later
credential Job failure also applies `hook-succeeded` cleanup to the preceding
successful support hooks: the ServiceAccount, Role, RoleBinding, and ConfigMap
are removed, while the failed Job and its owned Pod remain as bounded evidence.
On retry, `before-hook-creation` clears any same-name remnants and Helm
recreates the support hooks before the Job. Ordinary upgrades render no
collection-wide Secret or ConfigMap create permission.

Legacy managed upgrades explicitly set
`global.webhookDatabase.migration.firstHandoff=true` with the backup/parity
evidence gates. A retained non-secret initialization marker permits that
bootstrap once and prevents a missing credential Secret from being regenerated
when old values are replayed.

The same three evidence gates are mandatory for every later applying upgrade,
even when `firstHandoff=false`, the signing-key lifecycle action is `none`, and
the database graph is expected to be unchanged:

```bash
helm upgrade falcone charts/in-falcone \
  --namespace falcone \
  --set deployment.upgrade.currentVersion=0.3.1 \
  --set global.webhookDatabase.migration.firstHandoff=false \
  --set global.webhookDatabase.migration.backupVerified=true \
  --set global.webhookDatabase.migration.parityVerified=true \
  --set global.webhookDatabase.migration.backupReference=BACKUP-EVIDENCE-ID
```

See
[WEBHOOK-DATABASE-AUTHORITY.md](charts/in-falcone/WEBHOOK-DATABASE-AUTHORITY.md)
for managed/external custody, fresh install, the required backup/parity gate,
legacy ownership handoff, TLS verification, secret-safe posture checks,
failure codes, forward recovery, and restore-only rollback limitations.

> **Upgrade compatibility:** chart `0.3.1` accepts truthful source versions `0.2.0`,
> `0.3.0`, and `0.3.1` in `deployment.upgrade.supportedPreviousVersions`. This
> permits the initial transition and later `0.3.1` rotation, recovery,
> finalization, and action-none cleanup upgrades. Unsupported sources and
> downgrades remain rejected. Do not falsify `deployment.upgrade.currentVersion`
> or disable validation to bypass this gate.

## History

Chart and deployment-value history was extracted from
[gntik-ai/falcone](https://github.com/gntik-ai/falcone) with `git filter-repo`.
The retained commits preserve the evolution of the moved paths while excluding
application source files from this repository.

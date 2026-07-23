# Falcone Charts

This repository contains the Helm deployment packaging for Falcone. Application
source code and container image publishing remain in
[gntik-ai/falcone](https://github.com/gntik-ai/falcone).

The umbrella chart is `charts/in-falcone`. Clone this repository as a sibling
of the application repository when using Falcone's development and validation
tooling:

```bash
git clone https://github.com/gntik-ai/falcone-charts.git ../falcone-charts
helm upgrade --install falcone ../falcone-charts/charts/in-falcone \
  --namespace falcone --create-namespace
```

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
`0.3.1` control-plane image for the runtime and both hook Jobs. Every Helm
revision also changes the non-secret control-plane pod-template annotation
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

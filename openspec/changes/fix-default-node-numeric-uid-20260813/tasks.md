## 1. Regression contract

- [x] 1.1 Add a failing public black-box render test with the exact scenarios
  `Vanilla Kubernetes starts Node images that declare named users` and
  `OpenShift retains arbitrary UID assignment for Node workloads`, selecting
  only the `controlPlaneExecutor` and `workflowWorker` Deployments.
- [x] 1.2 Add schema-negative cases for root, negative, named/string, and
  fractional UID/GID inputs, plus positive numeric overrides and explicit
  legacy/null render compatibility.
- [x] 1.3 Reproduce pre-fix on authorized context `default` (K3s v1.36.1) in
  disposable namespace `falcone-node-uid-live-0814`: exact `:0.3.0` images,
  two replicas per workload, historical contexts without numeric UID/GID,
  Deployments 0/2, and exactly four of four pods in
  `CreateContainerConfigError` from kubelet's non-numeric `node` user; store no
  credentials, kubeconfig, or raw cluster evidence in Git.

## 2. Scoped chart correction

- [x] 2.1 Add numeric `runAsUser: 1000` and `runAsGroup: 1000` only to the
  default container security contexts of `controlPlaneExecutor` and
  `workflowWorker`, preserving every existing hardening field.
- [x] 2.2 Reuse the unchanged `openshiftRestricted` component-wrapper path and
  prove by OpenShift render that it omits the new IDs at both pod and container
  scope while retaining non-root hardening; do not edit the overlay.
- [x] 2.3 Add positive-integer/null constraints through an umbrella-schema
  definition applied only to `controlPlaneExecutor` and `workflowWorker`; leave
  the generic component-wrapper schema unchanged to avoid widening scope.
- [x] 2.4 Confirm by scoped diff and render inventory that the implementation
  does not change chart version, images,
  replicas, Keycloak, service accounts, authorization/isolation, storage,
  credentials, or public APIs.

## 3. Compatibility, operations, and targeted downgrade

- [x] 3.1 Align values guidance, release notes, and operator instructions with
  the default 1000:1000 contract, custom-image numeric override, OpenShift
  namespace-range primary UID behavior, separate `fsGroup`/supplemental-group
  strategies, the prohibition on claiming an SCC-assigned primary GID, and
  complete copyable commands defining every required argument and placeholder.
- [x] 3.2 Add the executable standalone verifier and two platform-specific
  historical-downgrade entrypoints plus their small reviewed values overlays.
- [x] 3.3 Complete the standalone verifier contract: accept only
  release/namespace/platform; resolve Helm `trunc 63 | trimSuffix "-"` names or
  reject; verify exactly two desired/updated/ready/available replicas and two
  Running/Ready pods per workload; verify full container hardening, exact
  vanilla IDs or pod-and-container OpenShift omission plus namespace-range UID;
  reject `CreateContainerConfigError` with stable non-secret `NODE_VERIFY_*`
  diagnostics and no provenance arguments or claims.
- [x] 3.4 Complete both downgrade entrypoints: accept exact
  namespace/release/version/digest; repeat the exact OCI/version pull into a
  private temporary directory; require exactly one regular expected-name `.tgz`;
  verify filename/package metadata/version and byte SHA-256; forbid
  digest-output/alternate-remote/discovery/OCI-upgrade fallbacks; pass only that
  verified local package to `helm upgrade --reuse-values` with the one small
  reviewed platform overlay, then invoke the standalone verifier; never use
  blind history-index-based `helm rollback`; emit only stable non-secret
  `NODE_DOWNGRADE_*` diagnostics.
- [x] 3.5 Prove by render-only legacy/default comparison that the simulated
  upgrade delta is limited to the two affected container identities and changes
  no non-target rendered resource; do not represent this as live convergence.
- [x] 3.6 Upgrade fail-forward on the same disposable K3s release to numeric
  1000:1000 and prove both Deployments have exactly two
  desired/updated/ready/available replicas, all four pods are Running/Ready, and
  there are zero restarts and zero configuration errors. The minimal fixture had
  no PVC, Secret payload, application API, or tenant resources; shared staging
  was not mutated, so no broader migration/isolation claim is made.
- [x] 3.7 Prove by render-only downgrade simulations that vanilla explicit
  numeric overrides retain hardening and OpenShift strips fixed identities;
  do not represent these renders as a live downgrade or as runtime GID proof.
- [x] 3.8 Execute the vanilla targeted downgrade on disposable K3s using a local
  fixture `.tgz` with exact Chart version 0.4.18 metadata and attested byte
  SHA-256, `helm upgrade --reuse-values`, and the small numeric overlay; verify
  both Deployments remain exactly 2/2 and all four pods Running/Ready, then
  restore 0.4.19, uninstall the release, and delete
  `falcone-node-uid-live-0814`. Never use blind `helm rollback`.
- [ ] 3.9 **BLOCKED / not run:** execute the targeted downgrade and verifier on
  an authorized disposable OpenShift target, requiring pod-and-container fixed
  ID omission, effective primary UID in the namespace range, separate group
  strategy handling, exactly two desired/updated/ready/available replicas and
  two Running/Ready pods per workload, and no `CreateContainerConfigError`. The
  only authorized context was K3s `default`, not OpenShift; do not infer live SCC
  behavior from the render-only proof.

## 4. Validation and review

- [x] 4.1 Parse the affected umbrella schema and unchanged wrapper schema, then
  run strict Helm lint plus default and OpenShift renders, asserting exact
  numeric/omitted identity and retained hardening for both workloads.
- [x] 4.2 Run the final focused Node-workload and operational-asset black-box
  contract: 17 tests, 17 pass, 0 fail, 0 skipped, with no committed runtime test
  artifacts.
- [x] 4.3 Run exactly one authoritative `bash tests/blackbox/run.sh`: 18 files,
  407 tests, 407 pass, 0 fail, 0 skipped, 0 cancelled, 0 todo, exit 0, TAP
  duration 1640525.277415 ms; verify Git status is identical before and after and
  commit no runtime test artifact.
- [x] 4.4 Run `openspec validate fix-default-node-numeric-uid-20260813 --strict`
  and keep the change valid after implementation bookkeeping.
- [x] 4.5 Obtain independent reviewer `APPROVE` for the draft: the scoped
  code/spec/test/docs chain, security/isolation boundary, Kubernetes behavior,
  OpenShift render contract, operational verifier, and targeted downgrade are
  complete for draft publication. Approval is explicitly conditioned on keeping
  task 3.9 OpenShift live `BLOCKED / not run` as an unmet gate before release or
  merge; do not treat draft approval as live SCC acceptance.

# Feature delivery ledger

## falcone-charts #6 — OpenShift air-gap source-build inputs

- Issue: https://github.com/gntik-ai/falcone-charts/issues/6
- Branch: `feature/6-openshift-build-from-source`
- Pull request: pending publication
- Personas: `P3` platform operator/SRE; `P4` security/compliance auditor; `P13` adjacent-scope actor
- Contract: `openspec/changes/add-6-openshift-airgap-build-inputs`
- Outcome: six source-build BuildConfigs accept deterministic private base images, build arguments,
  environment values and namespace-local registry pull-secret references while connected defaults
  remain compatible and private mode fails closed.
- Local verification: 31 focused black-box scenarios; strict Helm lint; strict OpenSpec validation;
  full chart CI with four lint profiles and twelve kubeconform matrices.
- Live verification: PASS on remote OpenShift project `cingusoft-dev`; six application builds and
  two internal base-mirror builds completed, six digest-backed ImageStreamTags were observed, and
  all 33 disposable resources were removed and proven absent.
- Independent gates: OpenSpec critic APPROVE; contract auditor APPROVE; authorization auditor
  APPROVE; docs reviewer APPROVE; final reviewer APPROVE.
- Known limitation: the project-scoped test user cannot read or mutate the cluster-scoped OpenShift
  image CA configuration; the chart truthfully documents it as an administrator prerequisite and
  renders no per-BuildConfig CA field.

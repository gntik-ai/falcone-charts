# Function network isolation

`functions.networkPolicy.enabled` defaults to `true`, including upgrades with
`helm upgrade --reuse-values` from chart defaults without a `functions` map.
The policy targets only pods labelled `in-falcone.io/component: function`.
Ingress comes only from `functions.networkPolicy.gatewayNamespaces` (default
`knative-serving` and `kourier-system`). An empty namespace list denies all ingress.

Default egress permits TCP/UDP 53 only to `kube-system` pods labelled
`k8s-app: kube-dns`. Before rollout, verify the cluster DNS labels and routing;
NodeLocal DNS or a different DNS layout requires a reviewed explicit destination.
No data service or public internet access is granted by default. Configure each
required pod destination and port explicitly, for example:

```yaml
functions:
  networkPolicy:
    allowedEgress:
      - namespace: in-falcone-staging # Omit to use the release namespace.
        podLabels:
          app.kubernetes.io/name: control-plane
        ports:
          - protocol: TCP
            port: 8080
```

Each entry needs nonempty pod labels and ports. All egress peers also exclude
pods carrying the function component label and both the default and configured
Knative data-plane namespaces. Broad labels cannot override these exclusions.
Public IP/CIDR grants are deliberately absent; review required external access
through a separately selected proxy destination before release. Kubernetes
NetworkPolicy grants are additive: another policy selecting these function pods
can widen access, so the cluster acceptance must check the effective policies.

Existing functions need the source change's ownership-checked
`PATCH /v1/functions/actions/{id}` re-roll to acquire the pod label and public-key
environment. Reapplying the same definition is idempotent. Configure the signer
first through control-plane-only External Secrets/OpenBao; private signing
material must never reach a function. Roll out the credential-signing control
plane before re-rolling functions onto an enforcing runtime. Confirm signer
reconciliation through status and a legitimate invocation before the re-roll;
an enforcing runtime paired with a control plane that cannot sign rejects all
invocations. Then re-roll every existing owned function through PATCH, and prove
a cold-start invocation writes exactly one activation. Coordinate public-key
overlap rotation and re-roll using the source repository's
`docs/installation/function-invocation-isolation.md`. This policy requires no
image change and disabling its toggle does not disable runtime authentication.

ENFORCEMENT CAVEAT (ADR-12): kindnet does not enforce NetworkPolicy. On a
policy-enforcing CNI, prove that tenant B cannot reach tenant A's cluster-local
function host and A's activation total remains zero. A legitimate public-API
invocation must succeed from cold start and write exactly one activation. A
direct unauthenticated POST to the caller's own function must be denied by the
network or return 401. Repository render tests do not establish this live evidence.

## Invocation signer delivery

OpenBao bootstrap seeds the KV v2 record `secret/control-plane/function-invocation`
on fresh installs and upgrades without manual provisioning. Fresh installs use
`openbao-init`; upgrades (including GitOps upgrade semantics) use
`openbao-function-invocation-seed` after auth reconciliation and before ESO hooks.
The upgrade Job authenticates through the existing `openbao-bootstrap` identity
and `openbao-init-role`, without mounting recovery credentials or expanding the
metadata-only auth reconciler's permissions.

The signer path is outside `platform/*`, which the executor and workflow worker
can read through `platform-role`. The dedicated `function-invocation` policy grants
read access to the exact configured signer path and is attached only to `eso-role`.
The existing init policy allows the isolated bootstrap identity to provision it.
Neither tenant-code identity can access the signer path or change its policy or
ESO role. Chart validation rejects paths outside `control-plane/function-invocation`
and its descendants, including the previous `platform/functions/invocation` path.

On upgrades, the metadata-only auth reconciler retains exact ESO policy checks,
adding the signer policy name to the role. The later seed Job publishes that
policy from embedded package bytes before touching the signer record. A binding
to a policy that does not yet exist grants no access; publication failure stops
bootstrap before key delivery. This ordering repairs Kubernetes auth before the
seed logs in and keeps policy writes out of the routine reconciler. Fresh installs
publish the policy during init. No old signer is read or copied from `platform/`.

Its properties are `private-key` (Ed25519 PKCS#8 PEM), `key-id` (the active signing
key's `kid`) and `jwks` (a JSON public-only Ed25519 JWKS containing that `kid`).
Only an absent record triggers key generation in the existing dedicated OpenSSL
image. Files stay in a restricted memory-backed volume shared only with the
bootstrap container and are removed after storage. KV v2 compare-and-set version
zero prevents replacement, including concurrent bootstraps and transient read
failures. Existing records, key IDs and overlapping public keys are preserved;
an incomplete existing record fails closed rather than silently rotating keys.
Never put these contents in Helm values, Git, logs or function definitions.
`global.functionInvocation.remoteKey` changes the KV path within `control-plane/function-invocation`;
`global.functionInvocation.secretName` changes the target Secret name. Missing
values use the same defaults during `helm upgrade --reuse-values`.

The chart's `platform-function-invocation` ExternalSecret uses the existing
`openbao-backend` ClusterSecretStore and ESO refresh interval. ESO creates and
refreshes the target Secret with `creationPolicy: Orphan` and
`deletionPolicy: Retain`; no pre-created Secret or inline-key fallback is needed.
The target has no ExternalSecret owner reference, so replacing the managed hook
on upgrades cannot garbage-collect signing keys during a control-plane rollout.
It follows existing post-install/post-upgrade hook ordering with bundled ESO,
and is an ordinary tracked resource with an administrator-owned ESO controller.
Confirm reconciliation using status only, without retrieving Secret contents.
Only `control-plane` mounts the Secret at `/var/run/falcone/function-invocation`
and receives only the directory path in `FN_INVOCATION_SECRET_DIR`.
The mount is read-only, projects only
`private-key`, `key-id` and `jwks` with mode `0440`, and has no `subPath`.
The pod's filesystem group grants the application read access; OpenShift's SCC
provides the group under the restricted profile. `control-plane-executor` never
signs invocations and runs tenant function source in-process by default, so it
must receive neither this Secret nor signer configuration. No sidecar, init
container, shared ConfigMap or function pod receives this Secret.

The optional volume permits startup before managed ESO's post-install/post-upgrade
hooks, avoiding a Helm `--wait` deadlock. Once ESO reconciles, kubelet populates
the directory in running pods. The source signer reads it on every operation and
pins one atomic kubelet projection for each read, so delayed delivery and rotation
take effect without restarting the control plane. Missing or invalid files fail
closed: function deploys are rejected and invocations return 503 until valid keys
arrive; other APIs can start, including profiles without functions/Knative.
Bootstrap failure prevents the release's signer delivery hooks from proceeding
successfully. Check reconciliation and delivery using status and a legitimate
invocation, without retrieving Secret contents.

For rotation, publish overlapping old/new public keys first, allow ESO and kubelet
to refresh the control plane's signer directory, and re-roll owned function
revisions through the existing PATCH flow. Then switch the active private key and `key-id`, allow
the projection to refresh, and retain the previous public key until old revisions
and in-flight invocations have drained. Runtime image publication and promotion,
ESO reconciliation, projected-volume delivery and live cold-start/CNI evidence
remain release gates.

## Repository review evidence (2026-10-07)

Revalidated the assigned implementation at commit `7f2a078` without changing
templates, values, image references or safety gates. The selector-reality suite
discovers all 25 shipped umbrella-chart values overlays, including topology,
platform, airgap, kind and e2e overlays. Each must
render exactly one function policy with the default ingress/egress bounds and a
selector matching the function fixture's pod template. The existing toggle,
explicit-egress, unsafe-input and historical-values checks remain in place.

All 17 selector-reality checks, signer-delivery, signer-bootstrap, flow-audit,
offline executor-upgrade and strict Helm lint passed again. Delivery contracts
cover control-plane-only signing, optional read-only whole-directory mounts,
managed install/upgrade hooks, external ESO, historical
values, custom references and the OpenShift restricted profile. Reserved directory
overrides fail closed, and no executor, sidecar or function fixture mounts signer
files. PR CI explicitly runs the signer-delivery, signer-bootstrap and
selector-reality suites; the blackbox runner
does not discover these top-level test files.

The required `bbx-temporal-bootstrap-048` reuse-values check was attempted again
but could not load because the locked `yaml` package is absent. It is recorded as
skipped locally; dependency installation needs unavailable network access.
It remains a CI gate, with no successful reuse-values upgrade claimed by this
review. Rerun with locked dependencies in PR CI.

The explicit-egress check evaluates Kubernetes selectors. In each tested profile,
the configured destination admits the rendered control-plane pod, DNS and
workspace data, but
rejects function pods even when they carry allowed destination labels. It also
rejects all tested destinations in default and configured Knative data-plane
namespaces. The check accounts for namespace/pod selector intersection and
separate peers, which Kubernetes combines as alternatives.

The live Helm/Argo upgrade matrix needs a disposable Docker/kind cluster and was
skipped locally. ESO reconciliation, projected signer delivery, cross-tenant
denial and cold-start activation evidence need a policy-enforcing cluster and
remain release gates. No cluster operation was performed during this review.

## Signer-policy follow-up (2026-10-07)

The dedicated signer path and policy close the executor/workflow-worker OpenBao
read path identified by the independent checker. Render tests inspect all seven
bootstrap roles and every attached policy for both tenant-code identities,
including policy/role mutation authority. They cover shipped deployment profiles,
custom signer paths and defaults missing from historical values. Bootstrap tests
also require denied policy publication to stop before any KV request.

Signer delivery/bootstrap, selector reality, flow-audit, external-ESO adoption,
offline executor upgrades and the updated auth-metadata render contracts pass.
The external-ESO and staging shell-syntax checks used a temporary local adapter
to pass the same script through `sh -n -c` because this sandbox does not close
the subprocess stdin pipe; the repository tests and CI remain intact.

The required reuse-values test still cannot load the absent locked `yaml` package.
Full r24 recovery attempts fail at fixture package extraction with
`REPAIR_PACKAGE_PULL_FAILED`; the same failure reproduces at the supplied
pre-fix HEAD, and sandbox tar extraction reports `Function not implemented`.
Rerun these checks, schema validation and live Helm/Argo upgrade checks in PR CI.
Live ESO delivery, function re-roll, cold-start activations and cross-tenant CNI
isolation remain release checks. Operations must confirm the DNS-only egress
default and review the previously reported init-generator stale-marker retry case.

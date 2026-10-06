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
material must never reach a function. Coordinate runtime enforcement, public-key
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

OpenBao bootstrap seeds the KV v2 record `secret/platform/functions/invocation`
on fresh installs and upgrades without manual provisioning. Fresh installs use
`openbao-init`; upgrades (including GitOps upgrade semantics) use
`openbao-function-invocation-seed` after auth reconciliation and before ESO hooks.
The upgrade Job authenticates through the existing `openbao-bootstrap` identity
and `openbao-init-role`, without mounting recovery credentials or expanding the
metadata-only auth reconciler's permissions.

Its properties are `private-key` (Ed25519 PKCS#8 PEM), `key-id` (the active signing
key's `kid`) and `jwks` (a JSON public-only Ed25519 JWKS containing that `kid`).
Only an absent record triggers key generation in the existing dedicated OpenSSL
image. Files stay in a restricted memory-backed volume shared only with the
bootstrap container and are removed after storage. KV v2 compare-and-set version
zero prevents replacement, including concurrent bootstraps and transient read
failures. Existing records, key IDs and overlapping public keys are preserved;
an incomplete existing record fails closed rather than silently rotating keys.
Never put these contents in Helm values, Git, logs or function definitions.
`global.functionInvocation.remoteKey` changes the KV path within `platform/`;
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
Both signer consumers, `control-plane` and `control-plane-executor`, mount the
Secret at `/var/run/falcone/function-invocation` and receive only the directory
path in `FN_INVOCATION_SECRET_DIR`. The mount is read-only, projects only
`private-key`, `key-id` and `jwks` with mode `0440`, and has no `subPath`.
The pod's filesystem group grants the application read access; OpenShift's SCC
provides the group under the restricted profile. No sidecar, init container,
shared ConfigMap or function pod receives this Secret.

The optional volume permits startup before managed ESO's post-install/post-upgrade
hooks, avoiding a Helm `--wait` deadlock. Once ESO reconciles, kubelet populates
the directory in running pods. The source signer reads it on every operation and
pins one atomic kubelet projection for each read, so delayed delivery and rotation
take effect without restarting either application. Missing or invalid files fail
closed: function deploys are rejected and invocations return 503 until valid keys
arrive; other APIs can start, including profiles without functions/Knative.
Bootstrap failure prevents the release's signer delivery hooks from proceeding
successfully. Check reconciliation and delivery using status and a legitimate
invocation, without retrieving Secret contents.

For rotation, publish overlapping old/new public keys first, allow ESO and kubelet
to refresh both signer consumers, and re-roll owned function revisions through
the existing PATCH flow. Then switch the active private key and `key-id`, allow
the projection to refresh, and retain the previous public key until old revisions
and in-flight invocations have drained. Runtime image publication and promotion,
ESO reconciliation, projected-volume delivery and live cold-start/CNI evidence
remain release gates.

## Repository review evidence (2026-10-06)

The selector-reality suite now discovers all 25 shipped umbrella-chart values
overlays, including topology, platform, airgap, kind and e2e overlays. Each must
render exactly one function policy with the default ingress/egress bounds and a
selector matching the function fixture's pod template. The existing toggle,
explicit-egress, unsafe-input and historical-values checks remain in place.

Scoped signer-delivery, bootstrap, flow-audit and offline executor-upgrade checks
passed. Delivery contracts cover both signer consumers, optional read-only
whole-directory mounts, managed install/upgrade hooks, external ESO, historical
values, custom references and the OpenShift restricted profile. Reserved directory
overrides fail closed, and no sidecar or function fixture mounts signer files.
The required `bbx-temporal-bootstrap-048` reuse-values check was attempted
but remains a CI gate: the locked `yaml` package is absent, and retrying with the
sandbox's installed YAML parser reached GNU tar extraction, which failed with
`Function not implemented`. This is no evidence of a successful reuse-values
upgrade. Rerun with locked dependencies and working archive extraction in PR CI.
The live Helm/Argo upgrade matrix and policy-enforcing cluster acceptance also
remain release gates; no cluster operation was performed during this review.

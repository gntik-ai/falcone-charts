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

Before releasing the paired source, provision the OpenBao KV v2 record
`secret/platform/functions/invocation` through the approved credential workflow.
Its properties are `private-key` (Ed25519 PKCS#8 PEM), `key-id` (the active signing
key's `kid`) and `jwks` (a JSON public-only Ed25519 JWKS containing that `kid`).
Never put these contents in Helm values, Git, logs or function definitions.
`global.functionInvocation.remoteKey` changes the KV path within `platform/`;
`global.functionInvocation.secretName` changes the target Secret name. Missing
values use the same defaults during `helm upgrade --reuse-values`.

The chart's `platform-function-invocation` ExternalSecret uses the existing
`openbao-backend` ClusterSecretStore and ESO refresh interval. ESO owns and creates
the new target Secret; no pre-created Secret or inline-key fallback is needed.
It follows existing post-install/post-upgrade hook ordering with bundled ESO,
and is an ordinary tracked resource with an administrator-owned ESO controller.
Confirm reconciliation using status only, without retrieving Secret contents.
The control-plane application's three optional Secret references populate
`FN_INVOCATION_PRIVATE_KEY`, `FN_INVOCATION_KEY_ID` and `FN_INVOCATION_JWKS`.
No other chart container, init container, shared ConfigMap or function pod
receives this Secret. Missing provisioning or reconciliation leaves the signer
environment absent and allows the control plane's other APIs to start, including
profiles without functions/Knative. Function deploys are rejected and invocations
return 503 until signing is configured; runtime enforcement remains enabled.
Optional references avoid a Helm `--wait` deadlock before the managed ESO
post-install/post-upgrade hooks run. The chart does not seed this OpenBao record;
signer provisioning remains a prerequisite for function availability.

After ESO has reconciled, restart the control plane through the approved rollout
to populate its environment before deploying or re-rolling functions. Check ESO
reconciliation and rollout status without retrieving Secret contents.

Secret-backed environment variables do not refresh in running containers.
For rotation, publish overlapping old/new public keys first, restart the control
plane through the approved rollout and re-roll owned function revisions through
the existing PATCH flow. Then switch the active private key and `key-id`, restart
the control plane, and retain the previous public key until old revisions and
in-flight invocations have drained. Runtime image publication and promotion,
signer provisioning and live cold-start/CNI evidence remain release gates.

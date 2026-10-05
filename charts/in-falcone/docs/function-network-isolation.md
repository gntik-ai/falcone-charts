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

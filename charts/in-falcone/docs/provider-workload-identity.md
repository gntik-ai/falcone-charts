# LLM provider workload identity

Provider identity profiles are operator-owned configuration for the executor's
credential broker (#939). Empty profiles and disabled projection are the defaults
and leave rendered manifests unchanged.

```yaml
controlPlaneExecutor:
  llmIdentityProfiles:
    provider:
      tokenEndpoint: https://identity.example.com/oauth/token
      audience: https://provider.example.com
      tenantAllowList:
        - tenant-a
      grantType: token-exchange
  llmIdentityToken:
    enabled: true
    audience: cloud-token-exchange
    expirationSeconds: 3600
```

`llmIdentityProfiles` becomes the executor-only `LLM_IDENTITY_PROFILES` JSON
environment variable. Profile names use letters, digits, underscores or hyphens
(up to 64 characters). Each profile requires a token endpoint, target audience
and explicit tenant allow-list; an empty list denies every tenant. `grantType`
may be `token-exchange` (RFC 8693, the runtime default) or `jwt-bearer`. The runtime
checks the endpoint and verified tenant again before exchanging credentials.

Projection is a separate opt-in. Its `audience` is the Kubernetes assertion
audience accepted by the exchange service; the profile's `audience` is the target
audience requested from that service. Configure the trust relationship for this
executor's ServiceAccount at the identity provider separately. The chart grants
no cloud permissions or additional Kubernetes RBAC.

Only the executor container mounts the read-only projected token directory at
`/var/run/secrets/falcone/llm-identity`; the broker reads `token` there. Kubelet
renews the file. The requested lifetime defaults to 3600 seconds and must be at
least 600 seconds. Enabling projection requires a nonempty audience. Merely
configuring profiles does not enable projection; without a token file, workload
identity calls fail closed.

Profiles contain no credentials. OAuth client secrets and refresh tokens continue
to use allow-listed workspace secretRefs resolved through OpenBao; do not put
them, access tokens or service-account assertions into chart values. This feature
creates no Secret and does not change External Secrets delivery.

Tokens are cached only within each executor replica. Revocation is detected at
refresh or provider rejection; the worst-case lag is the provider's token TTL.
Refresh-token rotation and OpenBao writeback are unsupported. To disable workload
identity, clear profiles and disable projection, then use the normal release
process. Brokered connection rows fail closed with older executors; additive
source schema changes need no reversal.

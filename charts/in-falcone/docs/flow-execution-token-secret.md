# Flow execution-token signing secret (#976)

`global.flowExecutionToken` accepts only references: `secretName` defaults to
`in-falcone-flow-execution-token` and `remoteKey` to `flows/execution-token-secret`.
Provision a random secret of at least 32 UTF-8 bytes in that OpenBao KV-v2 record's
`secret` property through the approved secret-management process. Helm never
generates, seeds, reads, or embeds the signing value.

The canonical `flows-execution-token` ExternalSecret uses `openbao-backend` to
deliver `FLOW_EXECUTION_TOKEN_SECRET` to one shared Secret. Only the executor and
workflow worker receive that key through `secretKeyRef`. A dedicated read-only
OpenBao policy grants ESO access to the exact record; platform-role does not gain
access. Install bootstrap publishes the policy; upgrades publish it through the
existing bootstrap identity after metadata-only auth reconciliation. Existing
auth, backup, parity, migration and controller-ownership gates remain mandatory.

Both managed and administrator-owned ESO create the ExternalSecret in
post-install/post-upgrade hooks at weight 5, after OpenBao policy publication and
eso-role attachment (#70, following #62). A missing policy, not only a missing
record, previously blocked Argo CD Sync with a 403 in administrator-owned mode,
preventing the PostSync policy hooks from running. In both modes the
`flows-execution-token-ready` post hook at weight 10 waits for the ExternalSecret
to report Ready. It can read only that ExternalSecret's status, never Kubernetes
Secret values; an unready record fails the hook. This status check proves ESO
synchronization, not secret strength or application reload.

Startup env references are optional so Helm `--wait` can finish starting workloads
before managed ESO's post hooks. The paired production source code fails closed:
missing, empty or short secrets reject flow starts with 503 and worker validation
with non-retryable failure. A pod that started before synchronization does not
automatically reload env variables. Initial synchronization and key rotation
therefore require rolling both workloads through the deterministic Helm adapter.
Existing releases missing the new values object render the same reference defaults
under `helm upgrade --reuse-values`.

Before promoting the paired images, provision the OpenBao record, establish
ExternalSecret Ready, then reload both workloads with the same secret. The release
gate must verify variable presence on every replica without displaying values,
and prove that a token signed with the committed dev constant is rejected. Real
OpenBao/ESO synchronization, replica reload, and token rejection are release
evidence; offline chart tests do not prove them. R3 human approval and independent
dual-provider review remain required.

Drain pre-change dev-key runs (up to 24 hours) or accept their non-retryable
`EXECUTION_TOKEN_INVALID` failures. Existing tokenless cron schedules use the
paired worker's per-firing mint activity; executor/worker version skew must not
leave cron runs on a worker lacking that activity. Keep the secret during rollback;
never unset it in production or restore the public signing constant. Image
promotion and digest pinning belong to the platform release process.

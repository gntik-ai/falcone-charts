# In Falcone chart 0.4.3

Release date: pending publication. Source baseline: `e05f9e8cea4c4cc80573bc7ef0693fb42d47cd07`.
The final merged source commit and OCI package digest must be added to release
evidence by the publisher; they are intentionally not guessed here.

This patch preserves externally managed ESO ownership and adds exact controller
ServiceAccount preflight/TokenRequest RBAC. OpenBao full bootstrap is now
fresh-install-only; routine upgrades reconcile Kubernetes auth/`eso-role`
metadata, clear static reviewer-JWT mode in favor of the OpenBao Pod's rotating
token/CA, and run a no-KV canary. Routine reconciliation does not load platform
credentials or mutate KV/policy documents.

FerretDB's DocumentDB gate runs as UID 999 on Kubernetes and uses a zero-unavailable,
one-surge rollout with retained ReplicaSet history. OpenShift restricted mode
continues to use SCC-assigned UIDs. Staging pins six approved first-party digests
and selects local-path/fsn1 for the previously empty pgvector claim; no production,
HA, base, or OpenShift storage default changes.

Revision-20 operators must use the dry-run-first two-phase tooling and runbook.
Phase A is non-destructive. Phase B deletes exactly one still-Pending/unbound/empty
PVC only after exact UID/state recheck and immediate human confirmation. After
Phase B the rollback path is forward recovery; a blind revision-20 rollback is
unsafe. See `docs/staging-infrastructure-repair.md` and
`docs/staging-storage-and-dr.md`.

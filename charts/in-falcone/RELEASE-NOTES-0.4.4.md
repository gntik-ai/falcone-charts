# In Falcone chart 0.4.4

Release date: pending publication. Source baseline: Falcone main commit
`61540248889ace6774203d77688adcca5495b1c3`, tag `0.6.6-main-61540248`.

Chart 0.4.3 contains the staging infrastructure repair baseline: OpenBao
identity separation, ESO ownership safeguards, FerretDB rollout hardening,
staging storage policy, and resumable revision-20 recovery tooling. Chart
0.4.4 contains that same repair plus one isolated image change: it repins the
six first-party Falcone workloads to the verified manifests from Falcone main
listed in `values/staging.yaml`.

This release has no API, storage, migration-schema, authorization, or runtime
contract change. The source revision remains 20 and the migration source chart
remains 0.4.1; only the active repair target advances from chart 0.4.3 to
chart 0.4.4. The existing 0.4.3 release notes remain the historical record of
the base repair.

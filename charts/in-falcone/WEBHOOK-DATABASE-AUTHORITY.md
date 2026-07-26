# Webhook PostgreSQL authority lifecycle

This guide is the chart-side C-25 runbook for P18 installers/release engineers,
P3 operators/SREs, P4/P10 security and read-only reviewers, and P17
documentation-only installers. It covers the bounded PostgreSQL principals that
the Falcone `0.3.1` control plane requires. It does not expose or rotate the
webhook signing master key.

## Supported contract

PostgreSQL 16 or newer is required. The global control-plane `DB_URL`/`PG*`
identity remains unchanged and continues to own tenant/workspace, saga,
governance, recovery, and workspace-database duties. C-25 adds four distinct
webhook-only `LOGIN` principals:

| Principal value | Purpose | Fixed authority |
|---|---|---|
| `global.webhookDatabase.principals.schema` | Enumerated webhook DDL and ownership | none |
| `global.webhookDatabase.principals.runtime` | Ordinary tenant-scoped webhook reads/non-secret work | `falcone_app` |
| `global.webhookDatabase.principals.writer` | Encrypted signing-secret writes | `falcone_webhook_key_writer` |
| `global.webhookDatabase.principals.lifecycle` | Platform key lifecycle maintenance | `falcone_webhook_key_lifecycle` |

The three fixed authorities are `NOLOGIN`. The bounded principals are
`LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`.
The durable administrator in
`global.webhookDatabase.administrator.role` is also the declared membership
grantor. The exact PostgreSQL 16 edges are:

```text
falcone_app -> runtime:                  ADMIN FALSE, INHERIT TRUE,  SET FALSE
falcone_webhook_key_writer -> writer:   ADMIN FALSE, INHERIT FALSE, SET TRUE
falcone_webhook_key_lifecycle -> lifecycle:
                                           ADMIN FALSE, INHERIT FALSE, SET TRUE
```

No other protected membership is accepted. A membership attributable to an
old implicit administrator/global-role binding may be removed; foreign or
ambiguous grantor state, option drift, role privilege drift, and ownership
drift fail closed.

The reusable authority script defaults to `verify`: it performs the complete
catalog/ownership plan inside a transaction and rolls every simulated change
back. The ordered Helm authority Job is the only chart caller that explicitly
sets `WEBHOOK_DATABASE_BOOTSTRAP_MODE=apply`, after the backup/parity gate.
At role level, only the runtime LOGIN has `INHERIT`; the schema, writer,
lifecycle, and three fixed authorities are `NOINHERIT`.

Before the applying or rollback-only transaction executes its first
`CREATE`, `GRANT`, `REVOKE`, `ALTER`, or ownership statement, the bootstrap
queries which of the four bounded role names already exist. It opens a separate
password-authenticated client connection for every existing role using the
retained credential and requires
`session_user = current_user = <declared-role>`. A mismatch fails with
`WEBHOOK_DATABASE_BOUNDED_CREDENTIAL_INVALID` before any authority state
changes. The bootstrap never changes the password of an existing LOGIN or
silently takes it over. A missing role may still be created transactionally
with its retained generated credential. All four credentials are probed again
after commit.

The retained Secret named by
`global.webhookDatabase.credentials.secretName` has exactly these keys:

```text
WEBHOOK_SCHEMA_DATABASE_PASSWORD
WEBHOOK_RUNTIME_DATABASE_PASSWORD
WEBHOOK_KEY_WRITE_DATABASE_PASSWORD
WEBHOOK_KEY_LIFECYCLE_DATABASE_PASSWORD
WEBHOOK_SCHEMA_DATABASE_URL
WEBHOOK_RUNTIME_DATABASE_URL
WEBHOOK_KEY_WRITE_DATABASE_URL
WEBHOOK_KEY_LIFECYCLE_DATABASE_URL
```

Managed mode (`credentials.create: true`) generates four distinct 256-bit
passwords in the in-cluster credential hook on a fresh install or an explicit
backup-gated first legacy handoff. The hook looks up and validates the Secret
before creation. It also creates an immutable, retained, non-secret ConfigMap
named `<credential-secret>-initialized`. That marker permits initialization
once: if the Secret is later missing while the marker remains, even replaying
old first-handoff values fails closed. Neither object is updated or patched.
Both carry `helm.sh/resource-policy: keep`, so uninstall and upgrade retain
them.

The credential hook's ServiceAccount, Role, RoleBinding, support ConfigMap, and
Job use `before-hook-creation,hook-succeeded`. They exist long enough for the
credential Job and are removed after the whole hook succeeds, including on a
fresh initialization that briefly needs collection-wide create. Helm 4.1.4
schedules the successful support hooks at weight `-44` before the credential
Job at weight `-43`. If that later Job fails, Helm applies `hook-succeeded`
cleanup to the preceding successful hooks, so the ServiceAccount, Role,
RoleBinding, and ConfigMap are removed. The failed Job is not successful and
there is no `hook-failed` policy, so the failed Job and its owned Pod remain as
bounded P3 evidence. On retry, `before-hook-creation` removes any same-name
remnants and Helm recreates every support hook before recreating the Job. An
ordinary upgrade renders only exact-name reads and no collection-wide Secret
or ConfigMap create.

The credential container keeps its root filesystem read-only and runs
non-root with all capabilities dropped. Its only writable filesystem is a
`sizeLimit: 1Mi` `emptyDir` mounted at `/tmp`; the script creates its eight
mode-`0400` credential files there and removes the scratch directory on every
exit. The chart test gate executes that real script under the same read-only
root and bounded writable-`/tmp` posture for both fresh managed creation and
the one-time first handoff. The fake Kubernetes boundary records operation
names only and never emits generated credentials.

External mode (`credentials.create: false`) is read-only. Provision an
immutable Secret with exactly the eight keys before Helm starts. Passwords must
be 32–128 URL-safe characters, all four must differ, and each DSN must be the
exact `postgresql://ROLE:PASSWORD@HOST:PORT/DATABASE` value for the declared
non-secret connection/principal settings. Use a secret manager or protected
files; do not use `--set`, `--from-literal`, a committed values file, a rendered
manifest, a shell argument, or an evidence artifact.

For a file-based break-glass provisioning path, prepare eight mode-`0400`
files outside Git and use `kubectl create secret generic --from-file=...` with
the key names above. Delete the source files through the operator’s approved
secure-erasure process after the Secret manager has taken custody. Do not
capture the command’s generated YAML.

## Fresh installation

1. Confirm the chart and control-plane image compatibility annotation in
   `Chart.yaml`, PostgreSQL server major version, target namespace, image
   registry, and CA Secret identity.
2. Run schema/lint and a local render without redirecting Secret objects into
   an evidence bundle:

   ```bash
   helm lint charts/in-falcone
   helm template falcone charts/in-falcone --namespace falcone >/dev/null
   ```

   A fresh install is the only applying path that does not require a
   pre-existing database backup; it has no prior database state to preserve.

3. For hardened transport, layer the production values. The chart requires
   exactly one `PGSSLMODE=verify-full`, one `PGSSLROOTCERT` below the read-only
   `caMountPath`, a non-empty CA Secret name, and the control-plane TLS client
   opt-in.
4. Install through the normal release path. The ordered phases are:

   ```text
   -45 webhook signing-key credential
   -43 bounded PostgreSQL credential
   regular PostgreSQL StatefulSet
   regular webhook database authority bootstrap Job
   control-plane bounded-schema init gate
   application schema verifier and listen
   ```

   The fresh authority Job waits for PostgreSQL. The control-plane init gate
   authenticates only as the bounded schema principal and cannot complete
   before the exact role graph exists. The application therefore cannot run DDL
   or serve early, including under `helm install --wait`.

Expected secret-safe Job output is
`WEBHOOK_DATABASE_CREDENTIAL_CREATED` (or
`WEBHOOK_DATABASE_CREDENTIAL_REUSED`) followed by
`WEBHOOK_DATABASE_BOOTSTRAP_READY`. The init gate reports
`WEBHOOK_DATABASE_PRINCIPAL_GATE_READY`.

An out-of-band execution of the same script without an explicit mode is
rollback-only and reports `WEBHOOK_DATABASE_BOOTSTRAP_VERIFIED`; it cannot
provision a fresh installation.

The exact source/CI gate is:

```bash
sh tests/webhook-database-chart-ci.test.sh
```

It runs shell and Node syntax, JSON-schema parsing, all three C-25 Node suites,
the disposable PostgreSQL 16.14 suite plus PostgreSQL 15 rejection, four
`helm lint --strict` profiles, and 12 strict kubeconform renders: fresh,
ordinary backup-gated upgrade, and backup-gated first handoff across base,
kind, production, and OpenShift profiles. It removes its temporary rendered
manifests, and the runtime/PostgreSQL suites remove every task container and
network plus any test image they had to pull.

## Every upgrade, including first handoff and no-op replay

Before changing the release:

1. Quiesce or schedule the approved maintenance window.
2. Take a database backup and test restore into a disposable PostgreSQL 16
   environment.
3. Record only a non-secret backup evidence identifier.
4. Verify custody of the unchanged global database Secret, the bounded
   credential Secret, the current/recovery webhook key Secrets, and the
   transport CA. Do not read their data into evidence.
5. Verify parity (row/object inventory and application health) and declare the
   non-secret gates. The following first C-25 handoff additionally selects
   `firstHandoff=true`:

   ```bash
   helm upgrade falcone charts/in-falcone \
     --namespace falcone \
     --set deployment.upgrade.currentVersion=0.3.0 \
     --set global.webhookDatabase.migration.firstHandoff=true \
     --set global.webhookDatabase.migration.backupVerified=true \
     --set global.webhookDatabase.migration.parityVerified=true \
     --set global.webhookDatabase.migration.backupReference=BACKUP-EVIDENCE-ID
   ```

The pre-upgrade order is bounded credential validation (`-43`), administrator
authority bootstrap (`-40`), and optional signing-key lifecycle (`-35`). Missing
backup/parity declarations block every upgrade before a manifest is applied.
This includes first handoff, explicit adopt/rotate/recover/finalize operations,
and an ordinary action-none `0.3.1` replay: the authority Job always selects
`WEBHOOK_DATABASE_BOOTSTRAP_MODE=apply`, even when the exact database graph is
expected to make the transaction a no-op.
After the first successful handoff, set `firstHandoff=false`; retained-marker
validation still prevents regeneration if old initialization values are
accidentally replayed.

For every later applying upgrade, retain the same proof gate with a truthful
current version and a current backup evidence identifier:

```bash
helm upgrade falcone charts/in-falcone \
  --namespace falcone \
  --set deployment.upgrade.currentVersion=0.3.1 \
  --set global.webhookDatabase.migration.backupVerified=true \
  --set global.webhookDatabase.migration.parityVerified=true \
  --set global.webhookDatabase.migration.backupReference=BACKUP-EVIDENCE-ID
```

Expected result is a successful credential reuse, pre-mutation authentication
of all four existing bounded roles, an idempotent authority transaction, and
post-commit credential probes. Omitting any proof value returns the bounded
Helm validation error and emits no partial manifest.

The administrator bootstrap transfers ownership only when an existing object
is owned by the proven global/legacy role. It accepts replay when already owned
by the schema principal and rejects any third owner. The allowlist is:

- tables: `webhook_subscriptions`, `webhook_signing_secrets`,
  `webhook_deliveries`, `webhook_delivery_attempts`,
  `webhook_master_key_state`, `webhook_master_key_rotations`;
- zero-argument functions: `falcone_webhook_key_write_current_id`,
  `falcone_webhook_signing_secret_write_statement_fence`,
  `falcone_webhook_signing_secret_write_fence`.

No `REASSIGN OWNED`, database ownership change, broad default privilege, or
`GRANT ALL` is used. There are no sequence entries: the source migrations use
UUID, text, and smallint keys, so even a legacy sequence carrying an old
`*_id_seq` assumption remains legacy-owned and is never transferred.

After the bounded transfer, PostgreSQL's ownership-dependency catalog is
checked comprehensively. The schema LOGIN may own only the six tables and three
functions above, plus PostgreSQL-generated row/array types, indexes, and TOAST
relations whose ownership is inseparable from those tables. An independently
owned sequence, enum, domain, range/multirange/base/composite type, relation,
view, statistics/collation/text-search object, schema, database, or any other
owner-bearing user object fails with
`WEBHOOK_DATABASE_SCHEMA_OWNER_SCOPE_DRIFT`. Failure rolls back the entire
transaction; it never broadens the allowlist or transfers the drifting object.

## Secret-safe verification

P4/P10 reviewers can verify references and metadata without Secret-data access:

```bash
kubectl -n falcone get deployment falcone-control-plane \
  -o jsonpath='{range .spec.template.spec.containers[0].env[*]}{.name}{"\n"}{end}'

kubectl -n falcone get secret in-falcone-webhook-database-credentials \
  -o go-template='immutable={{.immutable}}{{"\n"}}policy={{index .metadata.annotations "helm.sh/resource-policy"}}{{"\n"}}{{range $k,$v := .data}}{{$k}}{{"\n"}}{{end}}'

kubectl -n falcone get configmap \
  in-falcone-webhook-database-credentials-initialized \
  -o go-template='immutable={{.immutable}}{{"\n"}}state={{index .data "state"}}{{"\n"}}policy={{index .metadata.annotations "helm.sh/resource-policy"}}{{"\n"}}'
```

Expected posture is four bounded DSN environment names, five role-name
environment names, `immutable=true`, `policy=keep`, and exactly the eight key
names above. The ConfigMap reports only `state=initialized`; it contains no
credential hash, digest, DSN, password, or key identity. Do not request Secret
`.data` values or use broad `describe`, environment dumps, shell tracing,
rendered Secret manifests, or Job argument inspection that serializes process
environments.

After a successful credential hook, its temporary ServiceAccount, Role,
RoleBinding, support ConfigMap, and Job should be absent. If the credential Job
failed under Helm 4.1.4, the successful ServiceAccount, Role, RoleBinding, and
support ConfigMap hooks have already been removed by `hook-succeeded`; only the
failed Job and its owned Pod remain for bounded event/status inspection. A
retry uses `before-hook-creation` to remove any same-name remnants, recreates
the support resources, and then recreates the Job. Any support RBAC that
remains after a completed success or failure is drift; never preserve the
RoleBinding as standing namespace authority.

Only the authority bootstrap references
`POSTGRESQL_POSTGRES_PASSWORD`. The control-plane main container keeps its
existing global `PG*` entries and separately receives all four bounded DSNs by
`secretKeyRef`. The lifecycle Job receives only the schema/lifecycle DSNs and
five names. The credential Job receives no PostgreSQL credential. Hardened
database users receive `verify-full` plus the same read-only CA mount; no
unrelated MongoDB/Kafka/Node CA environment is added to the bootstrap or
lifecycle Job.

## Failure handling

Stable failure families are:

- `WEBHOOK_DATABASE_CREDENTIAL_INVALID`: Secret missing, malformed, not exact,
  wrong custody metadata, or missing during ordinary upgrade;
- `WEBHOOK_DATABASE_BOOTSTRAP_INPUT_INVALID`: the bootstrap mode or a required
  non-secret input is absent or malformed, or the declared principals or
  retained credentials are not pairwise distinct. This fails before the
  authority transaction; correct the chart values and Secret references, then
  retry without dumping environment or Secret data;
- `WEBHOOK_DATABASE_UNAVAILABLE`: the declared PostgreSQL endpoint did not
  become ready within the bounded wait, before the authority transaction
  started. Verify the non-secret service/DNS/network/TLS posture and database
  readiness, restore connectivity, and retry the same release operation;
- `WEBHOOK_POSTGRESQL_16_REQUIRED`: server is older than PostgreSQL 16;
- `WEBHOOK_DATABASE_ADMIN_INVALID`: the authenticated bootstrap session is not
  the exact declared login-capable superuser/grantor. No authority transaction
  commits; restore the bundled administrator credential and declared grantor
  identity, and never grant administrator capability to a bounded application
  principal;
- `WEBHOOK_DATABASE_ROLE_OPTION_DRIFT`: a protected role has unsafe flags;
- `WEBHOOK_DATABASE_SCHEMA_PRIVILEGE_GRANTOR_DRIFT`: the bounded schema
  privilege has foreign provenance;
- `WEBHOOK_DATABASE_SCHEMA_PRIVILEGE_DRIFT`: the exact owner-issued `USAGE`
  and `CREATE` privilege pair on schema `public` for the bounded schema LOGIN
  could not be established. The transaction rolls back; reconcile only the
  named schema privilege and its owner provenance, or restore the tested
  database-and-Secret pair, then rerun the bootstrap;
- `WEBHOOK_DATABASE_MEMBERSHIP_DRIFT` or
  `WEBHOOK_DATABASE_MEMBERSHIP_AMBIGUOUS`: edge, option, or grantor mismatch;
- `WEBHOOK_DATABASE_OBJECT_OWNER_DRIFT`: an enumerated object has a third-party
  owner;
- `WEBHOOK_DATABASE_SCHEMA_OWNER_SCOPE_DRIFT`: the bounded schema LOGIN owns a
  non-enumerated owner-bearing object, including a database, schema, relation,
  sequence, view, function, enum/domain/range/composite type, or statistics
  object;
- `WEBHOOK_DATABASE_BOUNDED_CREDENTIAL_INVALID`: a bounded login/password does
  not authenticate as itself. For a pre-existing role this is a pre-mutation
  failure; correct custody deliberately rather than changing the role password
  through the bootstrap;
- `WEBHOOK_DATABASE_BOOTSTRAP_FAILED`: bounded secret-safe fallback;
- `WEBHOOK_DATABASE_PRINCIPAL_GATE_FAILED`: the graph did not become ready.

The scripts suppress SQL, parameters, raw exceptions, Secret objects, and
environment values. The authority bootstrap captures PostgreSQL stderr only in
its bounded `/tmp` scratch file, emits an exact allowlisted code when its own
catalog checks raise one, maps every unrecognized client/server failure to
`WEBHOOK_DATABASE_BOOTSTRAP_FAILED`, and removes the scratch file before exit.
Diagnose through role/owner names and stable codes only.
Correct drift deliberately, or restore the tested database-and-Secret pair.
Never “repair” a foreign grantor or owner by widening the bootstrap.

## Rollback and recovery

Helm rollback alone cannot reverse role ownership, membership provenance,
application migration 004, or a committed key transition. It must not collapse
the four bounded DSNs into the global DSN.

Before a database/key transition commits, keep the previous Deployment and all
retained credentials. After a committed transition, use the fixed chart’s
forward webhook-key `recover` operation. To reverse the authority/object
handoff, restore the tested pre-change database together with its matching
global/bounded/key Secrets and chart/image version in a disposable validation
environment, verify parity, then perform the operator-approved environment
restore. There is intentionally no broad reverse-ownership script.

Uninstall retains managed bounded credentials and their non-secret
initialization marker. Delete both only through a separately authorized custody
procedure after all database backups, current deployments, and recovery paths
no longer reference them. Deleting only the Secret intentionally leaves the
marker and blocks regeneration.

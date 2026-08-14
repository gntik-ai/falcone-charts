# Keycloak 26 realm bootstrap and recovery

This guide is for platform installers and operators validating the Falcone
platform realm on Keycloak 26. The chart owns the provider representation and
bootstrap workflow; it does not own or print credential values.

## Representation contract

Configure the five supported switches through the nested chart values API:

```yaml
bootstrap:
  oneShot:
    keycloak:
      realm:
        login:
          loginWithEmailAllowed: true
          registrationAllowed: true
          rememberMe: true
          verifyEmail: true
          resetPasswordAllowed: true
```

The rendered `realm.json` and `login.json` use Keycloak 26's top-level
`RealmRepresentation` fields. They never contain a `login` wrapper. Do not add
the five fields directly under `realm`; nested/top-level duplicates are rejected
before Helm emits a manifest.

Inspect the Secret-free payload before installing:

```bash
helm template falcone charts/in-falcone \
  --namespace falcone-system \
  --show-only templates/bootstrap-payload-configmap.yaml \
  > /tmp/falcone-keycloak-bootstrap.yaml
```

Verify that `data.realm.json` and `data.login.json` contain the five booleans at
their top level and that neither contains a `login` property. Treat a nested
wrapper, missing boolean, unknown login setting, or ambiguous authoring path as
a release blocker.

## Fresh install and upgrade behavior

The bootstrap Job is a `post-install,post-upgrade` hook. It waits for the
Keycloak master realm, acquires a namespace-scoped ConfigMap lock, obtains its
admin credential from Secret references, and then:

1. creates the platform realm only when its GET returns 404;
2. reconciles user-profile and brute-force controls during create-only work;
3. PUTs the bounded `login.json` representation on every run;
4. GETs the realm and compares all five persisted booleans;
5. reconciles the remaining upgrade-safe resources;
6. verifies the realm, clients, and superadmin; and
7. writes the success marker only after every check passes.

When the realm GET returns 200, the create POST is skipped. The login PUT is
still executed, so a routine upgrade converges configuration without deleting
the realm, users, roles, clients, sessions, or PostgreSQL state.

## Failure and fail-forward recovery

The historical symptom is a failed bootstrap hook with HTTP 400 while creating
the realm. Keycloak itself may be Ready because the master realm is available;
that is not proof that Falcone authentication was provisioned.

Check only bounded metadata and status:

```bash
NAMESPACE="<namespace>"
RELEASE="<helm-release>"

kubectl -n "$NAMESPACE" get job "${RELEASE}-in-falcone-bootstrap"
kubectl -n "$NAMESPACE" get configmap in-falcone-bootstrap-state --ignore-not-found
kubectl -n "$NAMESPACE" logs job/"${RELEASE}-in-falcone-bootstrap" \
  --all-containers=false | grep -E 'Keycloak realm|login settings|verified auth layer|status='
```

Do not capture environment variables, Authorization headers, Secret manifests,
decoded Secret data, response bodies, or access tokens as evidence.

If a fresh install failed before the marker was written, correct the chart or
values and retry the install/upgrade forward. The lock exit trap releases the
failed attempt, the absent marker causes create-only work to run again, and the
fixed-name credentials plus PostgreSQL data remain in place. Do not delete the
realm/database, rotate credentials, or use an automatic destructive rollback to
compensate for a representation error.

For an existing usable realm, rollback is acceptable only when the selected
package is already known to preserve that realm and its database. A rolled-back
package that still emits the nested Keycloak 26 representation is not a safe
fresh-install target. Prefer the corrected forward package and verify the same
postconditions.

## Acceptance and cleanup

Run the deterministic contract and chart checks:

```bash
node --test --test-concurrency=1 \
  tests/blackbox/keycloak-realm/keycloak26-login-import-contract.test.mjs
helm lint --strict charts/in-falcone
openspec validate fix-keycloak-26-realm-login-import --strict
```

In a disposable Keycloak 26 environment, verify all of the following without
recording credentials:

- the exact rendered `realm.json` POST returns 201;
- the realm GET returns 200 and all five values equal the desired booleans;
- a repeated bounded login PUT succeeds and the read-back still matches;
- bootstrap-principal authentication succeeds;
- the bootstrap Job completes and the success marker exists only afterward;
- no realm/client/user deletion request is emitted; and
- the disposable namespace, workload, credentials, and storage are removed.

On shared environments, also verify the expected clients, role claims, enabled
superadmin journey, and tenant/workspace isolation before declaring recovery
complete.

# Kind quickstart public hostnames

Run from the repository root with Docker, kind v0.27.0, kubectl, Helm and Python 3 installed. Ports 80 and 443 must be free. Choose a new cluster name; the commands below create `falcone-quickstart`. This setup uses HTTP on loopback, with no TLS on kind.

```sh
kind create cluster --name falcone-quickstart --config deploy/kind/quickstart/cluster.yaml
bash deploy/kind/quickstart/ingress-nginx.sh kind-falcone-quickstart
bash deploy/kind/quickstart/coredns-nip-io.sh kind-falcone-quickstart
helm upgrade --install falcone charts/in-falcone \
  --kube-context kind-falcone-quickstart \
  --namespace in-falcone-dev --create-namespace \
  -f charts/in-falcone/values/dev.yaml \
  -f charts/in-falcone/values/platform-kubernetes.yaml \
  -f charts/in-falcone/values/profiles/all-in-one.yaml \
  -f charts/in-falcone/values/kind-quickstart.yaml
```

The normal platform prerequisites, External Secrets/OpenBao provisioning and Helm migration/readiness gates still apply. Supply the normal local credential references through those mechanisms. This profile does not provision or bypass them.

The resulting hosts are `api.127.0.0.1.nip.io`, `console.127.0.0.1.nip.io`, `iam.127.0.0.1.nip.io` and `realtime.127.0.0.1.nip.io`. The API host exposes `/control-plane` and `/v1`; the realtime host exposes `/realtime` and `/v1/realtime`. Existing identity and console paths remain available.

Keycloak issues tokens with `http://iam.127.0.0.1.nip.io/realms/<realm>`, including authentication through the internal backchannel. Gateway and executor key bases and the control plane's `KEYCLOAK_BASE_URL`/`KEYCLOAK_JWKS_URL` remain internal. CoreDNS rewrites the public nip.io names to the ingress controller Service for pod-side access, with [answer rewriting](https://coredns.io/plugins/rewrite/) back to the requested name. The DNS script can be run repeatedly; it replaces its one marked rewrite block and restarts CoreDNS. Both setup scripts reject contexts outside `kind-*` and accept an explicit context argument.

Ingress uses the upstream [controller-v1.14.3 kind manifest](https://github.com/kubernetes/ingress-nginx/blob/controller-v1.14.3/deploy/static/provider/kind/deploy.yaml). The live proof runs only that infrastructure, the rendered public Ingress, and three BusyBox stand-ins. It creates a unique cluster with a private kubeconfig and deletes the cluster in `finally`:

```sh
KIND_QUICKSTART_EVIDENCE=/tmp/kind-quickstart-surface-evidence.json \
  python3 tests/blackbox/kind-quickstart/kind-quickstart-surface.py
```

It checks runner-side routing and forwarded headers, pod-side nip.io DNS, repeatable DNS setup, and ingress 404 without the profile. The chart-release job uploads its JSON evidence even when a check fails.

## Manual full-platform check for issue #81

This check requires a fully provisioned local platform. The stand-in CI test cannot establish login, JWT verification, database access or streaming behavior. Record one completed run on [issue #81](https://github.com/gntik-ai/falcone-charts/issues/81), including the chart commit, Keycloak version, kind version, date, route paths and HTTP statuses. Keep passwords, bearer tokens, cookies and Secret values out of the record.

1. Start with a quickstart release installed using the first three value files. Record the pod names, UIDs and issuer checksum annotations for `falcone-control-plane`, `falcone-control-plane-executor` and `falcone-apisix` using `kubectl --context kind-falcone-quickstart -n in-falcone-dev get pods -o wide` and the corresponding Deployment pod templates. Do not query Secrets.
2. Upgrade that release by running the four-file Helm command above with `--reuse-values`. Wait for all three Deployments using `kubectl --context kind-falcone-quickstart -n in-falcone-dev rollout status deployment/<name> --timeout=300s`. Confirm their issuer checksums changed, their pod UIDs changed, and each replacement is Ready.
3. Obtain a platform-realm token and a tenant-realm token through the normal OIDC flow at `http://iam.127.0.0.1.nip.io`. Inspect their issuer locally without recording the tokens. Expect `http://iam.127.0.0.1.nip.io/realms/in-falcone-platform` and `http://iam.127.0.0.1.nip.io/realms/<tenant-realm>` respectively.
4. With an authorized platform token, call a control-plane endpoint under `http://api.127.0.0.1.nip.io/v1/platform/` and record HTTP 200. With an authorized tenant token and provisioned workspace, call an executor endpoint under `http://api.127.0.0.1.nip.io/v1/postgres/` and record HTTP 200. Use real endpoint suffixes and IDs for the provisioned test data and record those paths. Keep authorization material local. This verifies tenant-key fetching from a pod through the DNS rewrite.
5. Open `http://console.127.0.0.1.nip.io/`, log in, refresh the session/page, and complete an authenticated request. Confirm that console login through the control plane's internal Keycloak base succeeds and the returned token still has the public nip.io issuer. This explicitly checks Keycloak 26.1.0's dynamic backchannel behavior.
6. Open an authenticated stream at `http://realtime.127.0.0.1.nip.io/v1/realtime/workspaces/<workspace>/data/<database>/schemas/<schema>/tables/<table>/changes` (or the collection changes endpoint), trigger a change, and confirm an event arrives. Record the endpoint, HTTP 200 and event receipt without its payload.
7. Repeat the authenticated requests after the upgrade and attach the redacted results to issue #81. Record the observed pod replacements from step 2. This manual check has **not** been performed by the repository implementation.

## Upgrade and rollback

With the kind-quickstart profile's non-empty `controlPlane.keycloakIssuer`, issuer checksum annotations cause one rolling restart of executor, control-plane and APISIX when the profile is added to an existing release. Subsequent identical issuer configuration keeps the same checksums; changed issuer configuration rolls only the affected consumers. Other installations are unchanged and receive no issuer checksum annotations.

To remove the profile, upgrade with the original three files and `--reset-values` (plus any normal local overrides). Simply omitting a file with `--reuse-values` retains its stored values. The empty `controlPlane.keycloakIssuer` default restores the prior control-plane environment and removes the issuer checksum annotations, causing one rollout back to the original pod templates. Reverting the chart change also removes these annotations from releases using the profile; other installations are unchanged. Delete only the disposable cluster you created when finished:

```sh
kind delete cluster --name falcone-quickstart
```

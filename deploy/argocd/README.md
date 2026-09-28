# Argo CD: falcone staging

`falcone-staging.yaml` puts the existing `falcone` Helm release in `in-falcone-staging`
under Argo CD, with argocd-image-updater managing the six first-party image tags
(falcone-charts#47, gntik-ai/falcone#1027). Hermes full-delivery triggers each sync after
its environment health gate. Automated sync, prune and self-heal are off.

## Render
The Application renders `charts/in-falcone` with, in order:

1. `values/staging.yaml`: the staging profile. Its digest pins are kept for the
   revision-20..24 repair contracts.
2. `values/staging-cluster.yaml`: live-release settings (storage, webhook-key adoption),
   `global.gitops.upgradeSemantics: true`, and the Option-B waiver below.
3. `values/staging-argocd.yaml`: `sha-<commit>` image tags, written by argocd-image-updater.

Argo CD renders Helm charts in install mode. `global.gitops.upgradeSemantics: true` makes
the chart render the existing release exactly like `helm upgrade`: upgrade-only gates, and
`pre-upgrade` hooks, which Argo CD runs as PreSync. The chart uses only Helm hook
annotations, never `argocd.argoproj.io/hook`, because mixing the two makes Argo CD ignore the
Helm hook mappings. The intended GitOps-only differences:

- The Temporal bootstrap Job keeps its constant name (Argo CD renders revision 1) and gets
  `argocd.argoproj.io/sync-options: Replace=true,Force=true`. When its rendered spec changes,
  Argo CD re-creates it, so it re-runs, because Job specs are immutable. It stays a normal
  Sync-phase resource, as under Helm. A PostSync hook could deadlock: workflow-worker needs
  the Temporal namespace this Job reconciles before the sync can become healthy.
- The Temporal Jobs have no `ttlSecondsAfterFinished`, so Kubernetes cannot delete them
  before Argo CD records them. Hook deletion policies and the hashed name handle cleanup.

Check it offline; this prints `OK`:

```sh
V="-f charts/in-falcone/values/staging.yaml -f charts/in-falcone/values/staging-cluster.yaml -f charts/in-falcone/values/staging-argocd.yaml"
helm template falcone charts/in-falcone -n in-falcone-staging $V > /tmp/argo.yaml
helm template falcone charts/in-falcone -n in-falcone-staging --is-upgrade $V \
  --set global.gitops.upgradeSemantics=false > /tmp/helm.yaml
python3 - <<'PY'
import re, yaml
def docs(path):
    out = []
    for d in yaml.safe_load_all(open(path)):
        if not d:
            continue
        name = d["metadata"]["name"]
        if d["kind"] == "Job" and re.search(r"-temporal-(bootstrap|db-bootstrap|schema)$", name):
            d["spec"].pop("ttlSecondsAfterFinished", None)
            (d["metadata"].get("annotations") or {}).pop("argocd.argoproj.io/sync-options", None)
        out.append(yaml.safe_dump(d, sort_keys=True))
    return sorted(out)
assert docs("/tmp/argo.yaml") == docs("/tmp/helm.yaml")
print("OK")
PY
```

## Option-B waiver (`falcone-1027-option-b-20260928`)
Operator decision on gntik-ai/falcone#1027: staging syncs set
`global.webhookDatabase.migration.authorityReplayEnabled: false`, so the applying
webhook-database authority Job does not run, and no backup/parity evidence is claimed. To
lift the waiver, add a pre-sync backup and parity step, then set
`authorityReplayEnabled: true` with a fresh `backupReference` for every sync.

## Resource tracking
The Application is named `falcone-staging`, while the Helm release is `falcone`. The chart
requires `app.kubernetes.io/instance` to equal the release name (the ESO preflight checks it).
This cluster's Argo CD (v3.4.2) uses annotation tracking, the v3 default
(`application.resourceTrackingMethod` is unset in `argocd-cm`). It records ownership in
`argocd.argoproj.io/tracking-id` and leaves that label alone: musematic's resources keep
`app.kubernetes.io/instance: platform` under the Application `musematic-platform`. If the
tracking method is ever switched to `label`, rename the Application to `falcone` first.

## Apply
```sh
kubectl apply -f deploy/argocd/falcone-staging.yaml
```
The first sync rolls the six first-party images to the tags in `staging-argocd.yaml`.
Everything else matches the live release, apart from these differences:
- The first sync creates the Temporal bootstrap Job `falcone-temporal-r1-upgrade-temporal-bootstrap`,
  which runs once, and again whenever its rendered spec changes. The live `…-r39-…` Job is
  left alone.
- The webhook-DB authority hook resources are not rendered (Option B).

## Release revision
Argo CD renders `.Release.Revision` as 1. The chart uses it only for markers: the
control-plane pod annotation `in-falcone.io/release-revision`, the informational
`releaseRevision` in the bootstrap marker ConfigMap, and revision-suffixed Job names.
Nothing reads these back. On staging, the legacy webhook-key adoption hook scales the
control plane to 0 on every sync, and the main apply scales it back, so its pods are
recreated on each sync just as the annotation bump does under `helm upgrade`.

## Not through Argo CD: storage-size changes
Argo CD renders without cluster access, so Helm `lookup` returns nothing. The chart's only
lookup-driven migration is the SeaweedFS volume resize hook (`seaweedfs/templates/volume/
volume-resize-hook.yaml`): it finds the live StatefulSets and PVCs to orphan-delete and
patch them. Under Argo CD that hook would not render, and a larger SeaweedFS size would try
to update immutable `volumeClaimTemplates`. So change SeaweedFS (and other StatefulSet)
storage sizes only through the Helm handoff below, then bring the values back in line.
Hermes' image-tag deliveries never change storage. The other `lookup` in the chart
(`webhook-database-credentials.yaml`) creates nothing under upgrade semantics, whatever
it returns, exactly like `helm upgrade`.

## After a failed sync: leftover PreSync support resources
Helm deletes a `hook-succeeded` pre-upgrade hook as soon as it succeeds. Argo CD may keep
it until the whole sync operation succeeds. The chart's ESO and OpenBao hooks include
cluster-wide RBAC, for example `openbao-client-ca-bootstrap`, which may write Secrets and
Namespaces, and they carry no release label. So after a failed sync, list every Helm hook
resource with a `hook-succeeded` delete policy in the cluster. None should outlive a sync.
Delete them unless a sync is running; the next sync recreates what it needs. Hooks with
only `before-hook-creation` persist by design and are not listed:

```sh
kubectl get clusterrole,clusterrolebinding,role,rolebinding,serviceaccount,configmap,secret,job -A -o json \
  | python3 -c '
import json, sys
for i in json.load(sys.stdin)["items"]:
    m = i["metadata"]
    if "hook-succeeded" in (m.get("annotations") or {}).get("helm.sh/hook-delete-policy", ""):
        print(i["kind"].lower(), m.get("namespace", "-"), m["name"])'
```

## Roll back to plain Helm
1. Record the synced revision (step 2), then stop Argo CD management without touching
   workloads:
   ```sh
   kubectl -n argocd delete imageupdater falcone-staging
   argocd app delete falcone-staging --cascade=false
   # without the argocd CLI: remove the Application's finalizers, then delete it
   ```
2. Hand the live state back to a Helm revision **from the revision Argo CD last synced**, not
   from current `main`: argocd-image-updater may already have committed newer tags. Before
   step 1, record it:
   ```sh
   # The last *successfully applied* revision, not .status.sync.revision (the last compared one).
   kubectl -n argocd get application falcone-staging \
     -o jsonpath='{.status.operationState.phase} {.status.operationState.syncResult.revision}{"\n"}'
   # Use the revision only if the phase is Succeeded; otherwise take the newest entry of
   # .status.history (successful syncs only).
   git -C falcone-charts checkout "<that revision>"
   ```
   Then, from that checkout, hand the live state back to a Helm revision. Use the same three value files with Helm's
   own upgrade semantics, so Helm records the current image tags and the waiver, and its
   main apply restores `controlPlane.replicas` if a lifecycle hook left the control plane
   at 0:
   ```sh
   helm upgrade falcone charts/in-falcone -n in-falcone-staging \
     -f charts/in-falcone/values/staging.yaml \
     -f charts/in-falcone/values/staging-cluster.yaml \
     -f charts/in-falcone/values/staging-argocd.yaml \
     --set global.gitops.upgradeSemantics=false
   ```
   This is the render Argo CD applied (see the equivalence check above). Check that
   `kubectl -n in-falcone-staging get deploy falcone-control-plane` is back at its
   replicas.
3. If a sync failed after the PreSync quiesce and the control plane is still at 0, run
   step 2, or sync the Application again. Both re-apply the Deployment.

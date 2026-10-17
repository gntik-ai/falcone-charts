#!/usr/bin/env bash
set -euo pipefail
context="${1:-$(kubectl config current-context)}"
case "$context" in
  kind-?*) ;;
  *) echo 'ingress-nginx setup requires a kind-* context' >&2; exit 1 ;;
esac
# Upstream kind manifest, including pinned controller and admission images.
manifest='https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.14.3/deploy/static/provider/kind/deploy.yaml'
# The upstream admission Jobs have a zero-second TTL. Retain them so the
# controller rollout cannot race their deletion before we verify completion.
kubectl --context "$context" create --dry-run=client -f "$manifest" -o json |
  python3 -c '
import json, sys
# kubectl prints one JSON document per resource in a multi-object manifest.
decoder = json.JSONDecoder()
remaining = sys.stdin.read().lstrip()
items = []
while remaining:
    obj, end = decoder.raw_decode(remaining)
    items.append(obj)
    remaining = remaining[end:].lstrip()
for obj in items:
    if (obj["kind"] == "Job"
            and obj["metadata"].get("namespace") == "ingress-nginx"
            and obj["metadata"]["name"] in (
                "ingress-nginx-admission-create", "ingress-nginx-admission-patch")):
        obj["spec"].pop("ttlSecondsAfterFinished", None)
json.dump({"apiVersion": "v1", "kind": "List", "items": items}, sys.stdout)
' | kubectl --context "$context" apply -f -
kubectl --context "$context" -n ingress-nginx rollout status deployment/ingress-nginx-controller --timeout=300s
kubectl --context "$context" -n ingress-nginx wait --for=condition=complete job/ingress-nginx-admission-create job/ingress-nginx-admission-patch --timeout=300s

#!/usr/bin/env bash
set -euo pipefail
context="${1:-$(kubectl config current-context)}"
case "$context" in
  kind-?*) ;;
  *) echo 'ingress-nginx setup requires a kind-* context' >&2; exit 1 ;;
esac
# Upstream kind manifest, including pinned controller and admission images.
manifest='https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.14.3/deploy/static/provider/kind/deploy.yaml'
kubectl --context "$context" apply -f "$manifest"
kubectl --context "$context" -n ingress-nginx rollout status deployment/ingress-nginx-controller --timeout=300s
kubectl --context "$context" -n ingress-nginx wait --for=condition=complete job/ingress-nginx-admission-patch --timeout=300s

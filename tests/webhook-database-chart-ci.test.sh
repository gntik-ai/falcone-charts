#!/bin/sh
#
# Canonical local/CI gate for the C-25 chart/database authority contract.
# It renders only non-Secret references and removes every temporary manifest.

set -eu

root_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
chart="$root_dir/charts/in-falcone"
render_dir="$(mktemp -d /tmp/falcone-c25-chart-ci.XXXXXX)"

cleanup() {
  rm -rf "$render_dir"
}
trap cleanup EXIT HUP INT TERM

cd "$root_dir"

for script in \
  charts/in-falcone/files/webhook-database-authority-bootstrap.sh \
  charts/in-falcone/files/webhook-database-credential-bootstrap.sh \
  charts/in-falcone/files/webhook-database-principal-gate.sh \
  tests/webhook-database-bootstrap-postgres16.test.sh \
  tests/webhook-database-chart-ci.test.sh
do
  sh -n "$script"
done

for suite in \
  tests/tls-bootstrap-chart.test.mjs \
  tests/webhook-signing-key-chart.test.mjs \
  tests/webhook-database-credential-script.test.mjs \
  tests/webhook-database-principals-chart.test.mjs \
  tests/webhook-key-lifecycle-hook-order.test.mjs \
  tests/networkpolicy-selector-reality.test.mjs
do
  node --check "$suite"
done

node -e \
  "JSON.parse(require('node:fs').readFileSync('charts/in-falcone/values.schema.json', 'utf8'))"

node tests/tls-bootstrap-chart.test.mjs
node tests/webhook-signing-key-chart.test.mjs
node tests/webhook-database-credential-script.test.mjs
node tests/webhook-database-principals-chart.test.mjs
node tests/webhook-key-lifecycle-hook-order.test.mjs
node tests/networkpolicy-selector-reality.test.mjs
sh tests/webhook-database-bootstrap-postgres16.test.sh

helm lint --strict "$chart"
helm lint --strict "$chart" -f deploy/kind/values-kind.yaml
helm lint --strict "$chart" -f deploy/kind/values-production.yaml
helm lint --strict "$chart" -f deploy/openshift/values-openshift.yaml

validate_render() {
  profile="$1"
  phase="$2"
  shift 2
  manifest="$render_dir/${profile}-${phase}.yaml"

  case "$phase" in
    fresh)
      helm template falcone "$chart" \
        --namespace falcone-test \
        "$@" >"$manifest"
      ;;
    upgrade)
      helm template falcone "$chart" \
        --namespace falcone-test \
        --is-upgrade \
        --set deployment.upgrade.currentVersion=0.3.1 \
        --set global.webhookDatabase.migration.backupVerified=true \
        --set global.webhookDatabase.migration.parityVerified=true \
        --set global.webhookDatabase.migration.backupReference=c25-ci-backup \
        "$@" >"$manifest"
      ;;
    first-handoff)
      helm template falcone "$chart" \
        --namespace falcone-test \
        --is-upgrade \
        --set deployment.upgrade.currentVersion=0.3.0 \
        --set global.webhookDatabase.migration.firstHandoff=true \
        --set global.webhookDatabase.migration.backupVerified=true \
        --set global.webhookDatabase.migration.parityVerified=true \
        --set global.webhookDatabase.migration.backupReference=c25-ci-backup \
        "$@" >"$manifest"
      ;;
    *)
      printf '%s\n' 'C25_CHART_CI_INPUT_INVALID' >&2
      exit 1
      ;;
  esac

  kubeconform \
    -strict \
    -summary \
    -ignore-missing-schemas \
    "$manifest"
}

for phase in fresh upgrade first-handoff; do
  validate_render base "$phase"
  validate_render kind "$phase" -f deploy/kind/values-kind.yaml
  validate_render production "$phase" -f deploy/kind/values-production.yaml
  validate_render openshift "$phase" -f deploy/openshift/values-openshift.yaml
done

printf '%s\n' \
  'C25_CHART_CI_PASS helm_lint_profiles=4 kubeconform_matrices=12'

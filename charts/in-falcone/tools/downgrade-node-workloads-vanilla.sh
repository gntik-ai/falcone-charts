#!/usr/bin/env bash
set -euo pipefail
namespace= release= version= digest=
while (($#)); do
  case "$1" in
    --namespace|--release|--version|--digest) [[ $# -ge 2 ]] || { echo NODE_DOWNGRADE_INPUT >&2; exit 64; }; printf -v "${1#--}" '%s' "$2"; shift 2;;
    *) echo NODE_DOWNGRADE_INPUT >&2; exit 64;;
  esac
done
[[ "$version" == 0.4.18 && -n "$namespace" && -n "$release" && "$digest" =~ ^sha256:[[:xdigit:]]{64}$ ]] || { echo NODE_DOWNGRADE_INPUT >&2; exit 64; }
chart='oci://ghcr.io/gntik-ai/charts/in-falcone'
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
helm pull "$chart" --version "$version" --destination "$tmp" >/dev/null 2>&1 || { echo NODE_DOWNGRADE_PROVENANCE >&2; exit 65; }
mapfile -t packages < <(find "$tmp" -maxdepth 1 -type f -name '*.tgz' -print)
[[ ${#packages[@]} -eq 1 && "$(basename "${packages[0]}")" == in-falcone-0.4.18.tgz ]] || { echo NODE_DOWNGRADE_PROVENANCE >&2; exit 65; }
package=${packages[0]}; actual="sha256:$(sha256sum "$package" 2>/dev/null | awk '{print $1}')"
[[ "$actual" =~ ^sha256:[[:xdigit:]]{64}$ ]] || { echo NODE_DOWNGRADE_PROVENANCE >&2; exit 65; }
[[ "$actual" == "$digest" ]] || { echo NODE_DOWNGRADE_PROVENANCE >&2; exit 65; }
metadata=$(tar -xOf "$package" 'in-falcone/Chart.yaml' 2>/dev/null) || { echo NODE_DOWNGRADE_PROVENANCE >&2; exit 65; }
grep -qx 'name: in-falcone' <<<"$metadata" || { echo NODE_DOWNGRADE_PROVENANCE >&2; exit 65; }
grep -qx "version: $version" <<<"$metadata" || { echo NODE_DOWNGRADE_PROVENANCE >&2; exit 65; }
helm upgrade "$release" "$package" --version "$version" --namespace "$namespace" --wait --timeout 15m --reuse-values --values "$(dirname "$0")/../values/downgrade-node-workloads-vanilla.yaml"
"$(dirname "$0")/verify-node-workloads.sh" --namespace "$namespace" --release "$release" --platform vanilla

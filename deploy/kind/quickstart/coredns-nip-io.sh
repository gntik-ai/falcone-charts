#!/usr/bin/env bash
set -euo pipefail
context="${1:-$(kubectl config current-context)}"
case "$context" in
  kind-?*) ;;
  *) echo 'nip.io DNS setup requires a kind-* context' >&2; exit 1 ;;
esac
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
kubectl --context "$context" -n kube-system get configmap coredns -o json >"$work/current.json"
python3 - "$work/current.json" "$work/patch.json" <<'PY'
import json
import re
import sys
from pathlib import Path

corefile = json.loads(Path(sys.argv[1]).read_text())["data"]["Corefile"]
begin = '# BEGIN falcone-kind-nip-io'
end = '# END falcone-kind-nip-io'
if corefile.count(begin) != corefile.count(end):
    raise SystemExit('unbalanced falcone nip.io markers in Corefile')
corefile = re.sub(r'(?ms)^[ \t]*# BEGIN falcone-kind-nip-io\n.*?^[ \t]*# END falcone-kind-nip-io\n?', '', corefile)
block = r'''    # BEGIN falcone-kind-nip-io
    rewrite stop {
        name regex ^([a-z0-9-]+)\.127\.0\.0\.1\.nip\.io\.$ ingress-nginx-controller.ingress-nginx.svc.cluster.local.
        answer auto
    }
    # END falcone-kind-nip-io
'''
corefile, count = re.subn(r'(?m)^\.:53[ \t]*\{[ \t]*\n', lambda match: match[0] + block, corefile)
if count != 1:
    raise SystemExit('expected exactly one .:53 root server in Corefile')
Path(sys.argv[2]).write_text(json.dumps({'data': {'Corefile': corefile}}))
PY
kubectl --context "$context" -n kube-system patch configmap coredns --type merge --patch-file "$work/patch.json"
kubectl --context "$context" -n kube-system rollout restart deployment/coredns
kubectl --context "$context" -n kube-system rollout status deployment/coredns --timeout=300s

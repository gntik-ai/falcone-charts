#!/usr/bin/env bash
set -euo pipefail
namespace= release= platform=
while (($#)); do
  case "$1" in
    --namespace|--release|--platform) [[ $# -ge 2 ]] || { echo NODE_VERIFY_INPUT >&2; exit 64; }; printf -v "${1#--}" '%s' "$2"; shift 2;;
    *) echo NODE_VERIFY_INPUT >&2; exit 64;;
  esac
done
[[ -n "$namespace" && -n "$release" ]] || { echo NODE_VERIFY_INPUT >&2; exit 64; }
[[ "$platform" =~ ^(vanilla|openshift)$ ]] || { echo NODE_VERIFY_INPUT >&2; exit 64; }
command -v kubectl >/dev/null 2>&1 || { echo NODE_VERIFY_INPUT >&2; exit 127; }
deployments=$(kubectl -n "$namespace" get deployments -l "app.kubernetes.io/instance=$release" -o json 2>/dev/null) || { echo NODE_VERIFY_AVAILABILITY >&2; exit 1; }
pods=$(kubectl -n "$namespace" get pods -l "app.kubernetes.io/instance=$release" -o json 2>/dev/null) || { echo NODE_VERIFY_PODS >&2; exit 1; }
export FALCONE_VERIFY_NAMESPACE="$namespace"
python3 - "$deployments" "$pods" "$release" "$platform" <<'PY'
import json,sys,os,subprocess,re
def fail(code): print(code,file=sys.stderr); raise SystemExit(1)
try:
 d=json.loads(sys.argv[1]);
 if not isinstance(d,dict) or not isinstance(d.get('items'),list): fail('NODE_VERIFY_AVAILABILITY')
except Exception: fail('NODE_VERIFY_AVAILABILITY')
try:
 p=json.loads(sys.argv[2]);
 if not isinstance(p,dict) or not isinstance(p.get('items'),list): fail('NODE_VERIFY_PODS')
except Exception: fail('NODE_VERIFY_PODS')
release=sys.argv[3]; platform=sys.argv[4]
targets={'control-plane-executor':1000,'workflow-worker':1000}
def fullname(component): return (f'{release}-{component}'[:63]).rstrip('-')
target_pods=[x for x in p.get('items',[]) if x.get('metadata',{}).get('labels',{}).get('app.kubernetes.io/instance')==release and x.get('metadata',{}).get('labels',{}).get('app.kubernetes.io/name') in targets]
target_deployments=[x for x in d.get('items',[]) if x.get('metadata',{}).get('name') in {fullname(c) for c in targets}]
if len(target_deployments)!=2: fail('NODE_VERIFY_AVAILABILITY')
items={x.get('metadata',{}).get('name'):x for x in target_deployments}
if set(items)!={fullname(x) for x in targets}: fail('NODE_VERIFY_AVAILABILITY')
for component,uid in targets.items():
 x=items[fullname(component)]; s=x.get('spec',{}); st=x.get('status',{})
 if s.get('replicas')!=2 or any(k not in st or st.get(k)!=2 for k in ('updatedReplicas','readyReplicas','availableReplicas')): fail('NODE_VERIFY_AVAILABILITY')
 c=s.get('template',{}).get('spec',{}).get('containers',[])
 if len(c)!=1 or c[0].get('name')!=component: fail('NODE_VERIFY_HARDENING')
 sc=c[0].get('securityContext',{})
 psc=s.get('template',{}).get('spec',{}).get('securityContext',{})
 if sc.get('runAsNonRoot') is not True or sc.get('allowPrivilegeEscalation') is not False or sc.get('readOnlyRootFilesystem') is not True or sc.get('capabilities') != {'drop':['ALL']}: fail('NODE_VERIFY_HARDENING')
 if platform=='vanilla' and not (sc.get('runAsUser')==uid and sc.get('runAsGroup')==uid): fail('NODE_VERIFY_IDENTITY')
 if platform=='openshift' and ('runAsUser' in sc or 'runAsGroup' in sc or 'runAsUser' in psc or 'runAsGroup' in psc): fail('NODE_VERIFY_PLATFORM')
for component in targets:
 component_pods=[x for x in target_pods if x.get('metadata',{}).get('labels',{}).get('app.kubernetes.io/name')==component]
 if len(component_pods)!=2: fail('NODE_VERIFY_PODS')
 for pod in component_pods:
  md=pod.get('metadata',{}); st=pod.get('status',{}); labels=md.get('labels',{})
  if labels.get('app.kubernetes.io/instance')!=release or labels.get('app.kubernetes.io/name')!=component or st.get('phase')!='Running': fail('NODE_VERIFY_PODS')
  if not any(c.get('type')=='Ready' and c.get('status')=='True' for c in st.get('conditions',[])): fail('NODE_VERIFY_PODS')
  statuses=st.get('containerStatuses',[])
  if len(statuses)!=1 or statuses[0].get('name')!=component or statuses[0].get('ready') is not True or 'running' not in statuses[0].get('state',{}): fail('NODE_VERIFY_PODS')
  if statuses[0].get('state',{}).get('waiting',{}).get('reason')=='CreateContainerConfigError': fail('NODE_VERIFY_PODS')
if platform=='openshift':
 try: ns=json.loads(subprocess.check_output(['kubectl','get','namespace',os.environ['FALCONE_VERIFY_NAMESPACE'],'-o','json'],stderr=subprocess.DEVNULL,text=True))
 except Exception: fail('NODE_VERIFY_PLATFORM')
 raw=ns.get('metadata',{}).get('annotations',{}).get('openshift.io/sa.scc.uid-range','')
 m=re.fullmatch(r'(\d+)/(\d+)',raw)
 if not m: fail('NODE_VERIFY_PLATFORM')
 start,count=map(int,m.groups())
 if len(target_pods)!=4: fail('NODE_VERIFY_PLATFORM')
 for pod in target_pods:
  ann=pod.get('metadata',{}).get('annotations',{})
  if ann.get('openshift.io/scc')!='restricted-v2' or pod.get('status',{}).get('phase')!='Running': fail('NODE_VERIFY_PLATFORM')
  if not any(c.get('type')=='Ready' and c.get('status')=='True' for c in pod.get('status',{}).get('conditions',[])): fail('NODE_VERIFY_PLATFORM')
  name=pod.get('metadata',{}).get('name'); container=pod.get('metadata',{}).get('labels',{}).get('app.kubernetes.io/name')
  try: out=subprocess.check_output(['kubectl','exec',name,'-n',os.environ['FALCONE_VERIFY_NAMESPACE'],'-c',container,'--','id','-u'],text=True,stderr=subprocess.DEVNULL).strip(); uid=int(out)
  except Exception: fail('NODE_VERIFY_PLATFORM')
  if not start <= uid < start+count: fail('NODE_VERIFY_PLATFORM')
PY

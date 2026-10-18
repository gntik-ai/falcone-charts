#!/usr/bin/env python3
"""Disposable kind public-surface proof; never installs the platform or uses ambient contexts."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import uuid

import yaml

ROOT = Path(__file__).resolve().parents[3]
SETUP = ROOT / 'deploy/kind/quickstart'
CHART = ROOT / 'charts/in-falcone'
IMAGE = 'docker.io/library/busybox@sha256:9db7b59979c38555a39def84a31fb98b5296952f9e3afd4f6f11f05b07adfab0'
BASE_VALUES = ['dev.yaml', 'platform-kubernetes.yaml', 'profiles/all-in-one.yaml']


def command(args, *, env=None, payload=None):
    result = subprocess.run([str(arg) for arg in args], cwd=ROOT, env=env,
                            input=payload, text=True, stdout=subprocess.PIPE, check=True)
    return result.stdout


def render(profile):
    args = ['helm', 'template', 'falcone-surface', CHART, '--namespace', 'default']
    for value in BASE_VALUES + (['kind-quickstart.yaml'] if profile else []):
        args += ['-f', CHART / 'values' / value]
    if not profile:
        # Match the original HTTP quickstart so the negative case isolates paths,
        # rather than succeeding merely because the request host has no rule.
        args += ['--set', 'publicSurface.tls.mode=external']
        for surface, host in [('api', 'api'), ('console', 'console'),
                              ('identity', 'iam'), ('realtime', 'realtime')]:
            args += ['--set-string', f'publicSurface.hostnames.{surface}={host}.127.0.0.1.nip.io']
    return [doc for doc in yaml.safe_load_all(command(args)) if doc]


def standins(objects, ingresses):
    """Names AND service port numbers/names originate in rendered Ingress backends."""
    backends = {}
    for ingress in ingresses:
        for rule in ingress['spec']['rules']:
            for path in rule['http']['paths']:
                backend = path['backend']['service']
                backends.setdefault(backend['name'], []).append(backend['port'])
    manifests = []
    pods = {}
    for index, (name, references) in enumerate(backends.items()):
        original = next(obj for obj in objects if obj['kind'] == 'Service' and obj['metadata']['name'] == name)
        ports = []
        for port in original['spec']['ports']:
            if any(ref.get('name') == port.get('name') if 'name' in ref
                   else ref['number'] == port['port'] for ref in references):
                ports.append({**{key: port[key] for key in ('name', 'port', 'protocol') if key in port},
                              'targetPort': 8080})
        assert ports and len({tuple(sorted(ref.items())) for ref in references}) == len(ports), name
        label = {'quickstart-standin': str(index)}
        pod = f'standin-{index}'
        pods[name] = pod
        manifests.append({'apiVersion': 'v1', 'kind': 'Service', 'metadata': {'name': name},
                          'spec': {'selector': label, 'ports': ports}})
        # BusyBox redirects directory requests to a trailing slash, then executes
        # cgi-bin/index.cgi. Both clients follow that redirect through the ingress.
        script = r'''mkdir -p /tmp/www/cgi-bin /tmp/www/v1/x /tmp/www/v1/realtime/x /tmp/www/realms/x /tmp/www/control-plane/x
cat > /tmp/www/cgi-bin/index.cgi <<'CGI'
#!/bin/sh
printf 'Content-Type: text/plain\r\n\r\n'
printf 'service=%s\nhost=%s\nproto=%s\n' "$SERVICE_NAME" "$HTTP_HOST" "$HTTP_X_FORWARDED_PROTO"
CGI
chmod +x /tmp/www/cgi-bin/index.cgi
exec httpd -f -p 8080 -h /tmp/www
'''
        manifests.append({'apiVersion': 'v1', 'kind': 'Pod',
                          'metadata': {'name': pod, 'labels': label},
                          'spec': {'automountServiceAccountToken': False,
                                   'securityContext': {'runAsUser': 1000, 'runAsNonRoot': True},
                                   'containers': [{'name': 'http', 'image': IMAGE,
                                                   'command': ['sh', '-ec', script],
                                                   'env': [{'name': 'SERVICE_NAME', 'value': name}],
                                                   'securityContext': {'allowPrivilegeEscalation': False,
                                                                       'capabilities': {'drop': ['ALL']}},
                                                   'resources': {'requests': {'cpu': '10m', 'memory': '16Mi'},
                                                                 'limits': {'cpu': '100m', 'memory': '64Mi'}},
                                                   'readinessProbe': {'tcpSocket': {'port': 8080}}}]}})
    return manifests, pods


def fields(body):
    return dict(line.split('=', 1) for line in body.strip().splitlines())


def eventually(check):
    deadline = time.monotonic() + 300
    while True:
        try:
            return check()
        except (AssertionError, OSError, subprocess.CalledProcessError) as error:
            if time.monotonic() >= deadline:
                raise AssertionError(f'public surface did not converge: {error}') from error
            time.sleep(2)


def main():
    cluster = 'quickstart-81-' + uuid.uuid4().hex[:12]
    context = 'kind-' + cluster
    evidence = {'cluster': cluster, 'checks': [], 'image': IMAGE, 'status': 'FAIL'}
    evidence_path = Path(os.environ.get('KIND_QUICKSTART_EVIDENCE', '/tmp/kind-quickstart-surface-evidence.json'))
    try:
        with tempfile.TemporaryDirectory(prefix='falcone-kind-quickstart-') as folder:
            kubeconfig = Path(folder) / 'kubeconfig'
            env = {**os.environ, 'KUBECONFIG': str(kubeconfig)}

            def kubectl(*args, payload=None):
                return command(['kubectl', '--context', context, '--kubeconfig', kubeconfig, *args],
                               env=env, payload=payload)

            def apply(objects):
                assert all(obj['kind'] in ('Ingress', 'Service', 'Pod') for obj in objects)
                kubectl('apply', '-f', '-', payload=json.dumps({'apiVersion': 'v1', 'kind': 'List', 'items': objects}))

            try:
                command(['kind', 'create', 'cluster', '--name', cluster, '--kubeconfig', kubeconfig,
                         '--config', SETUP / 'cluster.yaml', '--wait', '120s'], env=env)
                command(['bash', SETUP / 'ingress-nginx.sh', context], env=env)
                corefiles = []
                for _ in range(2):
                    command(['bash', SETUP / 'coredns-nip-io.sh', context], env=env)
                    corefiles.append(json.loads(kubectl('-n', 'kube-system', 'get', 'configmap', 'coredns', '-o', 'json'))['data']['Corefile'])
                assert corefiles[0] == corefiles[1]
                assert corefiles[1].count('# BEGIN falcone-kind-nip-io') == 1
                assert corefiles[1].count('rewrite stop {') == 1
                evidence['checks'].append({'name': 'coredns-idempotent', 'status': 'PASS'})

                objects = render(True)
                ingresses = [obj for obj in objects if obj['kind'] == 'Ingress' and obj['metadata']['name'].endswith('-public')]
                assert ingresses, 'no public-surface Ingress rendered'
                manifests, pods = standins(objects, ingresses)
                apply(manifests)
                kubectl('wait', '--for=condition=Ready', 'pod', '-l', 'quickstart-standin', '--timeout=300s')
                apply(ingresses)
                backends = {rule['host']: rule['http']['paths'][0]['backend']['service']['name']
                            for obj in ingresses for rule in obj['spec']['rules']}
                assert backends['api.127.0.0.1.nip.io'] == backends['realtime.127.0.0.1.nip.io']
                opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

                def request(host, path, expected_status=200):
                    url = f'http://{host}{path}'
                    try:
                        with opener.open(url, timeout=10) as response:
                            status, body = response.status, response.read().decode()
                    except urllib.error.HTTPError as error:
                        status, body = error.code, error.read().decode()
                    assert status == expected_status, f'{url}: expected {expected_status}, got {status}'
                    if status == 200:
                        observed = fields(body)
                        assert observed == {'service': backends[host], 'host': host, 'proto': 'http'}, observed
                    return {'url': url, 'status': status, **({'response': fields(body)} if status == 200 else {})}

                for host, path in [('api.127.0.0.1.nip.io', '/v1/x'),
                                   ('realtime.127.0.0.1.nip.io', '/v1/realtime/x'),
                                   ('iam.127.0.0.1.nip.io', '/realms/x'),
                                   ('console.127.0.0.1.nip.io', '/')]:
                    evidence['checks'].append({'name': 'runner-routing', **eventually(lambda: request(host, path))})

                identity_host = 'iam.127.0.0.1.nip.io'

                def pod_request():
                    body = kubectl('exec', pods[backends[identity_host]], '--', 'wget', '-qO-',
                                   f'http://{identity_host}/realms/x')
                    observed = fields(body)
                    assert observed == {'service': backends[identity_host], 'host': identity_host, 'proto': 'http'}, observed
                    return observed

                evidence['checks'].append({'name': 'pod-dns-routing', 'response': eventually(pod_request), 'status': 'PASS'})
                negative = [obj for obj in render(False) if obj['kind'] == 'Ingress' and obj['metadata']['name'].endswith('-public')]
                assert {obj['metadata']['name'] for obj in negative} == {obj['metadata']['name'] for obj in ingresses}
                apply(negative)
                evidence['checks'].append({'name': 'without-profile-existing-route',
                                           **eventually(lambda: request('api.127.0.0.1.nip.io', '/control-plane/x'))})
                evidence['checks'].append({'name': 'without-profile-404',
                                           **eventually(lambda: request('api.127.0.0.1.nip.io', '/v1/x', 404))})
            finally:
                command(['kind', 'delete', 'cluster', '--name', cluster, '--kubeconfig', kubeconfig], env=env)
                evidence['cluster_deleted'] = True
            evidence['status'] = 'PASS'
    except Exception as error:
        evidence['error_type'] = type(error).__name__
        raise
    finally:
        evidence_path.parent.mkdir(parents=True, exist_ok=True)
        evidence_path.write_text(json.dumps(evidence, indent=2) + '\n')


if __name__ == '__main__':
    main()

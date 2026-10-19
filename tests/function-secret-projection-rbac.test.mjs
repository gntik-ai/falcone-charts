import assert from 'node:assert/strict';
import test from 'node:test';
import { render, umbrellaChart } from './blackbox/fixtures/blackbox.mjs';

function permissions(role, group, resource) {
  return [...new Set(role.rules.filter((rule) =>
    rule.apiGroups.some((value) => value === group || value === '*')
    && rule.resources.some((value) => value === resource || value === '*'))
    .flatMap((rule) => rule.verbs))].sort();
}

test('Function Secret projections receive only namespace-scoped lifecycle permissions', () => {
  const { objects } = render(umbrellaChart);
  const role = objects.find((object) => object.kind === 'Role'
    && object.metadata.name === 'falcone-bbx-function-executor');
  assert.ok(role, 'the function-executor Role must render');
  assert.equal(role.metadata.namespace, 'falcone-bbx');
  assert.deepEqual(permissions(role, '', 'secrets'),
    ['create', 'delete', 'get', 'patch', 'update'],
    'owned projections need lifecycle writes without Secret list/watch');

  const binding = objects.find((object) => object.kind === 'RoleBinding'
    && object.metadata.name === role.metadata.name);
  assert.equal(binding.metadata.namespace, role.metadata.namespace);
  assert.deepEqual(binding.roleRef, {
    apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: role.metadata.name,
  });
  assert.deepEqual(binding.subjects, [{
    kind: 'ServiceAccount', name: 'falcone-bbx-control-plane', namespace: 'falcone-bbx',
  }]);
});

test('legacy inline-secret remediation can inspect descendants and delete only Revisions', () => {
  const { objects } = render(umbrellaChart);
  const role = objects.find((object) => object.kind === 'Role'
    && object.metadata.name === 'falcone-bbx-function-executor');
  assert.deepEqual(permissions(role, 'serving.knative.dev', 'configurations'), ['list']);
  assert.deepEqual(permissions(role, 'serving.knative.dev', 'revisions'), ['delete', 'list']);
  for (const resource of ['deployments', 'replicasets']) {
    assert.deepEqual(permissions(role, 'apps', resource), ['list']);
  }
});

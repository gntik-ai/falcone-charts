import assert from 'node:assert/strict';
import test from 'node:test';
import { render, umbrellaChart } from './blackbox/fixtures/blackbox.mjs';
import { withPriorFunctionSecretProjection } from './blackbox/fixtures/function-secret-projection-snapshot.mjs';

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

test('historical snapshots subtract only the exact reviewed Function lifecycle RBAC', () => {
  const { objects } = render(umbrellaChart);
  const original = structuredClone(objects);
  const prior = withPriorFunctionSecretProjection(objects);
  const role = prior.find((object) => object.kind === 'Role'
    && object.metadata.name === 'falcone-bbx-function-executor');
  assert.deepEqual(role.rules, [
    { apiGroups: ['serving.knative.dev'], resources: ['services'],
      verbs: ['create', 'get', 'list', 'watch', 'update', 'patch', 'delete'] },
    { apiGroups: ['batch'], resources: ['jobs'], verbs: ['create', 'get', 'list', 'watch', 'delete'] },
    { apiGroups: [''], resources: ['pods'], verbs: ['get', 'list'] },
    { apiGroups: [''], resources: ['pods/log'], verbs: ['get'] },
  ]);
  assert.deepEqual(objects, original, 'snapshot normalization must not change the rendered input');

  for (const index of [1, 2, 3, 4]) {
    const changed = structuredClone(objects);
    const changedRole = changed.find((object) => object.kind === 'Role'
      && object.metadata.name === role.metadata.name);
    changedRole.rules[index].verbs.push('watch');
    assert.throws(() => withPriorFunctionSecretProjection(changed), assert.AssertionError,
      'snapshot normalization must reject changes to each reviewed permission rule');
  }
});

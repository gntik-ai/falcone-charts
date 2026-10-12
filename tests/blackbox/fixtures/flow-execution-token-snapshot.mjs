import assert from 'node:assert/strict'

import { allContainers, sha256 } from './blackbox.mjs'

// Reviewed #976 default-render additions. Check each complete object before
// subtracting it, so the historical hashes still detect all other chart drift.
// Put digests first to distinguish review fingerprints from secret assignments.
const additions = new Map([
  ['e68e3847903bd5107acce4e4a828d7bcc9b4b173d849068ad27fc2cc68a1cf2e', 'ExternalSecret/flows-execution-token'],
  ['7e7716b88229961fcae9c34b8f8abed7af8f0dcf7bccf7ca00e3102e276363eb', 'ConfigMap/openbao-policy-flow-execution-token'],
  ['639f9c0e7ee67e7f2aec985685041fc1b300f4b28e63bcda3a7812cdcfb11a64', 'ServiceAccount/flows-execution-token-ready'],
  ['3f4bbc33c397663e557b76571c11d3b7f772b1c398a959f25fb0c2df2410e422', 'Role/flows-execution-token-ready'],
  ['f36b82eb1682357a384a6bc78a3a513dad8a56a1b10a259d0acd8ab2fc30cc21', 'RoleBinding/flows-execution-token-ready'],
  ['c31f484c49af7c1c942ceaeab93c001f392dfede30a6c8688e640a9d530bc6f8', 'Job/flows-execution-token-ready'],
].map(([digest, id]) => [id, digest]))

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
  }
  return value
}

function replaceOnce(script, current, previous) {
  assert.equal(script.split(current).length, 2, 'the exact reviewed flow policy change must occur once')
  return script.replace(current, previous)
}

function one(objects, kind, name) {
  const matches = objects.filter((object) => object.kind === kind && object.metadata.name === name)
  assert.equal(matches.length, 1, `${kind}/${name} must exist exactly once`)
  return matches[0]
}

export function withPriorFlowExecutionToken(objects) {
  const prior = structuredClone(objects)
  for (const [id, expected] of additions) {
    const [kind, name] = id.split('/')
    assert.equal(sha256(JSON.stringify(canonical(one(prior, kind, name)))), expected,
      `${id} must retain its complete reviewed default spec`)
  }

  const expectedEnv = { name: 'FLOW_EXECUTION_TOKEN_SECRET', valueFrom: {
    secretKeyRef: { name: 'in-falcone-flow-execution-token', key: 'FLOW_EXECUTION_TOKEN_SECRET', optional: true },
  } }
  const recipients = []
  for (const { object, container } of allContainers(prior)) {
    const entries = (container.env ?? []).filter((entry) => entry.name === expectedEnv.name)
    if (object.kind === 'Deployment'
      && ['control-plane-executor', 'workflow-worker'].includes(container.name)) {
      recipients.push(`${object.metadata.name}/${container.name}`)
      assert.deepEqual(entries, [expectedEnv])
      assert.deepEqual(container.env[0], expectedEnv, 'only the reviewed env prefix is subtracted')
      container.env = container.env.slice(1)
    } else {
      assert.deepEqual(entries, [], `${object.metadata.name}/${container.name} must not receive the signing key`)
    }
  }
  assert.deepEqual(recipients.sort(), [
    'falcone-bbx-control-plane-executor/control-plane-executor',
    'falcone-bbx-workflow-worker/workflow-worker',
  ])

  const bootstrap = one(prior, 'Job', 'openbao-init').spec.template.spec
  const init = bootstrap.containers.find((container) => container.name === 'openbao-init')
  assert.ok(init)
  init.args[0] = replaceOnce(init.args[0],
    'for policy in init platform tenant functions gateway iam auth-reconcile function-invocation flow-execution-token; do',
    'for policy in init platform tenant functions gateway iam auth-reconcile function-invocation; do')
  init.args[0] = replaceOnce(init.args[0],
    'policies=platform,functions,gateway,iam,function-invocation,flow-execution-token ttl=24h',
    'policies=platform,functions,gateway,iam,function-invocation ttl=24h')
  const sources = bootstrap.volumes.find((volume) => volume.name === 'policies').projected.sources
  assert.deepEqual(sources.at(-1), { configMap: {
    name: 'openbao-policy-flow-execution-token',
    items: [{ key: 'policy.hcl', path: 'flow-execution-token.hcl' }],
  } })
  sources.pop()

  const reconcile = one(prior, 'Job', 'openbao-auth-reconcile').spec.template.spec.containers[0]
  reconcile.args[0] = replaceOnce(reconcile.args[0],
    'desired_policies="flow-execution-token,function-invocation,functions,gateway,iam,platform"',
    'desired_policies="function-invocation,functions,gateway,iam,platform"')
  reconcile.args[0] = replaceOnce(reconcile.args[0],
    'token_policies=platform,functions,gateway,iam,function-invocation,flow-execution-token ',
    'token_policies=platform,functions,gateway,iam,function-invocation ')
  reconcile.args[0] = replaceOnce(reconcile.args[0],
    '# Existing policy gates remain mandatory. Signer and flow-token policies\n# are installed by bootstrap at weight -2, after this metadata-only Job',
    '# Existing policy gates remain mandatory. The new signer policy is\n# installed by bootstrap at weight -2, after this metadata-only Job')

  return prior.filter((object) => !additions.has(`${object.kind}/${object.metadata.name}`))
}

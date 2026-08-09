/**
 * Public black-box contracts for reusing an administrator-owned External
 * Secrets installation without adopting or mutating its resources.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

import {
  assertSuccess,
  combined,
  readYaml,
  run,
  umbrellaChart,
  yamlDocuments,
} from '../fixtures/blackbox.mjs'

const adoptedArgs = [
  '--set', 'eso.external-secrets.enabled=false',
  '--set-string', 'global.externalSecrets.operatorNamespace=external-secrets',
  '--set-string', 'global.externalSecrets.operatorServiceAccount=external-secrets',
]

function renderWithCrds(args = []) {
  const result = run('helm', [
    'template', 'falcone-bbx', umbrellaChart,
    '--namespace', 'falcone-bbx',
    '--include-crds',
    ...args,
  ])
  assertSuccess(result, 'helm template --include-crds charts/in-falcone')
  return { text: result.stdout, objects: yamlDocuments(result.stdout) }
}

function isEsoCrd(object) {
  return object?.kind === 'CustomResourceDefinition'
    && /(?:external-secrets\.io|generators\.external-secrets\.io)$/.test(object.metadata?.name ?? '')
}

function isBundledEsoDeployment(object) {
  return object?.kind === 'Deployment'
    && /^eso-external-secrets(?:-|$)/.test(object.metadata?.name ?? '')
}

test('values schema exposes a first-class managed/adopted ESO contract', () => {
  const values = readYaml(resolve(umbrellaChart, 'values.yaml'))
  const schema = JSON.parse(readFileSync(resolve(umbrellaChart, 'values.schema.json'), 'utf8'))
  const enabled = schema?.properties?.eso?.properties?.['external-secrets']?.properties?.enabled
  const operatorNamespace = schema?.properties?.global?.properties?.externalSecrets?.properties?.operatorNamespace

  assert.equal(values?.eso?.['external-secrets']?.enabled, true)
  assert.equal(values?.global?.externalSecrets?.operatorNamespace, '')
  assert.equal(enabled?.type, 'boolean')
  assert.equal(enabled?.default, true)
  assert.equal(operatorNamespace?.type, 'string')
  assert.equal(operatorNamespace?.default, '')
  assert.match(operatorNamespace?.pattern ?? '', /a-z0-9/)
})

test('adopted ESO requires a distinct, explicit external controller namespace', () => {
  const missing = run('helm', [
    'template', 'falcone-bbx', umbrellaChart,
    '--namespace', 'falcone-bbx',
    '--set', 'eso.external-secrets.enabled=false',
  ])
  assert.notEqual(missing.status, 0, 'adopted ESO unexpectedly accepted a missing operator namespace')
  assert.match(combined(missing), /global\.externalSecrets\.operatorNamespace is required/)

  const shared = run('helm', [
    'template', 'falcone-bbx', umbrellaChart,
    '--namespace', 'falcone-bbx',
    '--set', 'eso.external-secrets.enabled=false',
    '--set-string', 'global.externalSecrets.operatorNamespace=eso-system',
    '--set-string', 'global.externalSecrets.operatorServiceAccount=external-secrets',
  ])
  assert.notEqual(shared.status, 0, 'adopted ESO unexpectedly allowed Falcone to own the external namespace')
  assert.match(combined(shared), /must differ from eso\.eso\.namespace/)

  const managedWithExternalNamespace = run('helm', [
    'template', 'falcone-bbx', umbrellaChart,
    '--namespace', 'falcone-bbx',
    '--set-string', 'global.externalSecrets.operatorNamespace=external-secrets',
  ])
  assert.notEqual(managedWithExternalNamespace.status, 0, 'managed ESO unexpectedly accepted adopted-only configuration')
  assert.match(combined(managedWithExternalNamespace), /valid only when eso\.external-secrets\.enabled=false/)
})

test('managed ESO keeps the bundled controller, CRDs, webhook wait, and egress policy', () => {
  const { objects } = renderWithCrds()

  assert.ok(objects.some(isEsoCrd), 'managed mode must install the bundled ESO CRDs')
  assert.equal(objects.filter(isBundledEsoDeployment).length, 3, 'managed mode must install controller, webhook, and cert-controller')
  assert.ok(objects.some((object) => object.metadata?.name === 'eso-webhook-wait'))
  assert.ok(objects.some((object) => object.kind === 'NetworkPolicy' && object.metadata?.name === 'eso-to-openbao'))
})

test('adopted ESO renders only Falcone-owned integration resources and never touches the external namespace', () => {
  const { objects } = renderWithCrds(adoptedArgs)

  assert.equal(objects.filter(isEsoCrd).length, 0, 'adopted mode must not render ESO CRDs')
  assert.equal(objects.filter(isBundledEsoDeployment).length, 0, 'adopted mode must not render bundled ESO workloads')
  assert.ok(!objects.some((object) => object.metadata?.name === 'eso-webhook-wait'), 'adopted mode must not wait for Falcone-owned webhook endpoints')
  assert.ok(!objects.some((object) => object.kind === 'NetworkPolicy' && object.metadata?.name === 'eso-to-openbao'), 'adopted mode must not apply a blanket egress policy to the external controller namespace')

  assert.ok(!objects.some((object) => object.kind === 'Namespace' && object.metadata?.name === 'external-secrets'), 'Falcone must not own the administrator namespace')
  assert.ok(!objects.some((object) => object.metadata?.namespace === 'external-secrets'), 'Falcone must not render any namespaced object into the administrator namespace')
  assert.ok(objects.some((object) => object.kind === 'Namespace' && object.metadata?.name === 'eso-system'), 'Falcone must retain its separate authentication namespace')

  assert.equal(objects.filter((object) => object.kind === 'ClusterSecretStore' && object.metadata?.name === 'openbao-backend').length, 1)
  assert.equal(objects.filter((object) => object.kind === 'ExternalSecret').length, 14)

  const openbaoPolicy = objects.find((object) => object.kind === 'NetworkPolicy' && object.metadata?.name === 'openbao-access-policy')
  assert.ok(openbaoPolicy, 'OpenBao ingress policy is missing')
  const ingressNamespaces = (openbaoPolicy.spec?.ingress ?? [])
    .flatMap((rule) => rule.from ?? [])
    .map((peer) => peer.namespaceSelector?.matchLabels?.['kubernetes.io/metadata.name'])
    .filter(Boolean)
  assert.ok(ingressNamespaces.includes('external-secrets'), 'OpenBao must admit the configured external ESO controller namespace')

  const preflight = objects.find((object) => object.kind === 'Job' && object.metadata?.name === 'eso-preflight')
  assert.ok(preflight, 'adopted mode must retain the read-only compatibility preflight')
  const script = preflight.spec?.template?.spec?.containers?.[0]?.command?.[2] ?? ''
  const syntax = run('/bin/sh', ['-n'], { input: script })
  assertSuccess(syntax, 'rendered adopted ESO preflight shell syntax')
  assert.match(script, /eso_managed="false"/)
  assert.match(script, /external_eso_namespace="external-secrets"/)
  assert.match(script, /external_eso_service_account="external-secrets"/)
  assert.match(script, /availableReplicas/)
  assert.match(script, /api-resources --api-group=external-secrets\.io/)
})

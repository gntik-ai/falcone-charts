/**
 * Regression contract: the staging public surface must be exposed under the real
 * baas.musematic.ai domain, never the in-falcone.example.com placeholders.
 *
 * Finding FAL-001 (falcone-incident-20260815T053937Z): the deployed Helm release
 * rendered `*.staging.in-falcone.example.com` hostnames while public DNS for
 * `*.baas.musematic.ai` already pointed at the cluster, so every public route
 * returned nginx 404. This test renders the staging values and asserts the
 * public domain is wired end-to-end (Ingress rules, OIDC issuer/discovery,
 * CORS origins, and the Keycloak console redirect URIs/web origins).
 */
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'

import {
  render,
  umbrellaChart,
} from '../fixtures/blackbox.mjs'

const stagingValues = resolve(umbrellaChart, 'values/staging.yaml')

const EXPECTED_HOSTS = [
  'api.baas.musematic.ai',
  'baas.musematic.ai',
  'iam.baas.musematic.ai',
  'realtime.baas.musematic.ai',
]

function renderStaging() {
  return render(umbrellaChart, [
    '-f', stagingValues,
    '--namespace', 'in-falcone-staging',
  ])
}

function ingressObjects(objects) {
  return objects.filter((o) => o?.kind === 'Ingress')
}

test('staging public surface renders only the real musematic hosts', () => {
  const { objects, text } = renderStaging()
  const ingresses = ingressObjects(objects)
  assert.ok(ingresses.length > 0, 'staging render must emit an Ingress')

  const hosts = ingresses
    .flatMap((ing) => (ing?.spec?.rules ?? []).map((rule) => rule?.host))
    .filter(Boolean)

  assert.deepEqual(
    [...new Set(hosts)].sort(),
    [...EXPECTED_HOSTS].sort(),
    'staging Ingress rules must be exactly the four public musematic hosts',
  )

  assert.doesNotMatch(
    text,
    /staging\.in-falcone\.example\.com/,
    'staging render must contain no staging.in-falcone.example.com placeholder host',
  )
})

test('staging OIDC issuer and discovery point at iam.baas.musematic.ai', () => {
  const { text } = renderStaging()
  assert.match(
    text,
    /https:\/\/iam\.baas\.musematic\.ai\/auth\/realms\/in-falcone-platform/,
    'OIDC issuer/discovery must use the real identity host',
  )
})

test('staging console CORS and Keycloak redirect URIs use the apex domain', () => {
  const { text } = renderStaging()
  assert.match(
    text,
    /https:\/\/baas\.musematic\.ai\/\*/,
    'Keycloak in-falcone-console redirect URI must allow the apex console host',
  )
  assert.match(
    text,
    /"allow_origins":\s*"https:\/\/baas\.musematic\.ai"/,
    'gateway CORS allow_origins must reference the apex console host',
  )
})

test('staging values file itself carries no placeholder public hostname', () => {
  const { objects } = renderStaging()
  // Guard against regression where the values file is fixed but a template
  // re-hardcodes the placeholder somewhere in a rendered ConfigMap/Secret.
  const serialized = JSON.stringify(objects)
  assert.doesNotMatch(
    serialized,
    /staging\.in-falcone\.example\.com/,
    'no rendered object may reference staging.in-falcone.example.com',
  )
})

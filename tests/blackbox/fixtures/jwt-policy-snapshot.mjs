import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// Assert only #1505's reviewed default-render delta before restoring the base
// f81dcd5d snapshot. Existing golden hashes still cover every unrelated field.
const jwtNames = [
  'KEYCLOAK_JWKS_URL', 'KEYCLOAK_ISSUER', 'KEYCLOAK_AUDIENCE',
  'KEYCLOAK_TENANT_AUDIENCE', 'KEYCLOAK_ENFORCE_TENANT_AUDIENCE',
  'KEYCLOAK_TRUSTED_REALM_BASES', 'KEYCLOAK_PLATFORM_REALM',
  'KEYCLOAK_PLATFORM_AUDIENCES', 'KEYCLOAK_ALLOW_TENANT_REALMS',
]
const reference = name => ({ name, valueFrom: { configMapKeyRef: {
  name: 'falcone-bbx-executor-jwt-config', key: name,
} } })
const mapper = {
  config: { 'access.token.claim': 'true', 'id.token.claim': 'false', 'included.custom.audience': 'in-falcone' },
  consentRequired: false, name: 'in-falcone-audience', protocol: 'openid-connect', protocolMapper: 'oidc-audience-mapper',
}
const bootstrapHash = 'in-falcone.io/bootstrap-one-shot-hash'
const priorBootstrapHash = '1cfab53425af780cd4b4892df2a1f04537758356ffa04f5c7b749db960d4e747'
const currentBootstrapHash = 'ac1f9d1b1aea25cac73dcabc5ff854e07c235fb8420a86453dcc55f3ffadac99'
const issuerChecksum = '95d614d51f3ce8987520bc86fdfe84e6bebe8405437ec08678bc55c0f55dcd2b'
const reconciliation = readFileSync(new URL('./jwt-policy-bootstrap/audience-reconciliation.txt', import.meta.url), 'utf8') + '\n'

function one(objects, kind, name) {
  const matches = objects.filter(o => o.kind === kind && o.metadata.name === name)
  assert.equal(matches.length, 1, `${kind}/${name} must remain unique`)
  return matches[0]
}

function replaceOnce(text, current, previous) {
  assert.equal(text.split(current).length, 2, 'the reviewed bootstrap addition must occur exactly once')
  return text.replace(current, previous)
}

export function withPriorJwtPolicy(objects) {
  const prior = structuredClone(objects)
  const config = one(prior, 'ConfigMap', 'falcone-bbx-executor-jwt-config')
  for (const [name, value] of Object.entries({
    KEYCLOAK_TRUSTED_REALM_BASES: '["https://iam.dev.in-falcone.example.com/realms/","http://falcone-bbx-keycloak:8080/realms/"]',
    KEYCLOAK_PLATFORM_REALM: 'in-falcone-platform',
    KEYCLOAK_PLATFORM_AUDIENCES: '["in-falcone","account"]',
    KEYCLOAK_ALLOW_TENANT_REALMS: '1',
  })) {
    assert.equal(config.data[name], value, name)
    delete config.data[name]
  }

  for (const [component, index] of [['control-plane', 16], ['control-plane-executor', 1]]) {
    const deployment = one(prior, 'Deployment', `falcone-bbx-${component}`)
    const pod = deployment.spec.template
    assert.equal(pod.metadata.annotations['in-falcone.io/issuer-config-checksum'], issuerChecksum)
    delete pod.metadata.annotations['in-falcone.io/issuer-config-checksum']
    const containers = pod.spec.containers.filter(c => c.name === component)
    assert.equal(containers.length, 1)
    const env = containers[0].env
    assert.deepEqual(env.filter(e => jwtNames.includes(e.name)), jwtNames.map(reference))
    assert.deepEqual(env.splice(index, jwtNames.length), jwtNames.map(reference))
    if (component === 'control-plane') {
      env.splice(30, 0, { name: 'KEYCLOAK_JWKS_URL',
        value: 'http://falcone-bbx-keycloak:8080/realms/in-falcone-platform/protocol/openid-connect/certs' })
    } else {
      env.splice(3, 0, ...jwtNames.slice(0, 5).map(reference))
    }
  }

  const payload = one(prior, 'ConfigMap', 'falcone-bbx-in-falcone-bootstrap-payload')
  assert.equal(payload.data['console-audience-mapper.json'], `\n${JSON.stringify(mapper, null, 2)}\n`)
  delete payload.data['console-audience-mapper.json']
  const clientText = payload.data['client-in-falcone-console.json']
  const client = JSON.parse(clientText)
  assert.deepEqual(client.protocolMappers, [mapper])
  const mapperBlock = JSON.stringify({ protocolMappers: [mapper] }, null, 2).slice(2, -2)
  payload.data['client-in-falcone-console.json'] = replaceOnce(clientText, `${mapperBlock},\n`, '')

  const script = one(prior, 'ConfigMap', 'falcone-bbx-in-falcone-bootstrap-script')
  script.data['bootstrap.sh'] = replaceOnce(script.data['bootstrap.sh'], reconciliation, '')
  script.data['bootstrap.sh'] = replaceOnce(script.data['bootstrap.sh'], '  ensure_console_audience "$token"\n', '')
  // The one-shot payload hash also occurs in the distributed program.
  script.data['bootstrap.sh'] = replaceOnce(script.data['bootstrap.sh'], currentBootstrapHash, priorBootstrapHash)
  for (const object of [payload, script]) {
    assert.equal(object.metadata.annotations[bootstrapHash], currentBootstrapHash)
    object.metadata.annotations[bootstrapHash] = priorBootstrapHash
  }
  return prior
}

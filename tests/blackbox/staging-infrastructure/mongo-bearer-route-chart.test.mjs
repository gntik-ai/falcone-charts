import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { imageReferences, render, umbrellaChart, repoRoot, run, sha256, yamlDocuments } from '../fixtures/blackbox.mjs'

const overlayImage = 'docker.io/library/busybox@sha256:9db7b59979c38555a39def84a31fb98b5296952f9e3afd4f6f11f05b07adfab0'

function renderedGateway(overlay = []) {
  const { objects } = render(umbrellaChart, overlay)
  return objects.find((object) => object.kind === 'Deployment' && /-apisix$/.test(object.metadata.name))
}

function rendered(overlay = []) {
  const { objects, text } = render(umbrellaChart, overlay)
  const payload = objects.find((object) => object.kind === 'ConfigMap' && object.data?.['route-2006.json'])
  assert.ok(payload, 'bootstrap route payload is rendered')
  const route = JSON.parse(payload.data['route-2006.json'])
  const apiKey = JSON.parse(payload.data['route-2006-key.json'])
  const gateway = objects.find((object) => object.kind === 'Deployment' && /-apisix$/.test(object.metadata.name))
  const executor = objects.find((object) => object.kind === 'Deployment' && /-control-plane-executor$/.test(object.metadata.name))
  return { objects, text, route, apiKey, gateway, executor }
}

function executorEnv(objects, executor) {
  return Object.fromEntries(executor.spec.template.spec.containers[0].env.map((item) => {
    const ref = item.valueFrom?.configMapKeyRef
    if (!ref) return [item.name, item.value]
    const config = objects.find((object) => object.kind === 'ConfigMap' && object.metadata.name === ref.name)
    assert.ok(config?.data?.[ref.key], `${item.name}: referenced configuration must be rendered`)
    return [item.name, config.data[ref.key]]
  }))
}

for (const [name, overlay] of [['default', []], ['staging', ['-f', `${umbrellaChart}/values/staging.yaml`]], ['prod', ['-f', `${umbrellaChart}/values/prod.yaml`]]]) {
  test(`${name} Mongo bearer route enables issuer verification and keeps API key priority`, () => {
    const { objects, text, route, apiKey, gateway, executor } = rendered(overlay)
    assert.equal(route.uri, '/v1/mongo/*')
    assert.equal(route.priority, 234)
    assert.match(Object.keys(route.upstream.nodes)[0], /-control-plane-executor\./)
    assert.ok(route.plugins['issuer-jwks-auth'])
    assert.equal(route.plugins['openid-connect'], undefined)
    assert.deepEqual(Object.keys(route.plugins['issuer-jwks-auth']).sort(), [
      'issuer_base_url', 'jwks_base_url', 'platform_realm', 'audience', 'tenant_audience', 'enforce_tenant_audience', 'cache_ttl', 'cache_max_entries', 'timeout',
    ].sort())
    assert.equal(route.plugins['issuer-jwks-auth'].cache_max_entries, 128)
    assert.equal(route.plugins['issuer-jwks-auth'].cache_ttl, 300)
    assert.equal(route.plugins['limit-count'].rejected_code, 429)
    assert.ok(route.plugins['client-control'].max_body_size > 0)
    assert.ok(route.plugins['request-validation'].header_schema.properties['X-Tenant-Id'].maxLength === 0)
    assert.deepEqual(route.plugins['proxy-rewrite'].headers.remove, [
      'apikey', 'x-api-key',
      'x-tenant-id', 'x-workspace-id', 'x-auth-subject', 'x-actor-roles',
    ])
    assert.equal(route.plugins['proxy-rewrite'].headers.set['x-gateway-auth'], '${{GATEWAY_SHARED_SECRET}}')
    assert.equal(route.plugins['proxy-rewrite'].headers.set['X-Correlation-Id'], '$http_x_correlation_id')
    assert.equal(route.plugins['proxy-rewrite'].headers.set['X-Request-Id'], '$request_id')
    assert.equal(apiKey.priority, 334)
    assert.deepEqual(apiKey.vars, [['http_apikey', '~~', '^flc_']])
    assert.equal(apiKey.plugins['limit-count'].key, '$http_apikey')
    assert.equal(apiKey.plugins['issuer-jwks-auth'], undefined)

    const plugin = objects.find((object) => object.kind === 'ConfigMap' && /-issuer-jwks-auth$/.test(object.metadata.name))
    const config = objects.find((object) => object.kind === 'ConfigMap' && /-apisix-config-file$/.test(object.metadata.name))
    assert.match(plugin.data['issuer-jwks-auth.lua'], /function plugin\.rewrite/)
    assert.match(config.data['config.yaml'], /- issuer-jwks-auth/)
    assert.match(config.data['config.yaml'], /extra_lua_path: \/usr\/local\/apisix\/falcone\/\?\.lua/)
    const mounts = gateway.spec.template.spec.containers[0].volumeMounts
    const configOverlay = gateway.spec.template.spec.initContainers.find((container) => container.name === 'apisix-config-overlay')
    assert.equal(configOverlay.image, overlayImage, `${name}: the overlay must use the reviewed BusyBox digest`)
    assert.equal(configOverlay.securityContext.readOnlyRootFilesystem, true, `${name}: config copy must use a read-only root filesystem`)
    assert.notEqual(configOverlay.image, gateway.spec.template.spec.containers[0].image)
    assert.ok(mounts.some((mount) => mount.mountPath.endsWith('/apisix/plugins/issuer-jwks-auth.lua')))
    const volumes = new Set(gateway.spec.template.spec.volumes.map((volume) => volume.name))
    if (name === 'staging') {
      const verifierVolume = gateway.spec.template.spec.volumes.find((volume) => volume.name === 'issuer-jwks-auth')
      assert.equal(verifierVolume.configMap.defaultMode, 420)
    }
    for (const container of [...gateway.spec.template.spec.initContainers, ...gateway.spec.template.spec.containers]) {
      for (const mount of container.volumeMounts ?? []) {
        assert.ok(volumes.has(mount.name), `${name}: ${container.name} mounts missing volume ${mount.name}`)
      }
    }
    assert.ok(mounts.some((mount) => mount.mountPath === '/usr/local/apisix/conf/config.yaml'))
    assert.ok(executor.spec.template.spec.containers[0].env.some((item) => item.name === 'KEYCLOAK_JWKS_URL'))
    const env = executorEnv(objects, executor)
    const verifier = route.plugins['issuer-jwks-auth']
    const policyConfig = objects.find((object) => object.kind === 'ConfigMap' && /-gateway-policy$/.test(object.metadata.name))
    const policyVerifier = JSON.parse(policyConfig.data['gateway-policy.json']).issuerJwksAuth
    assert.equal(policyVerifier.issuerBaseUrl, verifier.issuer_base_url)
    assert.equal(policyVerifier.jwksBaseUrl, verifier.jwks_base_url)
    assert.equal(env.KEYCLOAK_ISSUER, `${verifier.issuer_base_url}/realms/${verifier.platform_realm}`)
    assert.equal(env.KEYCLOAK_JWKS_URL, `${verifier.jwks_base_url}/realms/${verifier.platform_realm}/protocol/openid-connect/certs`)
    assert.equal(env.KEYCLOAK_AUDIENCE, verifier.audience)
    assert.equal(verifier.tenant_audience, 'falcone-data-api')
    assert.equal(verifier.enforce_tenant_audience, name !== 'staging', 'staging requires reconciliation before enforcement')
    assert.equal(env.KEYCLOAK_TENANT_AUDIENCE, verifier.tenant_audience)
    assert.equal(env.KEYCLOAK_ENFORCE_TENANT_AUDIENCE, String(verifier.enforce_tenant_audience))
    if (name === 'staging') {
      assert.equal(verifier.issuer_base_url, 'https://iam.baas.musematic.ai')
      assert.equal(verifier.jwks_base_url, 'http://falcone-keycloak:8080')
      assert.equal(env.KEYCLOAK_ISSUER, 'https://iam.baas.musematic.ai/realms/in-falcone-platform')
      assert.equal(env.KEYCLOAK_JWKS_URL, 'http://falcone-keycloak:8080/realms/in-falcone-platform/protocol/openid-connect/certs')
    }
    if (name === 'staging' || name === 'prod') {
      assert.doesNotMatch(env.KEYCLOAK_ISSUER, /iam\.dev\./)
      assert.doesNotMatch(verifier.issuer_base_url, /iam\.dev\./)
    }
    assert.ok(executor.spec.template.spec.containers[0].env.some((item) => item.name === 'GATEWAY_SHARED_SECRET' && item.valueFrom?.secretKeyRef))
    assert.equal(text.includes('GATEWAY_SHARED_SECRET=') , false)
  })
}

test('kind mounts the verifier, config overlay, and all init-container volumes', () => {
  const { objects } = render(umbrellaChart, ['-f', `${repoRoot}/deploy/kind/values-kind.yaml`])
  const gateway = objects.find((object) => object.kind === 'Deployment' && /-apisix$/.test(object.metadata.name))
  const pod = gateway.spec.template.spec
  const overlay = pod.initContainers.find((container) => container.name === 'apisix-config-overlay')
  assert.equal(overlay.image, overlayImage, 'kind: the overlay must use the reviewed BusyBox digest')
  assert.equal(overlay.securityContext.readOnlyRootFilesystem, true)
  assert.notEqual(overlay.image, pod.containers[0].image)
  const volumes = new Set(pod.volumes.map((volume) => volume.name))
  for (const required of ['standalone-config', 'apisix-config-source', 'apisix-config-overlay', 'issuer-jwks-auth']) {
    assert.ok(volumes.has(required), `missing kind APISIX volume ${required}`)
  }
  for (const container of [...pod.initContainers, ...pod.containers]) {
    for (const mount of container.volumeMounts ?? []) {
      assert.ok(volumes.has(mount.name), `${container.name} mounts missing volume ${mount.name}`)
    }
  }
  const mounts = pod.containers[0].volumeMounts.map((mount) => mount.mountPath)
  assert.ok(mounts.includes('/usr/local/apisix/conf/config.yaml'))
  assert.ok(mounts.includes('/usr/local/apisix/falcone/apisix/plugins/issuer-jwks-auth.lua'))
  const config = objects.find((object) => object.kind === 'ConfigMap' && /-apisix-config-file$/.test(object.metadata.name))
  assert.match(config.data['config.yaml'], /- issuer-jwks-auth/)
  const executor = objects.find((object) => object.kind === 'Deployment' && /-control-plane-executor$/.test(object.metadata.name))
  const env = executorEnv(objects, executor)
  const canonical = yamlDocuments(readFileSync(resolve(umbrellaChart, 'files/apisix/standalone/apisix.yaml'), 'utf8'))[0]
  const verifier = canonical.routes.find((entry) => String(entry.id) === '2006').plugins['issuer-jwks-auth']
  assert.equal(verifier.tenant_audience, 'falcone-data-api')
  assert.equal(verifier.enforce_tenant_audience, true)
  assert.equal(env.KEYCLOAK_TENANT_AUDIENCE, verifier.tenant_audience)
  assert.equal(env.KEYCLOAK_ENFORCE_TENANT_AUDIENCE, String(verifier.enforce_tenant_audience))
})

test('staging render and canonical kind bearer routes strip API keys while preserving the per-key route', () => {
  const baseline = yamlDocuments(readFileSync(resolve(repoRoot, 'tests/blackbox/fixtures/mongo-staging-routes-before-980.yaml'), 'utf8'))[0]
  const { objects, route, apiKey } = rendered(['-f', `${umbrellaChart}/values/staging.yaml`])
  const config = objects.find((object) => object.kind === 'ConfigMap' && object.metadata.name === 'falcone-apisix-standalone')
  assert.ok(config, 'staging standalone routes must be managed')
  // Kind mounts the externally supplied canonical table and disables bootstrap.
  const canonical = readFileSync(resolve(umbrellaChart, 'files/apisix/standalone/apisix.yaml'), 'utf8')
    .replaceAll('.falcone.svc.cluster.local', '.falcone-bbx.svc.cluster.local')
  for (const [profile, standalone] of [
    ['staging', yamlDocuments(config.data['apisix.yaml'])[0]],
    ['kind canonical', yamlDocuments(canonical)[0]],
  ]) {
    const bearer = standalone.routes.find((entry) => String(entry.id) === '2006')
    assert.deepEqual(bearer.plugins['proxy-rewrite'].headers.remove, route.plugins['proxy-rewrite'].headers.remove)
    for (const header of ['apikey', 'x-api-key']) {
      assert.ok(bearer.plugins['proxy-rewrite'].headers.remove.includes(header), `${profile}: ${header} must not reach executor JWT requests`)
    }
    const keyRoute = standalone.routes.find((entry) => String(entry.id) === '2006-key')
    const expectedKey = JSON.parse(JSON.stringify(baseline.routes.find((entry) => String(entry.id) === '2006-key'))
      .replaceAll('.in-falcone-staging.svc.cluster.local', '.falcone-bbx.svc.cluster.local'))
    assert.deepEqual(keyRoute, expectedKey, 'API-key route must remain identical to the pre-980 contract')
    assert.equal(apiKey.plugins['limit-count'].key, '$http_apikey')
    assert.equal(apiKey.plugins['limit-count'].rejected_code, 429)
  }
})

test('all profiles keep staging BusyBox registry handling independently of APISIX promotion', () => {
  const digest = `sha256:${'a'.repeat(64)}`
  for (const profile of [null, `${umbrellaChart}/values/prod.yaml`, `${umbrellaChart}/values/staging.yaml`, `${repoRoot}/deploy/kind/values-kind.yaml`]) {
    const gateway = renderedGateway([
      ...(profile ? ['-f', profile] : []),
      '--set-string', `apisix.image.digest=${digest}`,
      '--set-string', 'global.imageRegistry=mirror.example.test',
    ])
    const pod = gateway.spec.template.spec
    const overlay = pod.initContainers.find((container) => container.name === 'apisix-config-overlay')
    assert.equal(pod.containers[0].image, `mirror.example.test/apache/apisix@${digest}`)
    // Like the existing staging init image, this literal is not rewritten by global.imageRegistry.
    assert.equal(overlay.image, overlayImage)
  }
})

test('airgap mirrors the BusyBox overlay without changing its config copy or security settings', () => {
  const airgap = ['-f', `${umbrellaChart}/values/airgap.yaml`]
  const { objects } = render(umbrellaChart, airgap)
  const gateway = objects.find((object) => object.kind === 'Deployment' && /-apisix$/.test(object.metadata.name))
  const configOverlay = (gateway) => gateway.spec.template.spec.initContainers.find((container) => container.name === 'apisix-config-overlay')
  const mirrored = configOverlay(gateway)
  const original = configOverlay(renderedGateway())
  assert.equal(mirrored.image, overlayImage.replace('docker.io', 'registry.airgap.in-falcone.local'))
  assert.deepEqual({ ...mirrored, image: original.image }, original,
    'airgap must preserve the overlay command, mounts, pull policy and security context')
  const images = imageReferences(objects)
  assert.ok(images.length > 0)
  for (const image of images) {
    assert.ok(image.startsWith('registry.airgap.in-falcone.local/'), `airgap contains an unmirrored image: ${image}`)
  }
  const openshiftOverlay = configOverlay(renderedGateway([...airgap, '-f', `${umbrellaChart}/values/platform-openshift.yaml`]))
  assert.equal(openshiftOverlay.image, mirrored.image)
  assert.equal(openshiftOverlay.securityContext.runAsUser, undefined)
  assert.equal(openshiftOverlay.securityContext.runAsGroup, undefined)
  assert.equal(openshiftOverlay.securityContext.runAsNonRoot, true)
  assert.equal(openshiftOverlay.securityContext.readOnlyRootFilesystem, true)
})

test('APISIX numeric identities and OpenShift overlay retain the main contracts', () => {
  for (const profile of [null, `${umbrellaChart}/values/prod.yaml`, `${umbrellaChart}/values/staging.yaml`, `${repoRoot}/deploy/kind/values-kind.yaml`]) {
    const args = profile ? ['-f', profile] : []
    const gateway = renderedGateway(args)
    const pod = gateway.spec.template.spec
    assert.equal(pod.containers[0].securityContext.runAsUser, 636)
    assert.equal(pod.containers[0].securityContext.runAsGroup, 636)
    const staging = profile?.endsWith('/staging.yaml')
    for (const [field, expected] of [['runAsUser', 636], ['runAsGroup', 636], ['fsGroup', 1001]]) {
      assert.equal(pod.securityContext?.[field], field === 'fsGroup' || staging ? expected : undefined)
    }
    const openshift = renderedGateway([...args, '-f', `${umbrellaChart}/values/platform-openshift.yaml`])
    const openshiftPod = openshift.spec.template.spec
    for (const field of ['runAsUser', 'runAsGroup', 'fsGroup']) {
      assert.equal(openshiftPod.securityContext?.[field], undefined)
    }
    for (const container of [...openshiftPod.initContainers, ...openshiftPod.containers]) {
      assert.equal(container.securityContext?.runAsUser, undefined)
      assert.equal(container.securityContext?.runAsGroup, undefined)
    }
    assert.equal(openshiftPod.initContainers.find((container) => container.name === 'apisix-config-overlay')
      .securityContext.readOnlyRootFilesystem, true)
  }
})

test('staging standalone, bootstrap and executor use every configured verifier setting', () => {
  const { objects, route, executor } = rendered([
    '-f', `${umbrellaChart}/values/staging.yaml`,
    '--set-string', 'gatewayPolicy.issuerJwksAuth.issuerBaseUrl=https://iam.example.test/auth/',
    '--set-string', 'gatewayPolicy.issuerJwksAuth.jwksBaseUrl=http://keycloak.internal:8080/',
    '--set-string', 'gatewayPolicy.issuerJwksAuth.platformRealm=custom-platform',
    '--set-string', 'gatewayPolicy.issuerJwksAuth.audience=custom-api',
    '--set-string', 'gateway.mongoBearer.tenantAudience=custom-data-api',
    '--set', 'gateway.mongoBearer.enforceTenantAudience=true',
    '--set', 'gatewayPolicy.issuerJwksAuth.cache_ttl=60',
    '--set', 'gatewayPolicy.issuerJwksAuth.cache_max_entries=4',
    '--set', 'gatewayPolicy.issuerJwksAuth.timeout=2',
  ])
  const config = objects.find((object) => object.kind === 'ConfigMap' && object.metadata.name === 'falcone-apisix-standalone')
  const standalone = yamlDocuments(config.data['apisix.yaml'])[0]
  const verifier = route.plugins['issuer-jwks-auth']
  assert.deepEqual(standalone.routes.find((entry) => String(entry.id) === '2006').plugins['issuer-jwks-auth'], verifier)
  assert.deepEqual(standalone.routes.find((entry) => String(entry.id) === '2005-data').plugins['issuer-jwks-auth'], verifier)
  assert.deepEqual(verifier, {
    issuer_base_url: 'https://iam.example.test/auth', jwks_base_url: 'http://keycloak.internal:8080',
    platform_realm: 'custom-platform', audience: 'custom-api', tenant_audience: 'custom-data-api',
    enforce_tenant_audience: true, cache_ttl: 60, cache_max_entries: 4, timeout: 2,
  })
  const env = executorEnv(objects, executor)
  assert.equal(env.KEYCLOAK_ISSUER, `${verifier.issuer_base_url}/realms/custom-platform`)
  assert.equal(env.KEYCLOAK_JWKS_URL, `${verifier.jwks_base_url}/realms/custom-platform/protocol/openid-connect/certs`)
  assert.equal(env.KEYCLOAK_AUDIENCE, verifier.audience)
  assert.equal(env.KEYCLOAK_TENANT_AUDIENCE, verifier.tenant_audience)
  assert.equal(env.KEYCLOAK_ENFORCE_TENANT_AUDIENCE, 'true')
  const policy = objects.find((object) => object.kind === 'ConfigMap' && object.data?.['gateway-policy.json'])
  const policyVerifier = JSON.parse(policy.data['gateway-policy.json']).issuerJwksAuth
  assert.equal(policyVerifier.issuerBaseUrl, verifier.issuer_base_url)
  assert.equal(policyVerifier.jwksBaseUrl, verifier.jwks_base_url)

  const canonical = yamlDocuments(readFileSync(resolve(umbrellaChart, 'files/apisix/standalone/apisix.yaml'), 'utf8'))[0]
  const withoutBearerRoute = (routes) => routes.filter((entry) => !['2006', '2005-data'].includes(String(entry.id)))
  assert.deepEqual(withoutBearerRoute(standalone.routes), withoutBearerRoute(canonical.routes.map((entry) =>
    JSON.parse(JSON.stringify(entry).replaceAll('.falcone.svc.cluster.local', '.falcone-bbx.svc.cluster.local')))))
})

test('all verifier settings are required at render time', () => {
  for (const key of ['issuerBaseUrl', 'jwksBaseUrl', 'platformRealm', 'audience', 'cache_ttl', 'cache_max_entries', 'timeout']) {
    const result = run('helm', ['template', 'falcone-bbx', umbrellaChart,
      '-f', `${umbrellaChart}/values/staging.yaml`, '--set', `gatewayPolicy.issuerJwksAuth.${key}=`])
    assert.notEqual(result.status, 0, `${key} must be required`)
    assert.ok(result.stderr.includes(`issuerJwksAuth.${key} is required`), result.stderr)
  }
  for (const [key, setting] of [['keycloakIssuerBaseUrl', 'issuerBaseUrl'], ['keycloakJwksBaseUrl', 'jwksBaseUrl']]) {
    const result = run('helm', ['template', 'falcone-bbx', umbrellaChart, '--set', `global.${key}=`])
    assert.notEqual(result.status, 0)
    assert.ok(result.stderr.includes(`issuerJwksAuth.${setting} is required`), result.stderr)
  }
})

test('tenant audience configuration rejects empty, absent and invalid settings', () => {
  for (const setting of ['tenantAudience=', 'tenantAudience=null', 'tenantAudience=   ',
    'enforceTenantAudience=null', 'enforceTenantAudience=invalid']) {
    const result = run('helm', ['template', 'falcone-bbx', umbrellaChart,
      '--set', `gateway.mongoBearer.${setting}`])
    assert.notEqual(result.status, 0, `${setting} must fail closed`)
    assert.match(result.stderr, /gateway.*mongoBearer|gateway\.mongoBearer/)
  }
})

test('explicit enforcement off reaches both verifiers without changing the audience', () => {
  const { objects, route, executor } = rendered(['--set', 'gateway.mongoBearer.enforceTenantAudience=false'])
  assert.equal(route.plugins['issuer-jwks-auth'].enforce_tenant_audience, false)
  assert.equal(route.plugins['issuer-jwks-auth'].tenant_audience, 'falcone-data-api')
  assert.equal(executorEnv(objects, executor).KEYCLOAK_ENFORCE_TENANT_AUDIENCE, 'false')
})

test('partial verifier migration rejects an absent configuration block', () => {
  for (const setting of ['gateway=null', 'gatewayPolicy.issuerJwksAuth=null']) {
    const result = run('helm', ['template', 'falcone-bbx', umbrellaChart, '--set', setting])
    assert.notEqual(result.status, 0, `${setting} must fail closed`)
    assert.match(result.stderr, /gateway\.mongoBearer|gatewayPolicy\.issuerJwksAuth/)
  }
})

test('pre-verifier values resolve enforced defaults from the stored OIDC issuer', () => {
  const { objects, route, executor } = rendered([
    '--set', 'gateway=null',
    '--set', 'gatewayPolicy.issuerJwksAuth=null',
    '--set-string', 'gatewayPolicy.oidc.issuerUrl=https://issuer.example.test/realms/platform',
    '--set-string', 'gatewayPolicy.oidc.realm=platform',
  ])
  const verifier = route.plugins['issuer-jwks-auth']
  assert.equal(verifier.issuer_base_url, 'https://issuer.example.test')
  assert.equal(verifier.jwks_base_url, 'http://falcone-bbx-keycloak:8080')
  assert.equal(verifier.platform_realm, 'platform')
  assert.equal(verifier.tenant_audience, 'falcone-data-api')
  assert.equal(verifier.enforce_tenant_audience, true)
  assert.equal(verifier.cache_max_entries, 128)
  assert.equal(verifier.cache_ttl, 300)
  assert.equal(verifier.timeout, 3)
  const env = executorEnv(objects, executor)
  assert.equal(env.KEYCLOAK_ISSUER, 'https://issuer.example.test/realms/platform')
  assert.equal(env.KEYCLOAK_TENANT_AUDIENCE, verifier.tenant_audience)
  assert.equal(env.KEYCLOAK_ENFORCE_TENANT_AUDIENCE, 'true')
})

test('staging standalone routes preserve the recorded pre-980 routes except reviewed Mongo, Postgres and Keycloak repairs', () => {
  const renderedStaging = run('helm', [
    'template', 'falcone', umbrellaChart, '--namespace', 'in-falcone-staging',
    '-f', `${umbrellaChart}/values/staging.yaml`,
  ])
  assert.equal(renderedStaging.status, 0, renderedStaging.stderr)
  const objects = yamlDocuments(renderedStaging.stdout)
  const config = objects.find((object) => object.kind === 'ConfigMap' && object.metadata.name === 'falcone-apisix-standalone')
  assert.ok(config)
  const baseline = readFileSync(resolve(repoRoot, 'tests/blackbox/fixtures/mongo-staging-routes-before-980.yaml'), 'utf8')
  assert.equal(sha256(baseline), '445c3b628e904ece2a1c31b86b141966b87d65fda886cb9be66473cf6afe1bd5',
    'recorded pre-980 staging route fixture changed')
  // The operator reports that the live ConfigMap is this kind route table plus
  // the hand-applied llmwiki route. That live-only route is deliberately absent.
  const canonical = readFileSync(resolve(umbrellaChart, 'files/apisix/standalone/apisix.yaml'), 'utf8')
  const postgresData = canonical.match(/^  - id: "2005-data"\n[\s\S]*?(?=^  - id: "2006"\n)/gm)
  assert.equal(postgresData?.length, 1, 'only one reviewed Postgres data route may be added')
  const withoutPostgresData = canonical.replace(postgresData[0], '')
  const recordedHash = readFileSync(resolve(repoRoot, 'tests/blackbox/fixtures/mongo-staging-routes.sha256'), 'utf8').split(' ')[0]
  const oldComment = '# falls through to the JWT route -> control-plane.'
  const currentComment = '# falls through to the JWT route (Mongo -> executor).'
  const credentialRemoval = '            # API-key credentials must use 2006-key and its per-key bucket.\n            - apikey\n            - x-api-key\n'
  const tenantAudience = '        tenant_audience: "falcone-data-api"\n        enforce_tenant_audience: true\n'
  const oldIdentity = '  - id: "1002"\n    uri: "/auth/*"\n    priority: 90\n    plugins:\n      proxy-rewrite:\n        regex_uri: ["^/auth/(.*)", "/$1"]\n'
  const rootIdentity = '  - id: "1002"\n    uri: "/realms/*"\n    priority: 90\n'
  assert.ok(canonical.includes(credentialRemoval), 'reviewed API-key removal delta must be present')
  assert.ok(canonical.includes(currentComment), 'Mongo upstream comment must match the executor')
  assert.ok(canonical.includes(tenantAudience), 'canonical kind route must enforce the tenant audience')
  assert.equal(canonical.split(rootIdentity).length, 2, 'canonical identity must use root realm paths exactly once')
  assert.equal(baseline.split(oldIdentity).length, 2, 'recorded identity delta must be bounded to route 1002')
  assert.equal(sha256(withoutPostgresData.replace(tenantAudience, '').replace(credentialRemoval, '').replace(currentComment, oldComment)
    .replace(rootIdentity, oldIdentity)), recordedHash,
    'canonical snapshot permits only reviewed Mongo deltas, Postgres data route and root-path Keycloak repair')
  const current = canonical
    .replaceAll('.falcone.svc.cluster.local', '.in-falcone-staging.svc.cluster.local')
    .replaceAll('issuer_base_url: "http://falcone-keycloak:8080"', 'issuer_base_url: "https://iam.baas.musematic.ai"')
    .replaceAll('enforce_tenant_audience: true', 'enforce_tenant_audience: false')
  const route2006 = (routes) => {
    const match = routes.match(/^  - id: "2006"\n[\s\S]*?(?=^  - id: "2007")/m)
    assert.ok(match, 'route 2006 must be bounded by route 2007')
    return match[0]
  }
  const expected = baseline.replace(route2006(baseline), route2006(current)).replace(oldComment, currentComment)
    .replace(oldIdentity, rootIdentity)
    .replace('  - id: "2006"\n', current.match(/^  - id: "2005-data"\n[\s\S]*?(?=^  - id: "2006"\n)/m)[0] + '  - id: "2006"\n')
  assert.notEqual(route2006(baseline), route2006(current), 'route 2006 must change')
  assert.equal(config.data['apisix.yaml'].trim(), expected.trim())
  assert.doesNotMatch(config.data['apisix.yaml'], /llmwiki-s2-mongo-jwt/)
  assert.match(config.data['apisix.yaml'], /falcone-control-plane-executor\.in-falcone-staging\.svc\.cluster\.local:8080/)
})

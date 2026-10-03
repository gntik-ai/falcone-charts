import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'

import {
  assertSuccess,
  combined,
  readYaml,
  repoRoot,
  run,
  umbrellaChart,
  yamlDocuments,
} from '../fixtures/blackbox.mjs'

const release = 'falcone'
const realm = 'in-falcone-platform'
const identityPaths = ['/realms', '/resources', '/js']
const routeArgs = ['-f', resolve(umbrellaChart, 'values/platform-openshift.yaml')]
const profiles = [
  ['default', 'iam.dev.in-falcone.example.com'],
  ['dev', 'iam.dev.in-falcone.example.com'],
  ['sandbox', 'iam.sandbox.in-falcone.example.com'],
  ['staging', 'iam.baas.musematic.ai'],
  ['prod', 'iam.in-falcone.example.com'],
]

function renderProfile(profile, overrides = []) {
  const args = profile === 'default' ? [] : ['-f', resolve(umbrellaChart, `values/${profile}.yaml`)]
  const result = run('helm', [
    'template', release, umbrellaChart, '--namespace', 'falcone-bbx',
    ...args, ...overrides,
  ])
  assertSuccess(result, `identity render (${profile})`)
  return { text: result.stdout, objects: yamlDocuments(result.stdout) }
}

function assertRootKeycloakRoutes(routes, surface) {
  const keycloakRoutes = routes.filter((route) => Object.keys(route.upstream?.nodes ?? {})
    .some((node) => node.split(':')[0].split('.')[0] === `${release}-keycloak`))
  assert.ok(keycloakRoutes.length > 0, `${surface}: Keycloak upstream routes must be present`)
  for (const route of keycloakRoutes) {
    const context = `${surface}: ${route.name ?? route.id}: Keycloak upstream`
    const rewrite = route.plugins?.['proxy-rewrite'] ?? {}
    for (const path of [route.uri, ...(route.uris ?? []), rewrite.uri, ...(rewrite.regex_uri ?? [])]) {
      if (path === undefined) continue
      assert.doesNotMatch(path, /(?:^|\^)\/auth(?:\/|$)/,
        `${context} must not match or rewrite a legacy /auth prefix`)
    }
  }
  const identity = keycloakRoutes.find((route) => route.name === 'identity' || String(route.id) === '1002')
  assert.equal(identity?.uri, '/realms/*', `${surface}: identity route must forward root realm paths`)
  const admin = keycloakRoutes.find((route) => route.name === 'native-keycloak-admin')
  if (admin) {
    assert.deepEqual(admin.plugins['proxy-rewrite'].regex_uri,
      ['^/_native/keycloak/admin/(.*)', '/admin/$1'],
      `${surface}: native admin must rewrite to the root admin API`)
  }
}

function assertRootIdentity({ objects, text }, host) {
  const base = `https://${host}`
  const issuer = `${base}/realms/${realm}`
  const discovery = `${issuer}/.well-known/openid-configuration`
  const jwksBase = `http://${release}-keycloak:8080`
  const keycloak = objects.find((object) => (
    object?.kind === 'Deployment' && object?.metadata?.name === `${release}-keycloak`
  ))
  assert.ok(keycloak, 'identity must have a Keycloak Deployment')
  const container = keycloak.spec.template.spec.containers.find((entry) => entry.name === 'keycloak')
  assert.ok(container, 'Keycloak container must exist')
  assert.doesNotMatch((container.args ?? []).join(' '), /--http-relative-path/)
  assert.ok(!(container.env ?? []).some((entry) => entry.name === 'KC_HTTP_RELATIVE_PATH'),
    'Keycloak must keep serving at root')

  const ingressPaths = objects.filter((object) => object?.kind === 'Ingress')
    .flatMap((object) => object.spec.rules ?? [])
    .filter((rule) => rule.host === host)
    .flatMap((rule) => rule.http.paths)
  const routes = objects.filter((object) => object?.kind === 'Route' && object.spec.host === host)
  assert.equal(ingressPaths.length + routes.length, 3, 'identity must have exactly three public paths')
  assert.deepEqual([...ingressPaths.map((entry) => entry.path), ...routes.map((route) => route.spec.path)],
    identityPaths, 'identity binding paths must be the browser-login and OIDC allowlist')
  for (const path of ingressPaths) {
    assert.equal(path.pathType, 'Prefix')
    assert.deepEqual(path.backend.service, { name: `${release}-keycloak`, port: { name: 'http' } })
  }
  for (const route of routes) {
    assert.deepEqual(route.spec.to, { kind: 'Service', name: `${release}-keycloak` })
    assert.equal(route.spec.port.targetPort, 'http')
    assert.match(route.metadata.name, /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/)
    assert.ok(route.metadata.name.length <= 63)
  }
  assert.equal(new Set(routes.map((route) => route.metadata.name)).size, routes.length)
  const matches = (request) => [
    ...ingressPaths.filter((entry) => request === entry.path || request.startsWith(`${entry.path}/`)),
    ...routes.filter((route) => request.startsWith(route.spec.path)),
  ]
  for (const request of ['/', '/admin', '/admin/x', '/auth/realms/x']) {
    assert.equal(matches(request).length, 0, `${request} must not be routed on the identity host`)
  }
  for (const request of [`/realms/${realm}/.well-known/openid-configuration`, '/resources/x', '/js/keycloak.js']) {
    assert.equal(matches(request).length, 1, `${request} must reach Keycloak on the identity host`)
  }
  if (ingressPaths.length) assert.equal(matches('/realmsX').length, 0, 'Ingress Prefix is segment-aware')
  if (routes.length) assert.equal(matches('/realmsX').length, 1, 'Route uses plain string-prefix matching')

  const runtime = objects.find((object) => object?.kind === 'ConfigMap' && object.data?.oidcIssuerUrl)
  assert.equal(runtime?.data?.oidcIssuerUrl, issuer, 'identity issuer must use the public root')
  assert.equal(runtime?.data?.oidcDiscoveryUrl, discovery, 'identity discovery must use the public root')
  const policyConfig = objects.find((object) => object?.data?.['gateway-policy.json'])
  assert.ok(policyConfig, 'gateway policy must be rendered')
  const policy = JSON.parse(policyConfig.data['gateway-policy.json'])
  assert.equal(policy.oidc.issuerUrl, issuer)
  assert.equal(policy.oidc.discoveryUrl, discovery)
  assert.equal(policy.issuerJwksAuth.issuerBaseUrl, base, 'identity verifier must use the public root')
  assert.equal(policy.issuerJwksAuth.jwksBaseUrl, jwksBase, 'JWKS must keep using the internal root')

  const payload = objects.find((object) => object?.data?.['realm.json'])
  assert.ok(payload, 'bootstrap payload must be rendered')
  let discoveries = 0
  let verifiers = 0
  const bootstrapRoutes = []
  for (const [name, value] of Object.entries(payload.data)) {
    if (!/^route-.*\.json$/.test(name)) continue
    const route = JSON.parse(value)
    bootstrapRoutes.push(route)
    const { plugins = {} } = route
    for (const plugin of ['openid-connect', 'authz-keycloak']) {
      if (!plugins[plugin]) continue
      assert.equal(plugins[plugin].discovery, discovery, `${name}: identity discovery must use the public root`)
      discoveries += 1
    }
    if (plugins['issuer-jwks-auth']) {
      assert.equal(plugins['issuer-jwks-auth'].issuer_base_url, base)
      assert.equal(plugins['issuer-jwks-auth'].jwks_base_url, jwksBase)
      verifiers += 1
    }
  }
  assertRootKeycloakRoutes(bootstrapRoutes, 'bootstrap')
  for (const config of objects.filter((object) => object?.kind === 'ConfigMap' && object.data?.['apisix.yaml'])) {
    assertRootKeycloakRoutes(yamlDocuments(config.data['apisix.yaml'])[0].routes, 'standalone')
  }
  assert.ok(discoveries > 0, 'bootstrap must exercise OIDC discovery')
  assert.ok(verifiers > 0, 'bootstrap must exercise issuer/JWKS verification')
  assert.doesNotMatch(text, /\/auth\/realms/, 'no manifest may advertise the legacy realm path')
}

for (const [profile, host] of profiles) {
  test(`${profile}: identity Ingress, runtime and bootstrap agree on root-path Keycloak`, () => {
    assertRootIdentity(renderProfile(profile), host)
  })

  test(`${profile}: identity Route serves root-path Keycloak`, () => {
    const rendered = renderProfile(profile, routeArgs)
    assertRootIdentity(rendered, host)
    const reordered = renderProfile(profile, [...routeArgs,
      '--set-json', `publicSurface.bindings.identity.paths=${JSON.stringify([...identityPaths].reverse())}`])
    const names = (objects) => Object.fromEntries(objects.filter((object) => object.kind === 'Route'
      && object.spec.host === host).map((route) => [route.spec.path, route.metadata.name]))
    assert.deepEqual(names(reordered.objects), names(rendered.objects), 'Route names must survive path reordering')
  })

  for (const [exposure, exposureArgs] of [['Ingress', []], ['Route', routeArgs]]) {
    test(`${profile}: ${exposure} rejects unsafe identity path overrides at render time`, () => {
      const profileArgs = profile === 'default' ? [] : ['-f', resolve(umbrellaChart, `values/${profile}.yaml`)]
      for (const paths of [['/'], ['/admin'], ['/admin/x'], ['/realms', '/admin/x'], ['/auth'], ['/authx']]) {
        const result = run('helm', ['template', release, umbrellaChart, ...profileArgs, ...exposureArgs,
          '--set-json', `publicSurface.bindings.identity.paths=${JSON.stringify(paths)}`])
        assert.notEqual(result.status, 0, `${profile}/${exposure}: unsafe paths ${paths} must fail`)
        assert.match(combined(result), /publicSurface\.bindings\.identity/)
      }
      const legacy = run('helm', ['template', release, umbrellaChart, ...profileArgs, ...exposureArgs,
        '--set', 'publicSurface.bindings.identity.paths=null',
        '--set-string', 'publicSurface.bindings.identity.path=/'])
      assert.notEqual(legacy.status, 0, 'stale scalar root binding must fail closed')
      assert.match(combined(legacy), /publicSurface\.bindings\.identity/)
    })
  }
}

test('optional paths replace path, preserve single-path Route names and support bindings without path', () => {
  const args = [...routeArgs, '--set', 'publicSurface.bindings.api.path=null',
    '--set-json', 'publicSurface.bindings.api.paths=["/control-plane"]',
    '--set-string', 'publicSurface.bindings.identity.path=/admin',
    '--set-json', 'publicSurface.bindings.identity.paths=["/realms"]']
  const { objects } = renderProfile('default', args)
  const routes = objects.filter((object) => object.kind === 'Route')
  assert.equal(routes.find((route) => route.spec.host === profiles[0][1]).metadata.name,
    'falcone-in-falcone-identity')
  assert.equal(routes.find((route) => route.spec.host === 'api.dev.in-falcone.example.com').metadata.name,
    'falcone-in-falcone-api')
  const scalar = renderProfile('default', [...routeArgs,
    '--set', 'publicSurface.bindings.identity.paths=null',
    '--set-string', 'publicSurface.bindings.identity.path=/realms'])
  assert.deepEqual(scalar.objects.filter((object) => object.kind === 'Route'), routes,
    'equivalent scalar and one-element list bindings must render identically')
})

test('multi-path Route names remain DNS-1123 valid with a long release fullname', () => {
  const { objects } = renderProfile('default', [...routeArgs,
    '--set-string', `fullnameOverride=${'a'.repeat(63)}`])
  const routes = objects.filter((object) => object.kind === 'Route' && object.spec.host === profiles[0][1])
  assert.equal(routes.length, 3)
  assert.equal(new Set(routes.map((route) => route.metadata.name)).size, 3)
  for (const route of routes) {
    assert.match(route.metadata.name, /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/)
    assert.ok(route.metadata.name.length <= 63)
  }
})

test('the binding schema rejects missing paths, empty lists, duplicates and relative paths', () => {
  for (const args of [
    ['--set', 'publicSurface.bindings.identity.paths=null'],
    ['--set-json', 'publicSurface.bindings.identity.paths=[]'],
    ['--set-json', 'publicSurface.bindings.identity.paths=["/realms","/realms"]'],
    ['--set-json', 'publicSurface.bindings.identity.paths=["realms"]'],
  ]) {
    const result = run('helm', ['template', release, umbrellaChart, ...args])
    assert.notEqual(result.status, 0, 'invalid identity path shape must fail schema validation')
    assert.match(combined(result), /publicSurface[./]bindings[./]identity/)
  }
})

test('another Keycloak-backed binding cannot expose the admin console', () => {
  for (const args of [
    ['--set-string', 'publicSurface.bindings.api.component=keycloak'],
    ['--set-string', 'publicSurface.bindings.api.serviceName=falcone-keycloak'],
  ]) {
    const result = run('helm', ['template', release, umbrellaChart, ...args,
      '--set-string', 'publicSurface.bindings.api.path=/admin/x'])
    assert.notEqual(result.status, 0)
    assert.match(combined(result), /publicSurface\.bindings\.api/)
  }
})

test('chart values and flows e2e keep the root identity binding without legacy realm URLs', () => {
  const defaults = readYaml(resolve(umbrellaChart, 'values.yaml'))
  const e2e = readYaml(resolve(repoRoot, 'tests/e2e/values-flows-e2e.yaml'))
  assert.equal(defaults.publicSurface.routePrefixes.identity, '/')
  assert.deepEqual(defaults.publicSurface.bindings.identity.paths, identityPaths)
  assert.equal(defaults.publicSurface.bindings.identity.path, undefined)
  assert.equal(e2e.publicSurface.bindings.identity.path, '/')
  assert.equal(defaults.keycloak.config?.inline?.publicPath, undefined)
  const standalone = readYaml(resolve(umbrellaChart, 'files/apisix/standalone/apisix.yaml'))
  assertRootKeycloakRoutes(standalone.routes, 'canonical standalone')
  for (const [profile] of profiles) {
    const values = profile === 'default' ? defaults : readYaml(resolve(umbrellaChart, `values/${profile}.yaml`))
    assert.doesNotMatch(JSON.stringify(values), /\/auth\/realms/)
  }
})

for (const [name, setting, diagnostic] of [
  ['issuer', `gatewayPolicy.oidc.issuerUrl=https://iam.dev.in-falcone.example.com/auth/realms/${realm}`, /identity issuer/],
  ['discovery', `gatewayPolicy.oidc.discoveryUrl=https://iam.dev.in-falcone.example.com/auth/realms/${realm}/.well-known/openid-configuration`, /identity discovery/],
  ['verifier', 'global.keycloakIssuerBaseUrl=https://iam.dev.in-falcone.example.com/auth', /identity verifier/],
]) {
  test(`consistency contract rejects a legacy /auth ${name} override`, () => {
    const overrides = ['--set-string', setting]
    if (name === 'Route binding') overrides.push(...routeArgs)
    const rendered = renderProfile('default', overrides)
    assert.throws(() => assertRootIdentity(rendered, profiles[0][1]), diagnostic)
  })
}

for (const [name, change] of [
  ['route match', (route) => { route.uri = '/auth/*' }],
  ['direct rewrite', (route) => { route.plugins = { 'proxy-rewrite': { uri: '/auth/realms' } } }],
  ['admin rewrite', (route) => { route.plugins['proxy-rewrite'].regex_uri[1] = '/auth/admin/$1' }],
]) {
  test(`consistency contract rejects a legacy /auth Keycloak upstream ${name}`, () => {
    const routes = readYaml(resolve(umbrellaChart, 'values.yaml')).bootstrap.reconcile.apisix.routes
    const target = routes.find((route) => route.name === (name === 'admin rewrite' ? 'native-keycloak-admin' : 'identity'))
    change(target)
    const rendered = renderProfile('default', [
      '--set-json', `bootstrap.reconcile.apisix.routes=${JSON.stringify(routes)}`,
    ])
    assert.throws(() => assertRootIdentity(rendered, profiles[0][1]), /Keycloak upstream must not match or rewrite/)
  })
}

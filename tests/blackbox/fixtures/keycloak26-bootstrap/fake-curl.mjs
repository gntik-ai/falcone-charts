#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const scenario = process.env.FALCONE_BBX_KEYCLOAK_SCENARIO ?? 'success'
const logFile = process.env.FALCONE_BBX_CURL_LOG
const traceFile = process.env.FALCONE_BBX_TRACE_LOG
const secretBody = '{"error":"bbx-sensitive-provider-body-must-not-escape"}'

function option(name) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

const url = [...args].reverse().find((value) => /^https?:\/\//.test(value)) ?? ''
const output = option('-o')
const dataArgument = option('--data')
const explicitMethod = option('-X')
const method = explicitMethod ?? (url.includes('/protocol/openid-connect/token') ? 'POST' : 'GET')

const call = {
  dataFile: dataArgument?.startsWith('@') ? dataArgument.slice(1) : null,
  method,
  output: output ?? null,
  url,
}
appendFileSync(logFile, `${JSON.stringify(call)}\n`)
appendFileSync(traceFile, `${JSON.stringify({ source: 'curl', ...call })}\n`)

function respond(status, body = '') {
  appendFileSync(traceFile, `${JSON.stringify({ source: 'curl-response', method, status, url })}\n`)
  if (output && output !== '/dev/null') writeFileSync(output, body)
  if (!output && body) process.stdout.write(body)
  if (args.includes('-w')) process.stdout.write(String(status))
  process.exit(0)
}

if (url.endsWith('/realms/master/protocol/openid-connect/token')) {
  respond(200, '{"access_token":"bbx-process-isolated-admin-token"}')
}

const realmUrl = /\/admin\/realms\/in-falcone-platform$/
const realmCollectionUrl = /\/admin\/realms$/

if (
  scenario.startsWith('fresh-')
  && method === 'GET'
  && realmUrl.test(url)
  && output === '/tmp/keycloak-realm-check'
) {
  if (scenario === 'fresh-get-transport-failure') {
    process.stderr.write('curl: (7) process-isolated Keycloak connection refused\n')
    process.exit(7)
  }
  if (scenario === 'fresh-get-http-failure') respond(503, secretBody)
  respond(404, '{"error":"realm-not-found"}')
}

if (scenario.startsWith('fresh-') && method === 'POST' && realmCollectionUrl.test(url)) {
  if (scenario === 'fresh-create-transport-failure') {
    process.stderr.write('curl: (7) process-isolated Keycloak connection refused\n')
    process.exit(7)
  }
  if (scenario === 'fresh-create-http-failure') respond(400, secretBody)
  if (scenario === 'fresh-create-409') respond(409, '{"error":"realm-created-concurrently"}')
  respond(201, '')
}

if (method === 'PUT' && realmUrl.test(url) && dataArgument === '@/bootstrap/payload/login.json') {
  if (scenario === 'put-failure') respond(400, secretBody)
  respond(204, '')
}

if (method === 'GET' && realmUrl.test(url) && output === '/tmp/keycloak-login-readback') {
  if (scenario === 'get-failure') respond(503, secretBody)
  const desired = JSON.parse(readFileSync('/bootstrap/payload/login.json', 'utf8'))
  if (scenario === 'drift') desired.rememberMe = !desired.rememberMe
  respond(200, JSON.stringify(desired))
}

if (method === 'GET' && realmUrl.test(url)) respond(200, '{"realm":"in-falcone-platform"}')

if (method === 'PUT' && url.endsWith('/users/profile')) respond(200, '')

if (method === 'PUT' && realmUrl.test(url) && dataArgument === '@/bootstrap/payload/brute-force.json') {
  respond(204, '')
}

if (method === 'GET' && /\/roles\/[^/]+$/.test(url) && output === '/tmp/keycloak-role-check') {
  respond(200, '{"id":"bbx-role-id"}')
}

if (method === 'GET' && url.endsWith('/roles/superadmin')) {
  respond(200, '{"id":"bbx-superadmin-role-id","name":"superadmin"}')
}

if (method === 'GET' && url.endsWith('/client-scopes')) {
  respond(200, '[{"id":"scope-roles","name":"roles"},{"id":"scope-basic","name":"basic"},{"id":"scope-profile","name":"profile"},{"id":"scope-tenant","name":"tenant-context"},{"id":"scope-workspace","name":"workspace-context"},{"id":"scope-plan","name":"plan-context"},{"id":"scope-workspace-roles","name":"workspace-roles"}]')
}

if (method === 'GET' && url.includes('/clients?clientId=')) {
  const clientId = new URL(url).searchParams.get('clientId')
  respond(200, JSON.stringify([{ id: `client-${clientId}`, clientId }]))
}

if (method === 'PUT' && /\/clients\/[^/]+\/default-client-scopes\/[^/]+$/.test(url)) {
  respond(204, '')
}

if (method === 'GET' && url.includes('/users?username=superadmin&exact=true')) {
  respond(200, '[{"id":"user-superadmin","username":"superadmin"}]')
}

if (method === 'PUT' && /\/users\/user-superadmin(?:\/reset-password)?$/.test(url)) {
  respond(204, '')
}

if (method === 'POST' && url.endsWith('/users/user-superadmin/role-mappings/realm')) {
  respond(204, '')
}

process.stderr.write(`[bbx fake curl] unsupported public request: ${method} ${url}\n`)
process.exit(64)

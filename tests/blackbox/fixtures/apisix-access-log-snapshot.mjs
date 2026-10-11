import assert from 'node:assert/strict'

// Preserve the approved historical hashes by subtracting only #1118's exact
// access-log addition. All other gateway and resource changes remain hashed.
const accessLogFormat = '$remote_addr - $remote_user [$time_local] $http_host "$request_method $uri $server_protocol" $status $body_bytes_sent $request_time "$http_referer" "$http_user_agent" $upstream_addr $upstream_status $upstream_response_time "$upstream_scheme://$upstream_host$uri"'
const accessLogBlock = `nginx_config:\n  http:\n    access_log_format: ${JSON.stringify(accessLogFormat)}\n`

export function withPriorApisixAccessLog(objects) {
  const prior = structuredClone(objects)
  const configs = prior.filter((object) => object.kind === 'ConfigMap'
    && object.metadata.name === 'falcone-bbx-apisix-config-file')
  assert.equal(configs.length, 1, 'the APISIX configuration must remain present exactly once')
  const config = configs[0]
  assert.ok(config.data['config.yaml'].includes(accessLogBlock),
    'APISIX must retain the exact reviewed query-free access-log addition')
  config.data['config.yaml'] = config.data['config.yaml'].replace(accessLogBlock, '')
  return prior
}

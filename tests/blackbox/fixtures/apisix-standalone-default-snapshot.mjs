import assert from 'node:assert/strict'
import { sha256 } from './blackbox.mjs'

// falcone-charts#22: subtract only the exact reviewed default-route additions.
// The payload fingerprint includes all routes and whitespace from the existing template.
const routeDigest = '11ea9eb7b172411db06e424bfe99d99cc5689d9161f32f4ee943dc245afda8c5'
const volume = { name: 'standalone-config', configMap: { name: 'falcone-apisix-standalone', defaultMode: 420 } }
const mount = { name: 'standalone-config', mountPath: '/usr/local/apisix/conf/apisix.yaml', subPath: 'apisix.yaml' }

export function withPriorApisixStandaloneDefault(objects) {
  const prior = structuredClone(objects)
  const configs = prior.filter((object) => object.kind === 'ConfigMap' && object.metadata.name === 'falcone-apisix-standalone')
  assert.equal(configs.length, 1, 'the reviewed standalone ConfigMap must exist exactly once')
  const config = configs[0]
  assert.deepEqual(config, {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name: 'falcone-apisix-standalone',
      labels: {
        'helm.sh/chart': 'in-falcone-0.4.19',
        'app.kubernetes.io/name': 'in-falcone',
        'app.kubernetes.io/instance': 'falcone-bbx',
        'app.kubernetes.io/managed-by': 'Helm',
        'app.kubernetes.io/part-of': 'in-falcone',
        'in-falcone.io/component': 'apisix',
      },
    },
    data: { 'apisix.yaml': config.data?.['apisix.yaml'] },
  })
  assert.equal(sha256(config.data['apisix.yaml']), routeDigest, 'the complete standalone route payload must remain reviewed')

  const deployments = prior.filter((object) => object.kind === 'Deployment' && object.metadata.name === 'falcone-bbx-apisix')
  assert.equal(deployments.length, 1)
  const pod = deployments[0].spec.template.spec
  assert.deepEqual(pod.volumes.filter((entry) => entry.name === volume.name), [volume])
  assert.deepEqual(pod.volumes[0], volume, 'subtract only the reviewed volume prefix')
  pod.volumes = pod.volumes.slice(1)
  const containers = pod.containers.filter((container) => container.name === 'apisix')
  assert.equal(containers.length, 1)
  assert.deepEqual(containers[0].volumeMounts.filter((entry) => entry.name === mount.name || entry.mountPath === mount.mountPath), [mount])
  assert.deepEqual(containers[0].volumeMounts[0], mount, 'subtract only the reviewed mount prefix')
  containers[0].volumeMounts = containers[0].volumeMounts.slice(1)
  return prior.filter((object) => object !== config)
}

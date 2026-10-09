import assert from 'node:assert/strict'

import { allContainers } from './blackbox.mjs'

// Check the exact #975 additions before restoring the immutable umbrella baseline.
// Any other resource or workload change remains covered by the existing hashes.
export function withPriorInvitationHmac(objects) {
  const prior = structuredClone(objects)
  const externals = prior.filter((object) => object.kind === 'ExternalSecret'
    && object.metadata.name === 'iam-invitation-email-hmac')
  assert.equal(externals.length, 1, 'invitation HMAC delivery must exist exactly once')
  assert.deepEqual(externals[0], {
    apiVersion: 'external-secrets.io/v1beta1',
    kind: 'ExternalSecret',
    metadata: {
      name: 'iam-invitation-email-hmac',
      namespace: 'falcone-bbx',
      annotations: { 'helm.sh/hook': 'post-install,post-upgrade', 'helm.sh/hook-weight': '5' },
    },
    spec: {
      refreshInterval: '1h',
      secretStoreRef: { name: 'openbao-backend', kind: 'ClusterSecretStore' },
      target: {
        name: 'in-falcone-invitation-email-hmac',
        creationPolicy: 'Orphan', deletionPolicy: 'Retain', immutable: false,
      },
      data: [
        { secretKey: 'key', remoteRef: { key: 'iam/invitation-email-hmac', property: 'key' } },
        { secretKey: 'key-id', remoteRef: { key: 'iam/invitation-email-hmac', property: 'key-id' } },
      ],
    },
  })
  const expectedEnv = [
    { name: 'INVITATION_EMAIL_HMAC_KEY', valueFrom: {
      secretKeyRef: { name: 'in-falcone-invitation-email-hmac', key: 'key', optional: true },
    } },
    { name: 'INVITATION_EMAIL_HMAC_KEY_ID', valueFrom: {
      secretKeyRef: { name: 'in-falcone-invitation-email-hmac', key: 'key-id', optional: true },
    } },
  ]
  let recipients = 0
  for (const { object, container } of allContainers(prior)) {
    const invitationEnv = (container.env ?? []).filter((entry) => entry.name.startsWith('INVITATION_EMAIL_HMAC_'))
    if (object.kind === 'Deployment' && object.metadata.name === 'falcone-bbx-control-plane'
      && container.name === 'control-plane') {
      recipients++
      assert.deepEqual(invitationEnv, expectedEnv)
      assert.deepEqual(container.env.slice(0, 2), expectedEnv, 'only the reviewed env prefix is subtracted')
      container.env = container.env.slice(2)
    } else {
      assert.deepEqual(invitationEnv, [], `${object.metadata.name}/${container.name} must not receive invitation keys`)
    }
  }
  assert.equal(recipients, 1, 'only control-plane receives invitation HMAC references')
  return prior.filter((object) => object !== externals[0])
}

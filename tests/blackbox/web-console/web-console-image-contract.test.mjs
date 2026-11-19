import assert from 'node:assert/strict'
import test from 'node:test'

import { render, umbrellaChart } from '../fixtures/blackbox.mjs'

function webConsoleImage(args) {
  const { objects } = render(umbrellaChart, args)
  const deployments = objects.filter(object => object.kind === 'Deployment'
    && object.metadata.name === 'falcone-bbx-web-console')
  assert.equal(deployments.length, 1, 'the webConsole key must render one web-console Deployment')
  const containers = deployments[0].spec.template.spec.containers
    .filter(container => container.name === 'web-console')
  assert.equal(containers.length, 1, 'the Deployment must contain one web-console container')
  return containers[0].image
}

test('webConsole.image renders a digest reference even when a tag is also supplied', () => {
  const image = webConsoleImage([
    '--set-string', 'webConsole.image.digest=sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    '--set-string', 'webConsole.image.tag=contract-tag',
  ])
  assert.equal(image,
    'ghcr.io/gntik-ai/in-falcone-web-console@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef')
})

test('webConsole.image renders a tag reference when the digest key is absent', () => {
  const image = webConsoleImage(['--set-string', 'webConsole.image.tag=contract-tag'])
  assert.equal(image, 'ghcr.io/gntik-ai/in-falcone-web-console:contract-tag')
})

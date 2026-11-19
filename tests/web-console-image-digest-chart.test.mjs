import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import test from 'node:test';

// The switch release of the web-console-next cutover is rolled back by redeploying the prior chart together with
// the prior image DIGEST, while staging keeps following the newest tag. The component wrapper must therefore render
// repository@digest when webConsole.image.digest is set and repository:tag otherwise, under the unchanged webConsole key.
const chart = 'charts/in-falcone';
const repository = 'ghcr.io/gntik-ai/in-falcone-web-console';
// The recorded prior (rollback) image of the cutover: tag sha-ca5183d, single-platform OCI manifest.
const priorDigest = 'sha256:77e614f1a084b2ada754bccfab37c6018ffed5302078e87c89c055dd8c80dd5a';

function render(args = []) {
  const result = spawnSync('helm', ['template', 'bbx', chart, ...args], {encoding: 'utf8', maxBuffer: 64 * 1024 * 1024});
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

// The webConsole block of values.yaml, read without a YAML dependency: its image repository and tag, and whether it sets a digest.
function webConsoleValues() {
  const source = readFileSync(`${chart}/values.yaml`, 'utf8');
  const block = source.match(/^webConsole:\n((?:[ \t]+.*\n|\n)+)/m);
  assert.ok(block, 'the webConsole key stays');
  const image = block[1].match(/^  image:\n((?:    .*\n)+)/m);
  assert.ok(image, 'webConsole.image stays');
  const field = (name) => image[1].match(new RegExp(`^    ${name}: (\\S+)$`, 'm'))?.[1];
  return {repository: field('repository'), tag: field('tag'), digest: field('digest'), componentId: block[1].match(/^    componentId: (\S+)$/m)?.[1]};
}

function webConsoleImages(manifest) {
  return [...manifest.matchAll(/^\s*image:\s*"?([^"\s]*in-falcone-web-console[^"\s]*)"?\s*$/gm)].map((match) => match[1]);
}

test('a tag-only webConsole.image still renders repository:tag', () => {
  const {tag} = webConsoleValues();
  assert.match(tag, /^\S+$/);
  assert.deepEqual(webConsoleImages(render()), [`${repository}:${tag}`]);
  assert.deepEqual(webConsoleImages(render(['--set-string', 'webConsole.image.tag=sha-ca5183d'])), [`${repository}:sha-ca5183d`]);
});

test('a digest-pinned webConsole.image renders repository@sha256 and not the tag', () => {
  const images = webConsoleImages(render(['--set-string', `webConsole.image.digest=${priorDigest}`]));
  assert.deepEqual(images, [`${repository}@${priorDigest}`]);
  // The digest wins over a tag that is also set, as the Argo CD ImageUpdater keeps moving the tag on staging.
  const both = webConsoleImages(render(['--set-string', 'webConsole.image.tag=sha-ca5183d', '--set-string', `webConsole.image.digest=${priorDigest}`]));
  assert.deepEqual(both, [`${repository}@${priorDigest}`]);
});

test('the webConsole values key and image repository are unchanged and no digest is committed by default', () => {
  const values = webConsoleValues();
  assert.equal(values.repository, repository);
  assert.equal(values.digest, undefined, 'the switch-release digest is recorded by the operator after publication, never guessed');
  assert.equal(values.componentId, 'web-console');
});

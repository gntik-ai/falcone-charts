import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import test from 'node:test';

// Contract for the web-console image pin (falcone #1304): the chart key stays `webConsole`, a tag-only value still
// renders repository:tag, and a digest-pinned value renders repository@sha256 (component-wrapper _helpers.tpl).
// The switch-release digest does not exist until release-images builds the cutover commit, so it is never committed
// here; the digests below are fixtures.
const chart = 'charts/in-falcone';
const repository = 'ghcr.io/gntik-ai/in-falcone-web-console';
const priorDigest = 'sha256:77e614f1a084b2ada754bccfab37c6018ffed5302078e87c89c055dd8c80dd5a';

// The webConsole block of values.yaml, read as text so the test needs no YAML dependency: from the top-level key to the
// next top-level key.
const valuesText = readFileSync(`${chart}/values.yaml`, 'utf8');
const start = valuesText.indexOf('\nwebConsole:\n');
assert.notEqual(start, -1, 'values.yaml keeps the top-level webConsole key');
const block = valuesText.slice(start + 1).split(/\n(?=[A-Za-z])/, 1)[0];
const imageBlock = block.match(/\n  image:\n((?:    .*\n?)+)/)[1];
const field = (name) => imageBlock.match(new RegExp(`^    ${name}:\\s*(.*?)\\s*$`, 'm'))?.[1];
const values = {webConsole: {image: {repository: field('repository'), tag: field('tag'), digest: field('digest')}, componentId: block.match(/componentId:\s*(\S+)/)[1]}};

function render(args = []) {
  const result = spawnSync('helm', ['template', 'bbx', chart, ...args], {encoding: 'utf8', maxBuffer: 64 * 1024 * 1024});
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

// The images of the web-console workload: the Deployment whose container image mentions the console repository.
function consoleImages(manifest) {
  return [...manifest.matchAll(/^\s*image:\s*"?([^"\s]*in-falcone-web-console[^"\s]*)"?\s*$/gm)].map((match) => match[1]);
}

test('the chart key stays webConsole and points at the web-console image repository', () => {
  assert.equal(values.webConsole.image.repository, repository);
  assert.equal(values.webConsole.componentId, 'web-console');
  assert.match(String(values.webConsole.image.tag), /^[0-9A-Za-z][0-9A-Za-z._-]*$/);
  assert.ok(!values.webConsole.image.digest, 'no digest is committed before the switch release is published');
});

test('a tag-only webConsole.image still renders repository:tag', () => {
  assert.deepEqual(consoleImages(render()), [`${repository}:${values.webConsole.image.tag}`]);
  assert.deepEqual(consoleImages(render(['--set-string', 'webConsole.image.tag=sha-ca5183d'])), [`${repository}:sha-ca5183d`]);
});

test('a digest-pinned webConsole.image renders repository@sha256 and drops the tag', () => {
  const images = consoleImages(render(['--set-string', `webConsole.image.digest=${priorDigest}`]));
  assert.deepEqual(images, [`${repository}@${priorDigest}`]);
  const tagged = consoleImages(render(['--set-string', 'webConsole.image.tag=sha-ca5183d', '--set-string', `webConsole.image.digest=${priorDigest}`]));
  assert.deepEqual(tagged, [`${repository}@${priorDigest}`], 'the digest wins over the tag');
});

test('a malformed digest is rejected before it can render', () => {
  for (const digest of ['sha256:abc', 'sha256:' + 'A'.repeat(64), 'md5:' + 'a'.repeat(32)]) {
    const result = spawnSync('helm', ['template', 'bbx', chart, '--set-string', `webConsole.image.digest=${digest}`], {encoding: 'utf8', maxBuffer: 64 * 1024 * 1024});
    assert.notEqual(result.status, 0, `${digest} must be rejected`);
    assert.match(`${result.stderr}${result.stdout}`, /schema|digest/i);
  }
});

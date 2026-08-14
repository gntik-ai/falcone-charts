#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'oci');
const images = [
  { basename: 'temporalio-server-1.31.1', repository: 'temporalio/server' },
  { basename: 'temporalio-admin-tools-1.31.1', repository: 'temporalio/admin-tools' },
  { basename: 'temporalio-ui-2.51.0', repository: 'temporalio/ui' },
];

function fail(message) {
  process.stderr.write(`prefetch-offline-evidence: ${message}\n`);
  process.exit(1);
}

function sha256(buffer) {
  return `sha256:${createHash('sha256').update(buffer).digest('hex')}`;
}

function sha256File(target) {
  const hash = createHash('sha256');
  const descriptor = fs.openSync(target, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return `sha256:${hash.digest('hex')}`;
}

function readEvidence(basename, kind) {
  const target = path.join(fixtureDir, `${basename}.${kind}.json.b64`);
  const raw = Buffer.from(fs.readFileSync(target, 'utf8').trim(), 'base64');
  let document;
  try {
    document = JSON.parse(raw.toString('utf8'));
  } catch {
    fail(`${path.basename(target)} is not valid base64-encoded JSON`);
  }
  return { raw, document };
}

function assertDescriptor(descriptor, label) {
  if (!descriptor || typeof descriptor !== 'object') fail(`${label} descriptor is missing`);
  if (!/^sha256:[0-9a-f]{64}$/.test(descriptor.digest ?? '')) {
    fail(`${label} has an invalid digest`);
  }
  if (!Number.isSafeInteger(descriptor.size) || descriptor.size <= 0) {
    fail(`${label} has an invalid size`);
  }
}

function verifyFile(target, descriptor, label) {
  let stat;
  try {
    stat = fs.statSync(target);
  } catch (error) {
    fail(`${label} is unavailable: ${error.message}`);
  }
  if (!stat.isFile()) fail(`${label} is not a regular file`);
  if (stat.size !== descriptor.size) {
    fail(`${label} size mismatch: expected ${descriptor.size}, received ${stat.size}`);
  }
  const actualDigest = sha256File(target);
  if (actualDigest !== descriptor.digest) {
    fail(`${label} digest mismatch: expected ${descriptor.digest}, received ${actualDigest}`);
  }
}

function curl(args, label) {
  const result = spawnSync('curl', ['-fsSL', '--retry', '3', '--retry-all-errors', ...args], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) {
    fail(`${label} failed${result.stderr ? `: ${result.stderr.trim()}` : ''}`);
  }
  return result.stdout;
}

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--oci-cache' || !args[1]) {
  fail('usage: prefetch-offline-evidence.mjs --oci-cache ABSOLUTE_DIRECTORY');
}
if (!path.isAbsolute(args[1])) fail('--oci-cache must be an absolute path');
fs.mkdirSync(args[1], { recursive: true, mode: 0o755 });
const cacheDir = fs.realpathSync(args[1]);
if (cacheDir !== path.resolve(args[1])) fail('--oci-cache must resolve to its canonical path');
if (!fs.statSync(cacheDir).isDirectory()) fail('--oci-cache must be a directory');

let downloaded = 0;
let reused = 0;
const seen = new Map();
for (const image of images) {
  const index = readEvidence(image.basename, 'index');
  const manifests = index.document.manifests?.filter((candidate) =>
    candidate.platform?.os === 'linux' && candidate.platform?.architecture === 'amd64') ?? [];
  if (manifests.length !== 1) fail(`${image.basename} must select exactly one linux/amd64 manifest`);
  const manifestDescriptor = manifests[0];
  assertDescriptor(manifestDescriptor, `${image.basename} linux/amd64 manifest`);

  const manifest = readEvidence(image.basename, 'manifest');
  if (sha256(manifest.raw) !== manifestDescriptor.digest
      || manifest.raw.length !== manifestDescriptor.size) {
    fail(`${image.basename} manifest fixture does not match its index descriptor`);
  }
  assertDescriptor(manifest.document.config, `${image.basename} config`);
  const config = readEvidence(image.basename, 'config');
  if (sha256(config.raw) !== manifest.document.config.digest
      || config.raw.length !== manifest.document.config.size) {
    fail(`${image.basename} config fixture does not match its manifest descriptor`);
  }

  const layers = manifest.document.layers ?? [];
  if (layers.length === 0) fail(`${image.basename} manifest has no layers`);
  for (const layer of layers) assertDescriptor(layer, `${image.basename} layer`);

  const missing = layers.filter((layer) => {
    if (seen.has(layer.digest)) {
      if (seen.get(layer.digest) !== layer.size) {
        fail(`${layer.digest} has inconsistent sizes across image manifests`);
      }
      return false;
    }
    seen.set(layer.digest, layer.size);
    const target = path.join(cacheDir, `${layer.digest.slice('sha256:'.length)}.tar.gz`);
    if (!fs.existsSync(target)) return true;
    verifyFile(target, layer, `${image.basename} cached layer ${layer.digest}`);
    reused += 1;
    return false;
  });
  if (missing.length === 0) continue;

  let token;
  try {
    const rawToken = curl([
      `https://auth.docker.io/token?service=registry.docker.io&scope=${encodeURIComponent(`repository:${image.repository}:pull`)}`,
    ], `${image.basename} registry authentication`);
    token = JSON.parse(rawToken).token;
  } catch {
    fail(`${image.basename} registry authentication returned invalid JSON`);
  }
  if (typeof token !== 'string' || token.length === 0) {
    fail(`${image.basename} registry authentication returned no token`);
  }

  for (const layer of missing) {
    const basename = `${layer.digest.slice('sha256:'.length)}.tar.gz`;
    const target = path.join(cacheDir, basename);
    const temporary = path.join(
      cacheDir,
      `.${basename}.${process.pid}.${randomBytes(8).toString('hex')}.download`,
    );
    try {
      curl([
        '-H', `Authorization: Bearer ${token}`,
        '-o', temporary,
        `https://registry-1.docker.io/v2/${image.repository}/blobs/${layer.digest}`,
      ], `${image.basename} layer ${layer.digest} download`);
      verifyFile(temporary, layer, `${image.basename} downloaded layer ${layer.digest}`);
      fs.renameSync(temporary, target);
      verifyFile(target, layer, `${image.basename} cached layer ${layer.digest}`);
      downloaded += 1;
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }
}

process.stdout.write(
  `Prefetched ${downloaded} and reused ${reused} digest-bound OCI layer blob(s) in ${cacheDir}\n`,
);

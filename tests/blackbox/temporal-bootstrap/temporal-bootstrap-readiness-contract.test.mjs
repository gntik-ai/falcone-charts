import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import { parseAllDocuments, stringify } from 'yaml';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '../../..');
const chartDir = path.join(repoRoot, 'charts/in-falcone');
const releaseName = 'temporal-readiness-bbx';
const releaseNamespace = 'temporal-readiness-bbx';

function renderChartResult({
  upgrade = false,
  release = releaseName,
  extraArgs = [],
} = {}) {
  const args = [
    'template',
    release,
    chartDir,
    '--namespace',
    releaseNamespace,
  ];
  if (upgrade) {
    args.push(
      '--is-upgrade',
      '--set', 'deployment.upgrade.currentVersion=0.3.1',
      '--set', 'global.webhookDatabase.migration.backupVerified=true',
      '--set', 'global.webhookDatabase.migration.parityVerified=true',
      '--set-string', 'global.webhookDatabase.migration.backupReference=bbx-temporal-backup',
    );
  }
  args.push(...extraArgs);

  return spawnSync('helm', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
}

function renderChart(options = {}) {
  const result = renderChartResult(options);
  assert.equal(
    result.status,
    0,
    `helm ${options.upgrade ? 'upgrade' : 'install'} render failed:\n${result.stderr}`,
  );
  return parseAllDocuments(result.stdout)
    .map((document) => document.toJS())
    .filter(Boolean);
}

function parseRenderedDocuments(output) {
  return parseAllDocuments(output)
    .map((document) => document.toJS())
    .filter(Boolean);
}

function materializeKubeconformSchemaLocation(cache) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'falcone-kubeconform-schemas-bbx-'),
  );
  let schemas = 0;
  for (const entry of fs.readdirSync(cache, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const source = path.join(cache, entry.name);
    let schema;
    assert.doesNotThrow(() => {
      schema = JSON.parse(fs.readFileSync(source, 'utf8'));
    }, `kubeconform cache entry ${entry.name} must be valid JSON`);
    const gvks = schema?.['x-kubernetes-group-version-kind'];
    assert.ok(
      Array.isArray(gvks) && gvks.length > 0,
      `kubeconform cache entry ${entry.name} must declare a public Kubernetes GVK`,
    );
    for (const gvk of gvks) {
      assert.match(gvk.kind ?? '', /^[A-Za-z][A-Za-z0-9]*$/);
      assert.match(gvk.version ?? '', /^v[0-9][A-Za-z0-9]*$/);
      assert.match(gvk.group ?? '', /^(?:[a-z0-9.-]+)?$/);
      const group = gvk.group ? `${gvk.group.split('.')[0]}-` : '';
      const target = path.join(
        directory,
        `${gvk.kind.toLowerCase()}-${group}${gvk.version}.json`,
      );
      if (fs.existsSync(target)) {
        assert.equal(
          sha256File(target),
          sha256File(source),
          `cached schemas disagree for ${gvk.group}/${gvk.version}, Kind=${gvk.kind}`,
        );
        continue;
      }
      try {
        fs.linkSync(source, target);
      } catch {
        fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
      }
      schemas += 1;
    }
  }
  assert.ok(schemas > 0, 'KUBECONFORM_SCHEMA_CACHE_DIR must contain strict Kubernetes schemas');
  return directory;
}

function assertKubeconformStrict(render) {
  assert.equal(render.status, 0, render.stderr);
  const args = ['-strict', '-ignore-missing-schemas'];
  const configuredCache = process.env.KUBECONFORM_SCHEMA_CACHE_DIR;
  let localSchemaDirectory;
  if (configuredCache !== undefined) {
    assert.ok(configuredCache.length > 0, 'KUBECONFORM_SCHEMA_CACHE_DIR must not be empty');
    assert.ok(
      path.isAbsolute(configuredCache),
      'KUBECONFORM_SCHEMA_CACHE_DIR must be an absolute path',
    );
    const cache = fs.realpathSync(configuredCache);
    assert.equal(
      cache,
      path.resolve(configuredCache),
      'KUBECONFORM_SCHEMA_CACHE_DIR must resolve to its canonical path',
    );
    assert.ok(fs.statSync(cache).isDirectory(), 'KUBECONFORM_SCHEMA_CACHE_DIR must be a directory');
    args.push('-cache', cache);
    localSchemaDirectory = materializeKubeconformSchemaLocation(cache);
    args.push(
      '-schema-location',
      `${localSchemaDirectory}/{{.ResourceKind}}{{.KindSuffix}}.json`,
    );
  }
  args.push('-summary');
  let validation;
  try {
    validation = spawnSync(
      'kubeconform',
      args,
      {
        cwd: repoRoot,
        input: render.stdout,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
      },
    );
  } finally {
    if (localSchemaDirectory !== undefined) {
      assert.ok(
        localSchemaDirectory.startsWith(
          `${os.tmpdir()}${path.sep}falcone-kubeconform-schemas-bbx-`,
        ),
      );
      fs.rmSync(localSchemaDirectory, { recursive: true, force: true });
    }
  }
  assert.equal(
    validation.status,
    0,
    `kubeconform strict rejected the public Helm render:\n${validation.stdout}${validation.stderr}`,
  );
  const summary = validation.stdout.match(
    /Summary:\s+\d+ resources found[\s\S]*?Valid:\s+(\d+), Invalid:\s+0, Errors:\s+0, Skipped:\s+(\d+)/,
  );
  assert.ok(summary, `kubeconform must report a strict validation summary:\n${validation.stdout}`);
  assert.ok(Number(summary[1]) > 0, 'kubeconform must strictly validate known public resources');
}

function renderChartAtRevision(revision) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'falcone-temporal-base-bbx-'));
  try {
    const archive = spawnSync(
      'git',
      ['archive', '--format=tar', revision, 'charts/in-falcone'],
      { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 },
    );
    assert.equal(archive.status, 0, archive.stderr?.toString() ?? 'git archive failed');
    const extract = spawnSync('tar', ['-x', '-C', sandbox], {
      input: archive.stdout,
      maxBuffer: 64 * 1024 * 1024,
    });
    assert.equal(extract.status, 0, extract.stderr?.toString() ?? 'tar extract failed');
    const render = spawnSync(
      'helm',
      [
        'template',
        releaseName,
        path.join(sandbox, 'charts/in-falcone'),
        '--namespace',
        releaseNamespace,
      ],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
    );
    assert.equal(render.status, 0, render.stderr);
    return parseRenderedDocuments(render.stdout);
  } finally {
    assert.ok(sandbox.startsWith(`${os.tmpdir()}${path.sep}falcone-temporal-base-bbx-`));
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

function chartValuesAtRevision(revision) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'falcone-temporal-values-base-bbx-'));
  try {
    const archive = spawnSync(
      'git',
      ['archive', '--format=tar', revision, 'charts/in-falcone'],
      { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 },
    );
    assert.equal(archive.status, 0, archive.stderr?.toString() ?? 'git archive failed');
    const extract = spawnSync('tar', ['-x', '-C', sandbox], {
      input: archive.stdout,
      maxBuffer: 64 * 1024 * 1024,
    });
    assert.equal(extract.status, 0, extract.stderr?.toString() ?? 'tar extract failed');
    const values = spawnSync(
      'helm',
      ['show', 'values', path.join(sandbox, 'charts/in-falcone')],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
    );
    assert.equal(values.status, 0, values.stderr);
    return parseAllDocuments(values.stdout)[0].toJS();
  } finally {
    assert.ok(sandbox.startsWith(`${os.tmpdir()}${path.sep}falcone-temporal-values-base-bbx-`));
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

function gitFileAtRevision(revision, target) {
  const result = spawnSync('git', ['show', `${revision}:${target}`], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function waitForFile(target, timeoutMilliseconds = 5000) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!fs.existsSync(target) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  assert.ok(fs.existsSync(target), `timed out waiting for ${target}`);
}

function runReuseValuesUpgradeFromRevision({
  revision,
  legacyImage,
}) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'falcone-temporal-real-reuse-bbx-'));
  let server;
  try {
    const historicalValues = chartValuesAtRevision(revision);
    const metadata = parseAllDocuments(
      gitFileAtRevision(revision, 'charts/in-falcone/Chart.yaml'),
    )[0].toJS();
    const releaseConfig = legacyImage === undefined
      ? {}
      : { temporal: { adminTools: { image: legacyImage } } };
    const release = {
      name: releaseName,
      info: {
        first_deployed: '2026-08-14T00:00:00Z',
        last_deployed: '2026-08-14T00:00:00Z',
        deleted: '',
        description: 'Install complete',
        status: 'deployed',
        notes: '',
      },
      chart: {
        metadata,
        templates: [],
        values: historicalValues,
        schema: null,
        files: [],
        dependencies: [],
      },
      config: releaseConfig,
      manifest: '',
      hooks: [],
      version: 1,
      namespace: releaseNamespace,
      labels: {},
    };
    const encodedRelease = gzipSync(Buffer.from(JSON.stringify(release))).toString('base64');
    const secret = {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: `sh.helm.release.v1.${releaseName}.v1`,
        namespace: releaseNamespace,
        resourceVersion: '1',
        labels: {
          modifiedAt: '1786665600',
          name: releaseName,
          owner: 'helm',
          status: 'deployed',
          version: '1',
        },
      },
      type: 'helm.sh/release.v1',
      data: {
        release: Buffer.from(encodedRelease).toString('base64'),
      },
    };
    const statePath = path.join(sandbox, 'state.json');
    const readyPath = path.join(sandbox, 'ready.json');
    const logPath = path.join(sandbox, 'api.log');
    fs.writeFileSync(statePath, JSON.stringify({ secret }));
    server = spawn(
      process.execPath,
      [
        path.join(
          repoRoot,
          'tests/blackbox/fixtures/temporal-bootstrap/fake-kube-release-api.mjs',
        ),
        statePath,
        readyPath,
        logPath,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let serverError = '';
    server.stderr.on('data', (chunk) => { serverError += chunk.toString('utf8'); });
    waitForFile(readyPath);
    const { port } = JSON.parse(fs.readFileSync(readyPath, 'utf8'));
    const kubeconfigPath = path.join(sandbox, 'kubeconfig');
    const pluginsPath = path.join(sandbox, 'plugins');
    const postRendererPluginPath = path.join(pluginsPath, 'capture-bbx');
    const postRenderPath = path.join(postRendererPluginPath, 'capture-post-render.sh');
    const renderedOutputPath = path.join(sandbox, 'rendered.yaml');
    fs.mkdirSync(postRendererPluginPath, { recursive: true });
    fs.writeFileSync(path.join(postRendererPluginPath, 'plugin.yaml'), stringify({
      name: 'capture-bbx',
      version: '1.0.0',
      type: 'postrenderer/v1',
      apiVersion: 'v1',
      runtime: 'subprocess',
      runtimeConfig: {
        platformCommand: [{ command: '${HELM_PLUGIN_DIR}/capture-post-render.sh' }],
      },
    }));
    writeExecutable(postRenderPath, `#!/bin/sh
set -eu
tee "$BBX_POST_RENDER_OUTPUT"
`);
    fs.writeFileSync(kubeconfigPath, stringify({
      apiVersion: 'v1',
      kind: 'Config',
      clusters: [{
        name: 'bbx',
        cluster: { server: `http://127.0.0.1:${port}` },
      }],
      contexts: [{
        name: 'bbx',
        context: { cluster: 'bbx', namespace: releaseNamespace, user: 'bbx' },
      }],
      'current-context': 'bbx',
      users: [{ name: 'bbx', user: {} }],
    }), { mode: 0o600 });

    const result = spawnSync(
      'helm',
      [
        'upgrade',
        releaseName,
        chartDir,
        '--namespace', releaseNamespace,
        '--reuse-values',
        '--dry-run=client',
        '--disable-openapi-validation',
        '--post-renderer', 'capture-bbx',
        '--kubeconfig', kubeconfigPath,
        '--set', 'deployment.upgrade.currentVersion=0.3.1',
        '--set', 'global.webhookDatabase.migration.backupVerified=true',
        '--set', 'global.webhookDatabase.migration.parityVerified=true',
        '--set-string', 'global.webhookDatabase.migration.backupReference=bbx-temporal-backup',
      ],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
        env: {
          ...process.env,
          BBX_POST_RENDER_OUTPUT: renderedOutputPath,
          HELM_PLUGINS: pluginsPath,
        },
      },
    );
    return {
      ...result,
      apiLog: fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '',
      serverError,
      historicalValues,
      renderedOutput: fs.existsSync(renderedOutputPath)
        ? fs.readFileSync(renderedOutputPath, 'utf8')
        : '',
    };
  } finally {
    if (server) server.kill('SIGKILL');
    assert.ok(sandbox.startsWith(`${os.tmpdir()}${path.sep}falcone-temporal-real-reuse-bbx-`));
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

function sha256(buffer) {
  return `sha256:${createHash('sha256').update(buffer).digest('hex')}`;
}

function sha256File(target) {
  const result = spawnSync('sha256sum', [target], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return `sha256:${result.stdout.split(/\s+/, 1)[0]}`;
}

function readTarEntry(target, entry) {
  let result = spawnSync('tar', ['-xOzf', target, entry], {
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) {
    result = spawnSync('tar', ['-xOzf', target, `./${entry}`], {
      maxBuffer: 1024 * 1024,
    });
  }
  assert.equal(result.status, 0, result.stderr?.toString() ?? `cannot read ${entry}`);
  return result.stdout.toString('utf8');
}

function listTarEntries(target) {
  const result = spawnSync('tar', ['-tzf', target], {
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr?.toString() ?? 'cannot list OCI layer');
  return result.stdout.toString('utf8')
    .split('\n')
    .map((entry) => entry.replace(/^\.\//, '').replace(/\/$/, ''))
    .filter(Boolean);
}

function verifiedOciLayer(target, digest, size, label) {
  assert.ok(fs.existsSync(target), `${label} is missing at ${target}`);
  const stat = fs.statSync(target);
  assert.ok(stat.isFile(), `${label} must be a regular file`);
  assert.equal(stat.size, size, `${label} size does not match its manifest descriptor`);
  assert.equal(sha256File(target), digest, `${label} digest does not match its manifest descriptor`);
}

function configuredOciCacheDirectory() {
  const configured = process.env.TEMPORAL_OCI_CACHE_DIR;
  if (configured === undefined) return undefined;
  assert.ok(configured.length > 0, 'TEMPORAL_OCI_CACHE_DIR must not be empty');
  assert.ok(path.isAbsolute(configured), 'TEMPORAL_OCI_CACHE_DIR must be an absolute path');
  const cache = fs.realpathSync(configured);
  assert.equal(
    cache,
    path.resolve(configured),
    'TEMPORAL_OCI_CACHE_DIR must resolve to its canonical path',
  );
  assert.ok(fs.statSync(cache).isDirectory(), 'TEMPORAL_OCI_CACHE_DIR must be a directory');
  return cache;
}

function dockerHubLayer(repository, digest, size, cacheDir) {
  assert.match(repository, /^[a-z0-9][a-z0-9._/-]+$/);
  assert.match(digest, /^sha256:[0-9a-f]{64}$/);
  assert.ok(Number.isSafeInteger(size) && size > 0);
  assert.ok(cacheDir.startsWith(`${os.tmpdir()}${path.sep}falcone-temporal-oci-bbx-`));
  fs.mkdirSync(cacheDir, { recursive: true });
  const cached = path.join(cacheDir, `${digest.slice('sha256:'.length)}.tar.gz`);
  if (fs.existsSync(cached)) {
    verifiedOciLayer(cached, digest, size, 'per-run OCI layer');
    return cached;
  }

  const offlineCache = configuredOciCacheDirectory();
  if (offlineCache !== undefined) {
    const source = path.join(offlineCache, `${digest.slice('sha256:'.length)}.tar.gz`);
    assert.ok(
      fs.existsSync(source),
      `offline OCI evidence ${digest} is missing; run prefetch-offline-evidence.mjs before disabling network`,
    );
    assert.equal(
      fs.realpathSync(source),
      source,
      `offline OCI evidence ${digest} must be a real cache file, not a symlink`,
    );
    verifiedOciLayer(source, digest, size, `offline OCI evidence ${digest}`);
    try {
      fs.linkSync(source, cached);
    } catch {
      fs.copyFileSync(source, cached, fs.constants.COPYFILE_EXCL);
    }
    verifiedOciLayer(cached, digest, size, `per-run copy of OCI evidence ${digest}`);
    return cached;
  }

  const tokenResult = spawnSync(
    'curl',
    [
      '-fsSL',
      `https://auth.docker.io/token?service=registry.docker.io&scope=${encodeURIComponent(`repository:${repository}:pull`)}`,
    ],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 },
  );
  assert.equal(tokenResult.status, 0, tokenResult.stderr);
  const token = JSON.parse(tokenResult.stdout).token;
  assert.equal(typeof token, 'string');
  assert.ok(token.length > 0);

  const download = `${cached}.${process.pid}.download`;
  const fetchResult = spawnSync(
    'curl',
    [
      '-fsSL',
      '-H', `Authorization: Bearer ${token}`,
      '-o', download,
      `https://registry-1.docker.io/v2/${repository}/blobs/${digest}`,
    ],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 },
  );
  assert.equal(fetchResult.status, 0, fetchResult.stderr);
  verifiedOciLayer(download, digest, size, `${repository} downloaded OCI layer`);
  fs.renameSync(download, cached);
  verifiedOciLayer(cached, digest, size, `${repository} cached OCI layer`);
  return cached;
}

function layerIdentityState(previous, layerPath) {
  const state = { ...previous };
  const entries = listTarEntries(layerPath);
  const identityFiles = ['etc/passwd', 'etc/group'];

  for (const entry of entries) {
    const basename = path.posix.basename(entry);
    if (!basename.startsWith('.wh.')) continue;
    const parent = path.posix.dirname(entry) === '.' ? '' : path.posix.dirname(entry);
    if (basename === '.wh..wh..opq') {
      for (const target of identityFiles) {
        if (target.startsWith(parent ? `${parent}/` : '')) delete state[target];
      }
      continue;
    }
    const removed = path.posix.join(parent, basename.slice('.wh.'.length));
    for (const target of identityFiles) {
      if (target === removed || target.startsWith(`${removed}/`)) delete state[target];
    }
  }

  for (const target of identityFiles) {
    if (entries.includes(target)) state[target] = readTarEntry(layerPath, target);
  }
  return state;
}

function makeSyntheticLayer(root, name, entries) {
  const layerRoot = path.join(root, `${name}-root`);
  fs.mkdirSync(layerRoot, { recursive: true });
  for (const [entry, contents] of Object.entries(entries)) {
    const target = path.join(layerRoot, ...entry.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }
  const archive = path.join(root, `${name}.tar.gz`);
  const result = spawnSync('tar', ['-czf', archive, '-C', layerRoot, '.'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return archive;
}

function temporalBootstrapJob(documents) {
  const jobs = documents.filter((document) =>
    document.kind === 'Job'
      && document.metadata?.name?.endsWith('-temporal-bootstrap'));
  assert.equal(jobs.length, 1, 'the chart must render exactly one Temporal bootstrap Job');
  return jobs[0];
}

function workflowConsumer(documents) {
  const deployments = documents.filter((document) => document.kind === 'Deployment');
  const consumers = deployments.filter((deployment) =>
    deployment.spec?.template?.metadata?.labels?.['app.kubernetes.io/component'] === 'flows-worker'
      && deployment.spec?.template?.spec?.containers?.some((container) =>
        container.env?.some((entry) => entry.name === 'TEMPORAL_TASK_QUEUE')));
  assert.equal(consumers.length, 1, 'the chart must render exactly one Temporal workflow consumer');
  return consumers[0];
}

function workflowGates(worker) {
  return (worker.spec?.template?.spec?.initContainers ?? []).filter((container) => {
    const script = container.command?.[2] ?? '';
    return /temporal/i.test(script) && /search-attribute/i.test(script);
  });
}

function assertRestrictedContainer(container, { numericIdentity }) {
  const security = container.securityContext ?? {};
  assert.equal(security.runAsNonRoot, true);
  assert.equal(security.allowPrivilegeEscalation, false);
  assert.ok(security.capabilities?.drop?.includes('ALL'));
  assert.equal(security.fsGroup, undefined, 'fsGroup is valid only on a pod securityContext');
  if (numericIdentity === true) {
    assert.equal(security.runAsUser, 1000);
    assert.equal(security.runAsGroup, 1000);
  } else if (numericIdentity === false) {
    assert.equal(security.runAsUser, undefined);
    assert.equal(security.runAsGroup, undefined);
  }
}

function assertOpenShiftPodSecurity(pod) {
  const security = pod.securityContext ?? {};
  assert.equal(security.runAsNonRoot, true);
  assert.equal(security.runAsUser, undefined);
  assert.equal(security.runAsGroup, undefined);
  assert.equal(security.fsGroup, undefined);
  assert.equal(security.seccompProfile?.type, 'RuntimeDefault');
  for (const container of [
    ...(pod.initContainers ?? []),
    ...(pod.containers ?? []),
  ]) {
    assertRestrictedContainer(container, { numericIdentity: false });
  }
}

function assertVanillaTemporalPodSecurity(pod) {
  const security = pod.securityContext ?? {};
  assert.equal(security.runAsNonRoot, true);
  assert.equal(security.seccompProfile?.type, 'RuntimeDefault');
  for (const container of [
    ...(pod.initContainers ?? []),
    ...(pod.containers ?? []),
  ]) {
    assertRestrictedContainer(container, { numericIdentity: null });
    assert.equal(container.securityContext?.runAsUser ?? security.runAsUser, 1000);
    assert.equal(container.securityContext?.runAsGroup ?? security.runAsGroup, 1000);
  }
}

function locallyCachedImageUser(image) {
  for (const runtime of ['docker', 'podman']) {
    const result = spawnSync(runtime, [
      'image', 'inspect', image, '--format', '{{.Config.User}}',
    ], { encoding: 'utf8' });
    if (result.status === 0) return result.stdout.trim();
    if (result.error?.code !== 'ENOENT') continue;
  }
  return null;
}

function hookEvents(job) {
  return new Set(
    String(job.metadata?.annotations?.['helm.sh/hook'] ?? '')
      .split(',')
      .map((event) => event.trim())
      .filter(Boolean),
  );
}

function bootstrapScript(job) {
  const containers = job.spec?.template?.spec?.containers ?? [];
  assert.equal(containers.length, 1, 'Temporal bootstrap must have one observable entrypoint');
  const command = containers[0].command ?? [];
  assert.deepEqual(command.slice(0, 2), ['/bin/sh', '-ec']);
  assert.equal(typeof command[2], 'string');
  return command[2];
}

function envValue(container, name) {
  return container.env?.find((entry) => entry.name === name)?.value;
}

function writeExecutable(target, body) {
  fs.writeFileSync(target, body, { mode: 0o755 });
}

function runBootstrap(job, {
  initialState = { namespace: false, attributes: [] },
  health = 'up',
  failAttribute = '',
  namespaceCreateRace = false,
  attributeCreateRaces = [],
  attributeOutputOverrides = {},
  dropAttributeAfterCreate = {},
  namespaceNeverVerifies = false,
  listFailure = false,
  failureSentinel = 'bbx-secret-response-sentinel',
} = {}) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'falcone-temporal-bbx-'));
  const statePath = path.join(sandbox, 'state.json');
  const logPath = path.join(sandbox, 'calls.ndjson');
  fs.writeFileSync(statePath, JSON.stringify(initialState));

  writeExecutable(path.join(sandbox, 'sleep'), '#!/bin/sh\nexit 0\n');
  writeExecutable(path.join(sandbox, 'temporal'), `#!/usr/bin/env node
import fs from 'node:fs';

const args = process.argv.slice(2);
const statePath = process.env.FAKE_TEMPORAL_STATE;
const logPath = process.env.FAKE_TEMPORAL_LOG;
const failAttribute = process.env.FAKE_TEMPORAL_FAIL_ATTRIBUTE || '';
const namespaceCreateRace = process.env.FAKE_TEMPORAL_NAMESPACE_CREATE_RACE === 'true';
const attributeCreateRaces = JSON.parse(process.env.FAKE_TEMPORAL_ATTRIBUTE_CREATE_RACES || '[]');
const attributeOutputOverrides = JSON.parse(process.env.FAKE_TEMPORAL_ATTRIBUTE_OUTPUT_OVERRIDES || '{}');
const dropAttributeAfterCreate = JSON.parse(process.env.FAKE_TEMPORAL_DROP_AFTER_CREATE || '{}');
const namespaceNeverVerifies = process.env.FAKE_TEMPORAL_NAMESPACE_NEVER_VERIFIES === 'true';
const listFailure = process.env.FAKE_TEMPORAL_LIST_FAILURE === 'true';
const failureSentinel = process.env.FAKE_TEMPORAL_FAILURE_SENTINEL || '';
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
fs.appendFileSync(logPath, JSON.stringify(args) + '\\n');

function flag(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : '';
}

function persist() {
  state.attributes = [...new Set(state.attributes)].sort();
  state.attributeTypes = state.attributeTypes || {};
  fs.writeFileSync(statePath, JSON.stringify(state));
}

if (args.join(' ').startsWith('operator cluster health')) {
  process.exit(process.env.FAKE_TEMPORAL_HEALTH === 'up' ? 0 : 1);
}
if (args.join(' ').startsWith('operator namespace describe')) {
  if (namespaceNeverVerifies) {
    console.error(failureSentinel);
    process.exit(1);
  }
  process.exit(state.namespace ? 0 : 1);
}
if (args.join(' ').startsWith('operator namespace create')) {
  if (process.env.FAKE_TEMPORAL_HEALTH !== 'up') process.exit(1);
  if (state.namespace) process.exit(1);
  state.namespace = true;
  persist();
  if (namespaceCreateRace) {
    console.error('namespace already exists');
    process.exit(1);
  }
  process.exit(0);
}
if (args.join(' ').startsWith('operator search-attribute create')) {
  const name = flag('--name');
  const type = flag('--type');
  if (!state.namespace || name === failAttribute) {
    console.error(failureSentinel);
    process.exit(1);
  }
  if (state.attributes.includes(name)) process.exit(1);
  state.attributes.push(name);
  state.attributeTypes = state.attributeTypes || {};
  state.attributeTypes[name] = type;
  if (dropAttributeAfterCreate.on === name && dropAttributeAfterCreate.drop) {
    state.attributes = state.attributes.filter((attribute) => attribute !== dropAttributeAfterCreate.drop);
    delete state.attributeTypes[dropAttributeAfterCreate.drop];
  }
  persist();
  if (attributeCreateRaces.includes(name)) {
    console.error('search attribute already exists');
    process.exit(1);
  }
  process.exit(0);
}
if (args.join(' ').startsWith('operator search-attribute list')) {
  if (listFailure) {
    console.error(failureSentinel);
    process.exit(1);
  }
  if (!state.namespace) process.exit(1);
  for (const name of [...state.attributes].sort()) {
    if (Object.hasOwn(attributeOutputOverrides, name)) {
      console.log(attributeOutputOverrides[name]);
    } else {
      console.log(name + ' ' + (state.attributeTypes?.[name] || 'Keyword'));
    }
  }
  process.exit(0);
}
process.exit(64);
`);

  const container = job.spec.template.spec.containers[0];
  const literalEnvironment = Object.fromEntries(
    (container.env ?? [])
      .filter((entry) => typeof entry.value === 'string')
      .map((entry) => [entry.name, entry.value]),
  );
  const result = spawnSync('/bin/sh', ['-ec', bootstrapScript(job)], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    env: {
      ...process.env,
      PATH: `${sandbox}:${process.env.PATH}`,
      FAKE_TEMPORAL_STATE: statePath,
      FAKE_TEMPORAL_LOG: logPath,
      FAKE_TEMPORAL_HEALTH: health,
      FAKE_TEMPORAL_FAIL_ATTRIBUTE: failAttribute,
      FAKE_TEMPORAL_NAMESPACE_CREATE_RACE: String(namespaceCreateRace),
      FAKE_TEMPORAL_ATTRIBUTE_CREATE_RACES: JSON.stringify(attributeCreateRaces),
      FAKE_TEMPORAL_ATTRIBUTE_OUTPUT_OVERRIDES: JSON.stringify(attributeOutputOverrides),
      FAKE_TEMPORAL_DROP_AFTER_CREATE: JSON.stringify(dropAttributeAfterCreate),
      FAKE_TEMPORAL_NAMESPACE_NEVER_VERIFIES: String(namespaceNeverVerifies),
      FAKE_TEMPORAL_LIST_FAILURE: String(listFailure),
      FAKE_TEMPORAL_FAILURE_SENTINEL: failureSentinel,
      ...literalEnvironment,
      FLOW_FRONTEND_ADDR: envValue(container, 'FLOW_FRONTEND_ADDR'),
      FLOW_NAMESPACE: envValue(container, 'FLOW_NAMESPACE'),
      FLOW_RETENTION: envValue(container, 'FLOW_RETENTION'),
    },
  });

  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const calls = fs.existsSync(logPath)
    ? fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
    : [];
  fs.rmSync(sandbox, { recursive: true, force: true });
  return { ...result, calls, state, output: `${result.stdout}${result.stderr}` };
}

function isHealthProbe(call) {
  return call.slice(0, 3).join(' ') === 'operator cluster health';
}

function runRenderedContainer(container, options) {
  return runBootstrap({
    spec: {
      template: {
        spec: { containers: [container] },
      },
    },
  }, options);
}

function revisionIdentity(job) {
  const revision = String(
    job.metadata?.annotations?.['falcone.io/helm-release-revision'] ?? '',
  );
  assert.match(
    revision,
    /^[1-9][0-9]*$/,
    'the public Job contract must expose its exact positive Helm release revision',
  );
  assert.match(
    job.metadata.name,
    new RegExp(`-r${revision}(?:-|$)`),
    'the DNS-safe Job name must retain the exact public release revision',
  );
  return revision;
}

function assertTerminalDiagnostic(result, {
  target,
  sentinel = 'bbx-secret-response-sentinel',
  maxBytes = 16 * 1024,
}) {
  assert.notEqual(result.status, 0);
  const lines = result.output.trim().split('\n').map((line) => line.trim()).filter(Boolean);
  assert.ok(lines.length > 0, 'failure must emit a terminal diagnostic');
  const terminal = lines.at(-1);
  assert.match(terminal, /falcone-flows/);
  assert.match(terminal, target);
  assert.match(terminal, /(?:[0-9]+\s*\/\s*[0-9]+|attempts?|deadline|within\s+[0-9]+)/i);
  assert.match(terminal, /correct or resolve/i);
  assert.match(terminal, /retry/i);
  assert.match(terminal, /fail[- ]forward/i);
  assert.doesNotMatch(result.output, new RegExp(sentinel, 'i'));
  assert.ok(
    Buffer.byteLength(result.output, 'utf8') <= maxBytes,
    'failure output must remain bounded',
  );
}

// bbx-temporal-bootstrap-001 | fn-temporal-bootstrap-readiness
// #### Scenario: Fresh install completes Temporal bootstrap before workflow consumers become Ready
test('bbx-temporal-bootstrap-001: fresh install includes the namespace producer in the pre-wait resource set', () => {
  const documents = renderChart();
  const bootstrap = temporalBootstrapJob(documents);
  const consumer = workflowConsumer(documents);
  const bootstrapNamespace = envValue(bootstrap.spec.template.spec.containers[0], 'FLOW_NAMESPACE');
  const consumerNamespace = consumer.spec.template.spec.containers
    .flatMap((container) => container.env ?? [])
    .find((entry) => entry.name === 'TEMPORAL_NAMESPACE')?.value;

  assert.equal(bootstrapNamespace, consumerNamespace);
  assert.equal(bootstrapNamespace, 'falcone-flows');
  assert.equal(
    hookEvents(bootstrap).size,
    0,
    'fresh-install namespace producer must be an ordinary resource applied before Helm waits',
  );
});

// bbx-temporal-bootstrap-002 | fn-temporal-bootstrap-readiness
// #### Scenario: Helm wait does not defer Temporal namespace creation to a post-install hook
test('bbx-temporal-bootstrap-002: Helm wait cannot run before the Temporal namespace producer', () => {
  const bootstrap = temporalBootstrapJob(renderChart());
  const events = hookEvents(bootstrap);
  assert.equal(events.has('post-install'), false);
  assert.equal(events.has('post-upgrade'), false);
});

// bbx-temporal-bootstrap-003 | fn-temporal-bootstrap-upgrade-reconciliation
// #### Scenario: Upgrade reconciles the Temporal namespace and search attributes idempotently
test('bbx-temporal-bootstrap-003: upgrade reconciliation runs before wait and converges twice', () => {
  const upgradeJob = temporalBootstrapJob(renderChart({ upgrade: true }));
  const events = hookEvents(upgradeJob);
  assert.equal(events.has('post-install'), false);
  assert.equal(events.has('post-upgrade'), false);
  assert.equal(
    events.size,
    0,
    'upgrade reconciliation must be an ordinary resource applied during Helm wait',
  );

  const first = runBootstrap(upgradeJob);
  assert.equal(first.status, 0, first.output);
  const second = runBootstrap(upgradeJob, { initialState: first.state });
  assert.equal(second.status, 0, second.output);
  assert.equal(second.state.namespace, true);
  assert.deepEqual(second.state.attributes, [
    'flowId',
    'flowVersion',
    'tenantId',
    'triggerType',
    'workspaceId',
  ]);
});

// bbx-temporal-bootstrap-004 | fn-temporal-bootstrap-upgrade-reconciliation
// #### Scenario: Repeated reconciliation does not collide with an immutable completed Job
test('bbx-temporal-bootstrap-004: upgrade lifecycle replaces or revisions the completed install Job', () => {
  const installJob = temporalBootstrapJob(renderChart());
  const upgradeJob = temporalBootstrapJob(renderChart({ upgrade: true }));
  assert.equal(hookEvents(installJob).size, 0);
  assert.equal(hookEvents(upgradeJob).size, 0);
  revisionIdentity(installJob);
  revisionIdentity(upgradeJob);
  assert.notEqual(
    installJob.metadata.name,
    upgradeJob.metadata.name,
    'the public Job identity must advance with Helm release lifecycle/revision',
  );

  const longReleaseName = 'r'.repeat(53);
  const longInstallJob = temporalBootstrapJob(renderChart({ release: longReleaseName }));
  const longUpgradeJob = temporalBootstrapJob(renderChart({
    release: longReleaseName,
    upgrade: true,
  }));
  for (const [job, lifecycle] of [
    [longInstallJob, ''],
    [longUpgradeJob, '-upgrade'],
  ]) {
    const revision = revisionIdentity(job);
    assert.ok(job.metadata.name.length <= 63, 'revision-scoped Job name must be DNS-safe');
    assert.match(job.metadata.name, /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/);
    assert.equal(
      job.metadata.name.endsWith(`-r${revision}${lifecycle}-temporal-bootstrap`),
      true,
      'release-name truncation must preserve the complete revision/lifecycle suffix',
    );
  }
});

// bbx-temporal-bootstrap-005 | fn-temporal-bootstrap-failure-diagnostics
// #### Scenario: Frontend unavailability fails with bounded actionable diagnostics
test('bbx-temporal-bootstrap-005: frontend timeout stops before mutation and explains fail-forward retry', () => {
  const job = temporalBootstrapJob(renderChart());
  const result = runBootstrap(job, { health: 'down' });
  const healthCalls = result.calls.filter(isHealthProbe);

  assert.notEqual(result.status, 0);
  assert.ok(job.spec.activeDeadlineSeconds > 0 && job.spec.activeDeadlineSeconds <= 600);
  assert.ok(healthCalls.length > 0 && healthCalls.length <= 60);
  assert.equal(
    result.calls.every(isHealthProbe),
    true,
    'an unavailable frontend must not be followed by namespace or search-attribute mutations',
  );
  assert.match(result.output, /temporal-readiness-bbx-temporal-frontend:7233/);
  assert.match(result.output, /failed|unavailable|not ready/i);
  assert.match(result.output, /retry|fail[- ]forward/i);
  assert.equal(result.state.namespace, false);
  assert.deepEqual(result.state.attributes, []);
});

// bbx-temporal-bootstrap-006 | fn-temporal-bootstrap-failure-diagnostics
// #### Scenario: Failed reconciliation preserves existing Temporal state for fail-forward retry
test('bbx-temporal-bootstrap-006: additive reconciliation failure preserves existing namespace data', () => {
  const job = temporalBootstrapJob(renderChart());
  const result = runBootstrap(job, {
    initialState: { namespace: true, attributes: ['tenantId'] },
    failAttribute: 'flowId',
  });

  assert.notEqual(result.status, 0);
  assert.equal(result.state.namespace, true);
  assert.equal(result.state.attributes.includes('tenantId'), true);
  assert.equal(
    result.calls.some((call) => call.includes('delete')),
    false,
    'fail-forward reconciliation must never delete an existing namespace or attribute',
  );
  assert.match(result.output, /flowId/);
});

// bbx-temporal-bootstrap-007 | fn-temporal-bootstrap-security
// #### Scenario: Bootstrap rendering remains secret-free and least-privileged
test('bbx-temporal-bootstrap-007: bootstrap carries no Secret payload or API credential', () => {
  for (const documents of [renderChart(), renderChart({ upgrade: true })]) {
    const job = temporalBootstrapJob(documents);
    const pod = job.spec.template.spec;
    const container = pod.containers[0];

    assert.equal(pod.automountServiceAccountToken, false);
    assert.equal(pod.serviceAccountName, undefined);
    assert.equal(container.env?.some((entry) => entry.valueFrom), false);
    assert.equal(
      (pod.volumes ?? []).some((volume) => volume.secret || volume.projected?.sources?.some((source) => source.secret)),
      false,
    );
    assert.equal(JSON.stringify(job).includes('kind: Secret'), false);
    assert.equal(
      (container.env ?? []).some((entry) => /password|secret|token|credential/i.test(entry.name)),
      false,
    );
  }
});

// bbx-temporal-bootstrap-008 | fn-temporal-bootstrap-consumer-gate
// #### Scenario: Workflow consumers wait for the exact Temporal bootstrap state
test('bbx-temporal-bootstrap-008: workflow worker starts only after exact bootstrap-state verification', () => {
  const documents = renderChart();
  const worker = workflowConsumer(documents);
  const pod = worker.spec.template.spec;
  const gates = (pod.initContainers ?? []).filter((container) => {
    const command = container.command ?? [];
    const script = command[2] ?? '';
    return command[0] === '/bin/sh'
      && command[1] === '-ec'
      && /temporal/i.test(script)
      && /search-attribute/i.test(script);
  });
  assert.equal(
    gates.length,
    1,
    'workflow worker must expose exactly one Temporal bootstrap-state init gate',
  );

  const gate = gates[0];
  assert.equal(pod.automountServiceAccountToken, false);
  assert.equal(typeof pod.serviceAccountName, 'string');
  assert.notEqual(pod.serviceAccountName, '');
  assert.notEqual(pod.serviceAccountName, 'default');
  const serviceAccounts = documents.filter((document) =>
    document.kind === 'ServiceAccount'
      && document.metadata?.name === pod.serviceAccountName);
  assert.equal(serviceAccounts.length, 1, 'the consumer gate must use one dedicated ServiceAccount');
  assert.notEqual(serviceAccounts[0].automountServiceAccountToken, true);
  assert.equal(serviceAccounts[0].secrets, undefined);
  const rbacBindings = documents.filter((document) =>
    ['RoleBinding', 'ClusterRoleBinding'].includes(document.kind)
      && document.subjects?.some((subject) =>
        subject.kind === 'ServiceAccount'
          && subject.name === pod.serviceAccountName));
  assert.deepEqual(rbacBindings, [], 'the consumer gate ServiceAccount must receive no Kubernetes RBAC');
  assert.equal(gate.env?.some((entry) => entry.valueFrom), false);
  assert.equal(
    (pod.volumes ?? []).some((volume) =>
      volume.secret || volume.projected?.sources?.some((source) => source.secret)),
    false,
  );

  const desiredAttributes = [
    'flowId',
    'flowVersion',
    'tenantId',
    'triggerType',
    'workspaceId',
  ];
  const exact = runRenderedContainer(gate, {
    initialState: {
      namespace: true,
      attributes: desiredAttributes,
      attributeTypes: Object.fromEntries(desiredAttributes.map((name) => [name, 'Keyword'])),
    },
  });
  assert.equal(exact.status, 0, exact.output);

  const incomplete = runRenderedContainer(gate, {
    initialState: {
      namespace: true,
      attributes: desiredAttributes.filter((name) => name !== 'triggerType'),
      attributeTypes: Object.fromEntries(desiredAttributes.map((name) => [name, 'Keyword'])),
    },
  });
  assert.notEqual(incomplete.status, 0, incomplete.output);
  assert.equal(
    incomplete.calls.some((call) => call.includes('create') || call.includes('delete')),
    false,
    'the consumer gate must verify Temporal state without mutating it',
  );

  const wrongType = runRenderedContainer(gate, {
    initialState: {
      namespace: true,
      attributes: desiredAttributes,
      attributeTypes: {
        ...Object.fromEntries(desiredAttributes.map((name) => [name, 'Keyword'])),
        flowId: 'Text',
      },
    },
  });
  assert.notEqual(wrongType.status, 0, wrongType.output);
});

// bbx-temporal-bootstrap-009 | fn-temporal-bootstrap-values-consistency
// #### Scenario: Fresh install completes Temporal bootstrap before workflow consumers become Ready
test('bbx-temporal-bootstrap-009: a custom namespace cannot render producer and consumer drift', () => {
  const result = renderChartResult({
    extraArgs: [
      '--set-string',
      'temporal.bootstrap.namespace=bbx-custom-flows',
    ],
  });
  assert.notEqual(result.status, 0, 'unsupported namespace divergence must fail before apply');
  assert.match(`${result.stdout}${result.stderr}`, /temporal\.bootstrap\.namespace/i);
  assert.match(`${result.stdout}${result.stderr}`, /falcone-flows|workflow.*consumer/i);
});

// bbx-temporal-bootstrap-010 | fn-temporal-bootstrap-values-consistency
// #### Scenario: Workflow consumers wait for the exact Temporal bootstrap state
test('bbx-temporal-bootstrap-010: only the five consumer-gated Keyword attributes can render', () => {
  const keyword = (name) => ({ name, type: 'Keyword' });
  const desired = [
    keyword('tenantId'),
    keyword('workspaceId'),
    keyword('flowId'),
    keyword('flowVersion'),
    keyword('triggerType'),
  ];
  const divergentSets = [
    desired.filter(({ name }) => name !== 'triggerType'),
    desired.map((attribute) => attribute.name === 'flowId'
      ? { ...attribute, type: 'Text' }
      : attribute),
    [...desired, keyword('unverifiedAttribute')],
    [...desired, keyword('flowId')],
  ];

  for (const searchAttributes of divergentSets) {
    const result = renderChartResult({
      extraArgs: [
        '--set-json',
        `temporal.bootstrap.searchAttributes=${JSON.stringify(searchAttributes)}`,
      ],
    });
    assert.notEqual(result.status, 0, 'unsupported search-attribute drift must fail before apply');
    assert.match(`${result.stdout}${result.stderr}`, /temporal\.bootstrap\.searchAttributes/i);
    assert.match(`${result.stdout}${result.stderr}`, /five|5|Keyword/i);
  }
});

// bbx-temporal-bootstrap-011 | fn-temporal-bootstrap-upgrade-reconciliation
// #### Scenario: Upgrade reconciles the Temporal namespace and search attributes idempotently
test('bbx-temporal-bootstrap-011: namespace AlreadyExists race converges only after readback', () => {
  const job = temporalBootstrapJob(renderChart());
  const result = runBootstrap(job, { namespaceCreateRace: true });
  const namespaceDescribes = result.calls.filter((call) =>
    call.slice(0, 3).join(' ') === 'operator namespace describe');
  const namespaceCreates = result.calls.filter((call) =>
    call.slice(0, 3).join(' ') === 'operator namespace create');

  assert.equal(result.status, 0, result.output);
  assert.equal(result.state.namespace, true);
  assert.equal(namespaceCreates.length, 1);
  assert.ok(
    namespaceDescribes.length >= 2,
    'an AlreadyExists race is success only after a post-create namespace describe',
  );
  assert.equal(result.calls.some((call) => call.includes('delete')), false);
});

// bbx-temporal-bootstrap-012 | fn-temporal-bootstrap-failure-diagnostics
// #### Scenario: Failed reconciliation preserves existing Temporal state for fail-forward retry
test('bbx-temporal-bootstrap-012: incompatible existing attribute type fails without recreate', () => {
  const job = temporalBootstrapJob(renderChart());
  const attributes = ['tenantId', 'workspaceId', 'flowId', 'flowVersion', 'triggerType'];
  const result = runBootstrap(job, {
    initialState: {
      namespace: true,
      attributes,
      attributeTypes: {
        tenantId: 'Keyword',
        workspaceId: 'Keyword',
        flowId: 'Text',
        flowVersion: 'Keyword',
        triggerType: 'Keyword',
      },
    },
  });
  const flowIdCreates = result.calls.filter((call) =>
    call.slice(0, 3).join(' ') === 'operator search-attribute create'
      && call[call.indexOf('--name') + 1] === 'flowId');

  assert.notEqual(result.status, 0);
  assert.equal(flowIdCreates.length, 0, 'an incompatible existing attribute must not be recreated');
  assert.equal(result.calls.some((call) => call.includes('delete')), false);
  assert.equal(result.state.attributeTypes.flowId, 'Text');
  assert.match(result.output, /flowId/);
  assert.match(result.output, /Keyword|type|incompatible/i);
});

// bbx-temporal-bootstrap-013 | fn-temporal-bootstrap-upgrade-reconciliation
// #### Scenario: Upgrade reconciles the Temporal namespace and search attributes idempotently
test('bbx-temporal-bootstrap-013: attribute create error converges only when exact readback exists', () => {
  const job = temporalBootstrapJob(renderChart());
  const result = runBootstrap(job, {
    initialState: {
      namespace: true,
      attributes: ['tenantId', 'workspaceId', 'flowVersion', 'triggerType'],
      attributeTypes: {
        tenantId: 'Keyword',
        workspaceId: 'Keyword',
        flowVersion: 'Keyword',
        triggerType: 'Keyword',
      },
    },
    attributeCreateRaces: ['flowId'],
  });

  assert.equal(result.status, 0, result.output);
  assert.deepEqual(result.state.attributes, [
    'flowId',
    'flowVersion',
    'tenantId',
    'triggerType',
    'workspaceId',
  ]);
  assert.equal(result.state.attributeTypes.flowId, 'Keyword');
  assert.ok(result.calls.some((call) =>
    call.slice(0, 3).join(' ') === 'operator search-attribute list'));
  assert.equal(result.calls.some((call) => call.includes('delete')), false);
});

// bbx-temporal-bootstrap-014 | fn-temporal-bootstrap-failure-diagnostics
// #### Scenario: Failed reconciliation preserves existing Temporal state for fail-forward retry
test('bbx-temporal-bootstrap-014: missing or malformed attribute type never reports success', () => {
  const job = temporalBootstrapJob(renderChart());
  const attributes = ['tenantId', 'workspaceId', 'flowId', 'flowVersion', 'triggerType'];
  const initialState = {
    namespace: true,
    attributes,
    attributeTypes: Object.fromEntries(attributes.map((name) => [name, 'Keyword'])),
  };

  for (const flowIdOutput of ['flowId ', 'flowId unexpected-output']) {
    const result = runBootstrap(job, {
      initialState,
      attributeOutputOverrides: { flowId: flowIdOutput },
    });
    assert.notEqual(result.status, 0, `malformed output was accepted: ${JSON.stringify(flowIdOutput)}`);
    assert.equal(result.calls.some((call) => call.includes('delete')), false);
    assert.match(result.output, /flowId/);
  }
});

// bbx-temporal-bootstrap-015 | fn-temporal-bootstrap-upgrade-reconciliation
// #### Scenario: Upgrade reconciles the Temporal namespace and search attributes idempotently
test('bbx-temporal-bootstrap-015: success requires final exact readback of all five Keyword attributes', () => {
  const job = temporalBootstrapJob(renderChart());
  const desired = ['flowId', 'flowVersion', 'tenantId', 'triggerType', 'workspaceId'];
  const converged = runBootstrap(job);
  assert.equal(converged.status, 0, converged.output);
  assert.deepEqual(converged.state.attributes, desired);
  assert.deepEqual(
    converged.state.attributeTypes,
    Object.fromEntries(desired.map((name) => [name, 'Keyword'])),
  );
  const lastCreate = converged.calls.findLastIndex((call) =>
    call.slice(0, 3).join(' ') === 'operator search-attribute create');
  assert.ok(lastCreate >= 0);
  assert.ok(
    converged.calls.slice(lastCreate + 1).some((call) =>
      call.slice(0, 3).join(' ') === 'operator search-attribute list'),
    'success must include a readback after the final attribute mutation',
  );

  const drifted = runBootstrap(job, {
    dropAttributeAfterCreate: { on: 'triggerType', drop: 'tenantId' },
  });
  assert.notEqual(drifted.status, 0, 'success must not survive loss of an earlier verified attribute');
  assert.equal(drifted.state.attributes.includes('tenantId'), false);
  assert.equal(drifted.calls.some((call) => call.includes('delete')), false);
});

// bbx-temporal-bootstrap-016 | fn-temporal-bootstrap-values-consistency
// #### Scenario: Existing values and Temporal state remain compatible across upgrade and rollback
test('bbx-temporal-bootstrap-016: exact search-attribute set remains valid in any authoring order', () => {
  const reordered = [
    { name: 'triggerType', type: 'Keyword' },
    { name: 'flowVersion', type: 'Keyword' },
    { name: 'tenantId', type: 'Keyword' },
    { name: 'flowId', type: 'Keyword' },
    { name: 'workspaceId', type: 'Keyword' },
  ];
  const documents = renderChart({
    extraArgs: [
      '--set-json',
      `temporal.bootstrap.searchAttributes=${JSON.stringify(reordered)}`,
    ],
  });

  const job = temporalBootstrapJob(documents);
  const bootstrap = runBootstrap(job);
  assert.equal(bootstrap.status, 0, bootstrap.output);
  assert.deepEqual(bootstrap.state.attributes, [
    'flowId',
    'flowVersion',
    'tenantId',
    'triggerType',
    'workspaceId',
  ]);
  assert.deepEqual(
    bootstrap.state.attributeTypes,
    Object.fromEntries(bootstrap.state.attributes.map((name) => [name, 'Keyword'])),
  );

  const worker = workflowConsumer(documents);
  const gates = (worker.spec.template.spec.initContainers ?? []).filter((container) => {
    const script = container.command?.[2] ?? '';
    return /temporal/i.test(script) && /search-attribute/i.test(script);
  });
  assert.equal(gates.length, 1);
  const gate = runRenderedContainer(gates[0], {
    initialState: bootstrap.state,
  });
  assert.equal(gate.status, 0, gate.output);
});

// bbx-temporal-bootstrap-017 | fn-temporal-bootstrap-security
// #### Scenario: Vanilla Kubernetes uses numeric image identities for every chart-owned Temporal container
test('bbx-temporal-bootstrap-017: named-user consumer gate is numeric on vanilla and SCC-assigned on OpenShift', () => {
  const vanillaDocuments = renderChart();
  const vanillaWorker = workflowConsumer(vanillaDocuments);
  const vanillaGates = workflowGates(vanillaWorker);
  assert.equal(vanillaGates.length, 1);
  const vanillaGate = vanillaGates[0];
  assert.equal(vanillaGate.image, 'docker.io/temporalio/admin-tools:1.31.1');
  assertRestrictedContainer(vanillaGate, { numericIdentity: true });

  const cachedImageUser = locallyCachedImageUser(vanillaGate.image);
  if (cachedImageUser !== null) {
    assert.equal(cachedImageUser, 'temporal', 'cached admin-tools image must expose its effective named user');
  }

  assertVanillaTemporalPodSecurity(
    temporalBootstrapJob(vanillaDocuments).spec.template.spec,
  );
  const vanillaServers = vanillaDocuments.filter((document) =>
    document.kind === 'Deployment'
      && document.metadata?.labels?.['app.kubernetes.io/part-of'] === 'temporal');
  assert.equal(vanillaServers.length, 5);
  for (const deployment of vanillaServers) {
    assertVanillaTemporalPodSecurity(deployment.spec.template.spec);
  }

  const openShiftWorker = workflowConsumer(renderChart({
    extraArgs: ['-f', 'charts/in-falcone/values/platform-openshift.yaml'],
  }));
  const openShiftGates = workflowGates(openShiftWorker);
  assert.equal(openShiftGates.length, 1);
  assertRestrictedContainer(openShiftGates[0], { numericIdentity: false });
});

// bbx-temporal-bootstrap-018 | fn-temporal-bootstrap-security
// #### Scenario: OpenShift assigns arbitrary identities to every chart-owned Temporal container
test('bbx-temporal-bootstrap-018: all custom Temporal workloads delegate IDs to OpenShift SCC', () => {
  const documents = renderChart({
    extraArgs: ['-f', 'charts/in-falcone/values/platform-openshift.yaml'],
  });
  const bootstrap = temporalBootstrapJob(documents);
  assertOpenShiftPodSecurity(bootstrap.spec.template.spec);

  const serverDeployments = documents.filter((document) =>
    document.kind === 'Deployment'
      && document.metadata?.labels?.['app.kubernetes.io/part-of'] === 'temporal');
  assert.equal(serverDeployments.length, 5);
  for (const deployment of serverDeployments) {
    assertOpenShiftPodSecurity(deployment.spec.template.spec);
  }
  assertOpenShiftPodSecurity(workflowConsumer(documents).spec.template.spec);
});

// bbx-temporal-bootstrap-019 | fn-temporal-bootstrap-consumer-gate
// #### Scenario: Inherited values cannot remove the mandatory Temporal bootstrap-state gate
test('bbx-temporal-bootstrap-019: an inherited empty init-container list cannot remove the mandatory gate', () => {
  const documents = renderChart({
    extraArgs: ['--set-json', 'workflowWorker.initContainers=[]'],
  });
  const worker = workflowConsumer(documents);
  assert.equal(workflowGates(worker).length, 1);
});

// bbx-temporal-bootstrap-020 | fn-temporal-bootstrap-consumer-gate
// #### Scenario: User init containers remain additive to the mandatory Temporal gate
test('bbx-temporal-bootstrap-020: user init containers are additions beside the mandatory gate', () => {
  const userInit = {
    name: 'bbx-user-init',
    image: 'docker.io/library/busybox:1.36.1',
    command: ['/bin/sh', '-ec', 'true'],
    securityContext: {
      allowPrivilegeEscalation: false,
      capabilities: { drop: ['ALL'] },
      readOnlyRootFilesystem: true,
      runAsNonRoot: true,
      runAsUser: 65532,
      runAsGroup: 65532,
    },
  };
  const documents = renderChart({
    extraArgs: [
      '--set-json',
      `workflowWorker.initContainers=${JSON.stringify([userInit])}`,
    ],
  });
  const worker = workflowConsumer(documents);
  assert.equal(workflowGates(worker).length, 1);
  assert.equal(
    worker.spec.template.spec.initContainers.some((container) => container.name === userInit.name),
    true,
  );
});

// bbx-temporal-bootstrap-021 | fn-temporal-bootstrap-failure-diagnostics
// #### Scenario: Every terminal Temporal failure is namespace-specific bounded and fail-forward safe
test('bbx-temporal-bootstrap-021: namespace verification terminal diagnostic is bounded and actionable', () => {
  const job = temporalBootstrapJob(renderChart());
  const result = runBootstrap(job, { namespaceNeverVerifies: true });
  assertTerminalDiagnostic(result, { target: /namespace|verify/i });
});

// bbx-temporal-bootstrap-022 | fn-temporal-bootstrap-failure-diagnostics
// #### Scenario: Every terminal Temporal failure is namespace-specific bounded and fail-forward safe
test('bbx-temporal-bootstrap-022: incompatible-type terminal diagnostic is bounded and actionable', () => {
  const job = temporalBootstrapJob(renderChart());
  const attributes = ['tenantId', 'workspaceId', 'flowId', 'flowVersion', 'triggerType'];
  const result = runBootstrap(job, {
    initialState: {
      namespace: true,
      attributes,
      attributeTypes: {
        ...Object.fromEntries(attributes.map((name) => [name, 'Keyword'])),
        flowId: 'Text',
      },
    },
  });
  assertTerminalDiagnostic(result, { target: /flowId|incompatible|type/i });
});

// bbx-temporal-bootstrap-023 | fn-temporal-bootstrap-failure-diagnostics
// #### Scenario: Every terminal Temporal failure is namespace-specific bounded and fail-forward safe
test('bbx-temporal-bootstrap-023: retry-exhaustion terminal diagnostic is bounded and actionable', () => {
  const job = temporalBootstrapJob(renderChart());
  const result = runBootstrap(job, {
    initialState: {
      namespace: true,
      attributes: ['tenantId', 'workspaceId'],
      attributeTypes: { tenantId: 'Keyword', workspaceId: 'Keyword' },
    },
    failAttribute: 'flowId',
  });
  assertTerminalDiagnostic(result, { target: /flowId|search.attribute/i });
});

// bbx-temporal-bootstrap-024 | fn-temporal-bootstrap-failure-diagnostics
// #### Scenario: Every terminal Temporal failure is namespace-specific bounded and fail-forward safe
test('bbx-temporal-bootstrap-024: list-failure terminal diagnostic is bounded and actionable', () => {
  const job = temporalBootstrapJob(renderChart());
  const result = runBootstrap(job, {
    initialState: { namespace: true, attributes: [], attributeTypes: {} },
    listFailure: true,
  });
  assertTerminalDiagnostic(result, { target: /list|readback/i });
});

// bbx-temporal-bootstrap-025 | fn-temporal-bootstrap-failure-diagnostics
// #### Scenario: Every terminal Temporal failure is namespace-specific bounded and fail-forward safe
test('bbx-temporal-bootstrap-025: final-drift terminal diagnostic is bounded and actionable', () => {
  const job = temporalBootstrapJob(renderChart());
  const result = runBootstrap(job, {
    dropAttributeAfterCreate: { on: 'triggerType', drop: 'tenantId' },
  });
  assertTerminalDiagnostic(result, { target: /final|readback|tenantId/i });
});

// bbx-temporal-bootstrap-026 | fn-temporal-bootstrap-consumer-gate
// #### Scenario: User init containers remain additive to the mandatory Temporal gate
test('bbx-temporal-bootstrap-026: user values cannot collide with the reserved mandatory-gate name', () => {
  const collision = {
    name: 'wait-for-temporal-bootstrap',
    image: 'docker.io/library/busybox:1.36.1',
    command: ['/bin/sh', '-ec', 'true'],
  };
  const result = renderChartResult({
    extraArgs: [
      '--set-json',
      `workflowWorker.initContainers=${JSON.stringify([collision])}`,
    ],
  });
  assert.notEqual(result.status, 0, 'reserved gate-name collision must fail before apply');
  assert.match(
    `${result.stdout}${result.stderr}`,
    /workflowWorker\.initContainers|wait-for-temporal-bootstrap|reserved|mandatory/i,
  );
});

// bbx-temporal-bootstrap-027 | fn-temporal-bootstrap-security
// #### Scenario: Inherited Temporal security IDs are stripped from every OpenShift container
test('bbx-temporal-bootstrap-027: explicit inherited IDs cannot pin OpenShift Temporal server containers', () => {
  const documents = renderChart({
    extraArgs: [
      '-f', 'charts/in-falcone/values/platform-openshift.yaml',
      '--set', 'temporal.securityContext.runAsUser=1000',
      '--set', 'temporal.securityContext.runAsGroup=1000',
    ],
  });
  const servers = documents.filter((document) =>
    document.kind === 'Deployment'
      && /-temporal-(?:frontend|history|matching|worker)$/.test(document.metadata?.name ?? ''));
  assert.equal(servers.length, 4);
  const containers = servers.flatMap((deployment) => [
    ...(deployment.spec.template.spec.initContainers ?? []),
    ...(deployment.spec.template.spec.containers ?? []),
  ]);
  assert.deepEqual(
    new Set(containers.map((container) => container.name)),
    new Set([
      'temporal-frontend',
      'temporal-history',
      'temporal-matching',
      'wait-for-frontend',
      'temporal-worker',
    ]),
  );
  for (const container of containers) {
    assertRestrictedContainer(container, { numericIdentity: false });
  }
});

// bbx-temporal-bootstrap-028 | fn-temporal-bootstrap-consumer-gate
// #### Scenario: Workflow component identity cannot bypass the mandatory Temporal gate
test('bbx-temporal-bootstrap-028: workflow component identity divergence fails before render', () => {
  const result = renderChartResult({
    extraArgs: [
      '--set-string',
      'workflowWorker.wrapper.componentId=renamed-worker',
    ],
  });
  assert.notEqual(result.status, 0, 'renaming the mandatory gated component must fail before apply');
  assert.match(
    `${result.stdout}${result.stderr}`,
    /workflowWorker\.wrapper\.componentId|renamed-worker|flows-worker|mandatory.*gate/i,
  );
});

// bbx-temporal-bootstrap-029 | fn-temporal-bootstrap-image-contract
// #### Scenario: Bootstrap Job and mandatory gate share the authoritative admin-tools image
test('bbx-temporal-bootstrap-029: global admin-tools image authority configures both consumers', () => {
  const digest = `sha256:${'a'.repeat(64)}`;
  const repository = 'registry.example.test/team/admin-tools';
  const documents = renderChart({
    extraArgs: [
      '--set-string', `global.temporalAdminToolsImage.repository=${repository}`,
      '--set-string', 'global.temporalAdminToolsImage.tag=9.9.9',
      '--set-string', `global.temporalAdminToolsImage.digest=${digest}`,
      '--set-string', 'global.temporalAdminToolsImage.pullPolicy=Always',
    ],
  });
  const jobContainer = temporalBootstrapJob(documents).spec.template.spec.containers[0];
  const gateContainer = workflowGates(workflowConsumer(documents))[0];
  const jobImage = jobContainer.image;
  assert.equal(gateContainer.image, jobImage);
  assert.match(jobImage, new RegExp(`^${repository.replaceAll('.', '\\.')}(?::9\\.9\\.9)?@${digest}$`));
  assert.equal(jobContainer.imagePullPolicy, 'Always');
  assert.equal(gateContainer.imagePullPolicy, 'Always');
});

// bbx-temporal-bootstrap-030 | fn-temporal-bootstrap-image-contract
// #### Scenario: Bootstrap Job and mandatory gate share the authoritative admin-tools image
test('bbx-temporal-bootstrap-030: global registry and pull secret apply identically to Job and gate', () => {
  const documents = renderChart({
    extraArgs: [
      '--set-string', 'global.imageRegistry=registry.example.test/falcone',
      '--set-string', 'global.imagePullSecrets[0].name=bbx-regcred',
    ],
  });
  const job = temporalBootstrapJob(documents);
  const worker = workflowConsumer(documents);
  const gate = workflowGates(worker)[0];
  assert.equal(gate.image, job.spec.template.spec.containers[0].image);
  assert.match(gate.image, /^registry\.example\.test\/falcone\/temporalio\/admin-tools:/);
  assert.deepEqual(job.spec.template.spec.imagePullSecrets, [{ name: 'bbx-regcred' }]);
  assert.deepEqual(worker.spec.template.spec.imagePullSecrets, [{ name: 'bbx-regcred' }]);
});

// bbx-temporal-bootstrap-031 | fn-temporal-bootstrap-image-contract
// #### Scenario: Bootstrap Job and mandatory gate share the authoritative admin-tools image
test('bbx-temporal-bootstrap-031: historical image values fail closed or cannot divert the authority', () => {
  const historicalRepository = 'legacy.example.test/team/admin-tools';
  const historical = renderChartResult({
    extraArgs: [
      '--set-string', `temporal.adminTools.image.repository=${historicalRepository}`,
      '--set-string', 'temporal.adminTools.image.tag=9.9.9',
    ],
  });
  assert.notEqual(
    historical.status,
    0,
    'reused custom legacy image values without the global authority must fail before apply',
  );
  assert.equal(historical.stdout.trim(), '', 'failed migration validation must render no resources');
  assert.match(
    historical.stderr,
    /temporal\.adminTools\.image[\s\S]*(?:migrat|global\.temporalAdminToolsImage)|(?:migrat|global\.temporalAdminToolsImage)[\s\S]*temporal\.adminTools\.image/i,
    'failure must identify the legacy key and its global migration target',
  );

  const authoritativeRepository = 'registry.example.test/team/admin-tools';
  const staleWorker = renderChartResult({
    extraArgs: [
      '--set-string', `global.temporalAdminToolsImage.repository=${authoritativeRepository}`,
      '--set-string', 'global.temporalAdminToolsImage.tag=9.9.9',
      '--set-string', 'workflowWorker.temporalBootstrapImage.repository=legacy.example.test/wrong',
      '--set-string', 'workflowWorker.temporalBootstrapImage.tag=0.0.1',
    ],
  });

  assert.notEqual(
    staleWorker.status,
    0,
    'workflowWorker.temporalBootstrapImage must be rejected before it can divert the mandatory gate',
  );
  assert.equal(staleWorker.stdout.trim(), '', 'rejected stale worker values must render no resources');
  assert.match(
    staleWorker.stderr,
    /workflowWorker\.temporalBootstrapImage[\s\S]*(?:migrat|global\.temporalAdminToolsImage)|(?:migrat|global\.temporalAdminToolsImage)[\s\S]*workflowWorker\.temporalBootstrapImage/i,
    'failure must identify the stale worker key and its global migration target',
  );
});

// bbx-temporal-bootstrap-032 | fn-temporal-bootstrap-failure-diagnostics
// #### Scenario: Every frontend and gate terminal branch reports namespace bound and fail-forward guidance
test('bbx-temporal-bootstrap-032: Job frontend terminal diagnostic includes application namespace and bound', () => {
  const job = temporalBootstrapJob(renderChart());
  const result = runBootstrap(job, { health: 'down' });
  assertTerminalDiagnostic(result, { target: /frontend/i });
});

// bbx-temporal-bootstrap-033 | fn-temporal-bootstrap-failure-diagnostics
// #### Scenario: Every frontend and gate terminal branch reports namespace bound and fail-forward guidance
test('bbx-temporal-bootstrap-033: gate frontend terminal diagnostic includes namespace and bound', () => {
  const gate = workflowGates(workflowConsumer(renderChart()))[0];
  const result = runRenderedContainer(gate, { health: 'down' });
  assertTerminalDiagnostic(result, { target: /frontend/i });
});

// bbx-temporal-bootstrap-034 | fn-temporal-bootstrap-failure-diagnostics
// #### Scenario: Every frontend and gate terminal branch reports namespace bound and fail-forward guidance
test('bbx-temporal-bootstrap-034: gate namespace terminal diagnostic includes numeric finite bound', () => {
  const gate = workflowGates(workflowConsumer(renderChart()))[0];
  const result = runRenderedContainer(gate, {
    initialState: { namespace: false, attributes: [], attributeTypes: {} },
  });
  assertTerminalDiagnostic(result, { target: /namespace|verification/i });
});

// bbx-temporal-bootstrap-035 | fn-temporal-bootstrap-failure-diagnostics
// #### Scenario: Every frontend and gate terminal branch reports namespace bound and fail-forward guidance
test('bbx-temporal-bootstrap-035: gate list terminal diagnostic includes numeric finite bound', () => {
  const gate = workflowGates(workflowConsumer(renderChart()))[0];
  const result = runRenderedContainer(gate, {
    initialState: { namespace: true, attributes: [], attributeTypes: {} },
    listFailure: true,
  });
  assertTerminalDiagnostic(result, { target: /list|readback/i });
});

// bbx-temporal-bootstrap-036 | fn-temporal-bootstrap-failure-diagnostics
// #### Scenario: Every frontend and gate terminal branch reports namespace bound and fail-forward guidance
test('bbx-temporal-bootstrap-036: gate missing-attribute terminal diagnostic includes numeric finite bound', () => {
  const gate = workflowGates(workflowConsumer(renderChart()))[0];
  const result = runRenderedContainer(gate, {
    initialState: {
      namespace: true,
      attributes: ['tenantId', 'workspaceId', 'flowId', 'flowVersion'],
      attributeTypes: {
        tenantId: 'Keyword',
        workspaceId: 'Keyword',
        flowId: 'Keyword',
        flowVersion: 'Keyword',
      },
    },
  });
  assertTerminalDiagnostic(result, { target: /triggerType|missing/i });
});

// bbx-temporal-bootstrap-037 | fn-temporal-bootstrap-image-contract
// #### Scenario: OCI identity evidence reconstructs the final filesystem across layers and whiteouts
test('bbx-temporal-bootstrap-037: raw OCI layers reconstruct each final named user as 1000:1000', () => {
  const rawDir = path.join(
    repoRoot,
    'tests/blackbox/fixtures/temporal-bootstrap/oci',
  );
  const images = [
    {
      reference: 'docker.io/temporalio/server:1.31.1',
      repository: 'temporalio/server',
      basename: 'temporalio-server-1.31.1',
      indexDigest: 'sha256:5728db90c9883f5b2a7b8ea0bcdfb84edbc9f6c14479cd3354957aa77d4b8bac',
      identityLayerDigest: 'sha256:b48a6463f7f35c2ecf2936910addba16f1eb79cefcee39d108f5518c0cbc52fd',
    },
    {
      reference: 'docker.io/temporalio/admin-tools:1.31.1',
      repository: 'temporalio/admin-tools',
      basename: 'temporalio-admin-tools-1.31.1',
      indexDigest: 'sha256:0fa94393f6254dea05df1cdacb7a8ee95f6fb51a2ffbde0c6847a73037f788c7',
      identityLayerDigest: 'sha256:b48a6463f7f35c2ecf2936910addba16f1eb79cefcee39d108f5518c0cbc52fd',
    },
    {
      reference: 'docker.io/temporalio/ui:2.51.0',
      repository: 'temporalio/ui',
      basename: 'temporalio-ui-2.51.0',
      indexDigest: 'sha256:5c72329a014fb247ef66d051dd45b3a5c251d06f82709a852e364f0fd8b69a04',
      identityLayerDigest: 'sha256:c0adb3b94520b298123acf1455bb29c28cb4f205d313d6d8459b33f5ef5e7a38',
    },
  ];

  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'falcone-temporal-oci-bbx-'));
  try {
    for (const image of images) {
      const indexRaw = Buffer.from(
        fs.readFileSync(path.join(rawDir, `${image.basename}.index.json.b64`), 'utf8'),
        'base64',
      );
      assert.equal(sha256(indexRaw), image.indexDigest, `${image.reference} tag index drifted`);
      const index = JSON.parse(indexRaw.toString('utf8'));
      const linuxAmd64 = index.manifests.filter((manifest) =>
        manifest.platform?.os === 'linux' && manifest.platform?.architecture === 'amd64');
      assert.equal(linuxAmd64.length, 1, `${image.reference} must select one linux/amd64 manifest`);

      const manifestRaw = Buffer.from(
        fs.readFileSync(path.join(rawDir, `${image.basename}.manifest.json.b64`), 'utf8'),
        'base64',
      );
      assert.equal(sha256(manifestRaw), linuxAmd64[0].digest);
      assert.equal(manifestRaw.length, linuxAmd64[0].size);
      const manifest = JSON.parse(manifestRaw.toString('utf8'));

      const configRaw = Buffer.from(
        fs.readFileSync(path.join(rawDir, `${image.basename}.config.json.b64`), 'utf8'),
        'base64',
      );
      assert.equal(sha256(configRaw), manifest.config.digest);
      assert.equal(configRaw.length, manifest.config.size);
      const config = JSON.parse(configRaw.toString('utf8'));
      assert.equal(config.config?.User, 'temporal');

      assert.equal(
        manifest.layers.filter((layer) => layer.digest === image.identityLayerDigest).length,
        1,
        'identity layer must be digest-bound by the manifest',
      );
      let identityState = {};
      for (const layer of manifest.layers) {
        const layerPath = dockerHubLayer(image.repository, layer.digest, layer.size, cacheDir);
        assert.equal(sha256File(layerPath), layer.digest);
        assert.equal(fs.statSync(layerPath).size, layer.size);
        identityState = layerIdentityState(identityState, layerPath);
      }
      assert.match(identityState['etc/passwd'] ?? '', /^temporal:x:1000:1000:/m);
      assert.match(identityState['etc/group'] ?? '', /^temporal:x:1000:/m);
    }
  } finally {
    assert.ok(cacheDir.startsWith(`${os.tmpdir()}${path.sep}falcone-temporal-oci-bbx-`));
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
  assert.equal(fs.existsSync(cacheDir), false, 'OCI layer cache must be discarded after each run');

  const documents = renderChart();
  const bootstrap = temporalBootstrapJob(documents);
  const worker = workflowConsumer(documents);
  const servers = documents.filter((document) =>
    document.kind === 'Deployment'
      && document.metadata?.labels?.['app.kubernetes.io/part-of'] === 'temporal');
  const renderedImages = new Set([
    bootstrap.spec.template.spec.containers[0].image,
    workflowGates(worker)[0].image,
    ...servers.flatMap((deployment) => [
      ...(deployment.spec.template.spec.initContainers ?? []),
      ...(deployment.spec.template.spec.containers ?? []),
    ]).map((container) => container.image),
  ]);
  assert.deepEqual(renderedImages, new Set(images.map((image) => image.reference)));
});

// bbx-temporal-bootstrap-038 | fn-temporal-bootstrap-security
// #### Scenario: Vanilla preserves supported positive identity overrides while OpenShift strips fixed identities
test('bbx-temporal-bootstrap-038: supported vanilla IDs survive while OpenShift strips them', () => {
  const overrideArgs = [
    '--set', 'temporal.podSecurityContext.runAsUser=4242',
    '--set', 'temporal.podSecurityContext.runAsGroup=4242',
    '--set', 'temporal.podSecurityContext.fsGroup=4242',
    '--set', 'temporal.securityContext.runAsUser=4242',
    '--set', 'temporal.securityContext.runAsGroup=4242',
    '--set', 'temporal.securityContext.fsGroup=4242',
  ];
  const vanillaRender = renderChartResult({ extraArgs: overrideArgs });
  assertKubeconformStrict(vanillaRender);
  const vanilla = parseRenderedDocuments(vanillaRender.stdout);
  const vanillaPods = [
    temporalBootstrapJob(vanilla).spec.template.spec,
    ...vanilla.filter((document) =>
      document.kind === 'Deployment'
        && document.metadata?.labels?.['app.kubernetes.io/part-of'] === 'temporal')
      .map((deployment) => deployment.spec.template.spec),
  ];
  assert.equal(vanillaPods.length, 6, 'Job plus five Temporal server/web deployments are required');
  for (const pod of vanillaPods) {
    assert.equal(pod.securityContext?.runAsUser, 4242);
    assert.equal(pod.securityContext?.runAsGroup, 4242);
    assert.equal(pod.securityContext?.fsGroup, 4242);
    for (const container of [...(pod.initContainers ?? []), ...(pod.containers ?? [])]) {
      assertRestrictedContainer(container, { numericIdentity: null });
      assert.equal(container.securityContext?.runAsUser, 4242);
      assert.equal(container.securityContext?.runAsGroup, 4242);
    }
  }

  const openShiftRender = renderChartResult({
    extraArgs: [
      '-f', 'charts/in-falcone/values/platform-openshift.yaml',
      ...overrideArgs,
    ],
  });
  assertKubeconformStrict(openShiftRender);
  const openShift = parseRenderedDocuments(openShiftRender.stdout);
  const openShiftPods = [
    temporalBootstrapJob(openShift).spec.template.spec,
    ...openShift.filter((document) =>
      document.kind === 'Deployment'
        && document.metadata?.labels?.['app.kubernetes.io/part-of'] === 'temporal')
      .map((deployment) => deployment.spec.template.spec),
  ];
  assert.equal(openShiftPods.length, 6);
  for (const pod of openShiftPods) assertOpenShiftPodSecurity(pod);
});

// bbx-temporal-bootstrap-039 | fn-temporal-bootstrap-image-contract
// #### Scenario: Legacy and global image equality normalizes absent and empty digests
test('bbx-temporal-bootstrap-039: empty and omitted digests are equal but real drift fails closed', () => {
  const repository = 'registry.example.test/team/admin-tools';
  const common = [
    '--set-string', `global.temporalAdminToolsImage.repository=${repository}`,
    '--set-string', 'global.temporalAdminToolsImage.tag=9.9.9',
    '--set-string', 'global.temporalAdminToolsImage.pullPolicy=Always',
    '--set-string', `temporal.adminTools.image.repository=${repository}`,
    '--set-string', 'temporal.adminTools.image.tag=9.9.9',
    '--set-string', 'temporal.adminTools.image.pullPolicy=Always',
  ];
  for (const digestArg of [
    ['--set-string', 'temporal.adminTools.image.digest='],
    ['--set-string', 'global.temporalAdminToolsImage.digest='],
  ]) {
    const documents = renderChart({ extraArgs: [...common, ...digestArg] });
    const jobImage = temporalBootstrapJob(documents).spec.template.spec.containers[0].image;
    const gateImage = workflowGates(workflowConsumer(documents))[0].image;
    assert.equal(jobImage, `${repository}:9.9.9`);
    assert.equal(gateImage, jobImage);
  }

  const digest = `sha256:${'a'.repeat(64)}`;
  const matching = renderChart({
    extraArgs: [
      ...common,
      '--set-string', `global.temporalAdminToolsImage.digest=${digest}`,
      '--set-string', `temporal.adminTools.image.digest=${digest}`,
    ],
  });
  const matchingImage = temporalBootstrapJob(matching).spec.template.spec.containers[0].image;
  assert.equal(matchingImage, `${repository}@${digest}`);
  assert.equal(workflowGates(workflowConsumer(matching))[0].image, matchingImage);

  const divergent = renderChartResult({
    extraArgs: [
      ...common,
      '--set-string', `global.temporalAdminToolsImage.digest=${digest}`,
      '--set-string', `temporal.adminTools.image.digest=sha256:${'b'.repeat(64)}`,
    ],
  });
  assert.notEqual(divergent.status, 0);
  assert.equal(divergent.stdout.trim(), '');
  assert.match(
    divergent.stderr,
    /temporal\.adminTools\.image[\s\S]*(?:diverg|migrat|global\.temporalAdminToolsImage)/i,
  );
});

// bbx-temporal-bootstrap-040 | fn-temporal-bootstrap-job-discovery
// #### Scenario: Public Job selectors resolve install upgrade and truncated release names
test('bbx-temporal-bootstrap-040: release revision and lifecycle labels select one current Job', () => {
  const longRelease = 'a'.repeat(53);
  const cases = [
    { release: releaseName, upgrade: false, lifecycle: 'install' },
    { release: releaseName, upgrade: true, lifecycle: 'upgrade' },
    { release: longRelease, upgrade: false, lifecycle: 'install' },
    { release: longRelease, upgrade: true, lifecycle: 'upgrade' },
  ];
  const selectOne = (documents, labels) => {
    const matches = documents.filter((document) =>
      document.kind === 'Job'
        && Object.entries(labels).every(([key, value]) => document.metadata?.labels?.[key] === value));
    assert.equal(matches.length, 1, `selector must resolve exactly one Job, received ${matches.length}`);
    return matches[0];
  };

  for (const item of cases) {
    const documents = renderChart({ release: item.release, upgrade: item.upgrade });
    const labels = {
      'app.kubernetes.io/instance': item.release,
      'app.kubernetes.io/component': 'temporal-bootstrap',
      'falcone.io/helm-release-revision': '1',
      'falcone.io/helm-lifecycle': item.lifecycle,
    };
    const selected = selectOne(documents, labels);
    assert.equal(selected.metadata.name, temporalBootstrapJob(documents).metadata.name);
    assert.ok(selected.metadata.name.length <= 63);
    assert.ok(selected.metadata.name.endsWith(
      item.upgrade ? '-r1-upgrade-temporal-bootstrap' : '-r1-temporal-bootstrap',
    ));
    assert.throws(() => selectOne(documents, { ...labels, 'falcone.io/helm-release-revision': '999' }));
    assert.throws(() => selectOne([...documents, structuredClone(selected)], labels));
  }
});

// bbx-temporal-bootstrap-041 | fn-temporal-bootstrap-job-discovery
// #### Scenario: Public Job selectors resolve install upgrade and truncated release names
test('bbx-temporal-bootstrap-041: documented selector is lifecycle-aware and fails closed', () => {
  const runbook = fs.readFileSync(
    path.join(repoRoot, 'charts/in-falcone/docs/temporal-bootstrap-readiness.md'),
    'utf8',
  );
  for (const key of [
    'app.kubernetes.io/instance',
    'app.kubernetes.io/component',
    'falcone.io/helm-release-revision',
    'falcone.io/helm-lifecycle',
  ]) {
    assert.match(runbook, new RegExp(key.replaceAll('.', '\\.'), 'i'));
  }
  assert.match(runbook, /ACTIVE_REVISION/);
  assert.match(runbook, /effective_revision/);
  assert.match(runbook, /effective_lifecycle/);
  assert.match(
    runbook,
    /helm\s+get\s+manifest[^\n]*--revision[^\n]*ACTIVE_REVISION/i,
  );
  assert.match(
    runbook,
    /selector=[^\n]*helm-release-revision=\$effective_revision[^\n]*helm-lifecycle=\$effective_lifecycle/i,
  );
  assert.match(runbook, /(?:-ne|!=)\s*["']?1|exactly one/i);
  assert.doesNotMatch(runbook, /JOB_NAME=["']\$\{RELEASE_NAME\}-temporal-r/);
});

// bbx-temporal-bootstrap-042 | fn-temporal-bootstrap-operator-runbook
// #### Scenario: Legacy image migration is copyable and linked from the chart README
test('bbx-temporal-bootstrap-042: documented image migration examples render unchanged', () => {
  const runbookPath = path.join(repoRoot, 'charts/in-falcone/docs/temporal-bootstrap-readiness.md');
  const chartReadmePath = path.join(repoRoot, 'charts/in-falcone/README.md');
  const runbook = fs.readFileSync(runbookPath, 'utf8');
  const yamlBlocks = [...runbook.matchAll(/```ya?ml\s*\n([\s\S]*?)```/gi)]
    .flatMap((match) => parseAllDocuments(match[1]).map((document) => document.toJS()))
    .filter((document) => document?.global?.temporalAdminToolsImage);
  const defaults = yamlBlocks.find((document) => {
    const image = document.global.temporalAdminToolsImage;
    return image.repository === 'docker.io/temporalio/admin-tools'
      && String(image.tag) === '1.31.1'
      && (image.digest ?? '') === ''
      && image.pullPolicy === 'IfNotPresent';
  });
  const custom = yamlBlocks.find((document) => {
    const image = document.global.temporalAdminToolsImage;
    return image.repository !== 'docker.io/temporalio/admin-tools'
      && /^sha256:[0-9a-f]{64}$/.test(image.digest ?? '')
      && typeof image.pullPolicy === 'string';
  });
  assert.ok(defaults, 'runbook must include a copyable shipped-default values example');
  assert.ok(custom, 'runbook must include a copyable custom digest-pinned values example');
  assert.match(
    runbook,
    /(?:copy|migrat)[\s\S]*repository[\s\S]*tag[\s\S]*digest[\s\S]*pullPolicy/i,
  );
  assert.match(runbook, /temporal\.adminTools\.image/);

  for (const values of [defaults, custom]) {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'falcone-temporal-values-bbx-'));
    try {
      const valuesPath = path.join(sandbox, 'values.yaml');
      fs.writeFileSync(valuesPath, stringify(values));
      const documents = renderChart({ extraArgs: ['-f', valuesPath] });
      const jobImage = temporalBootstrapJob(documents).spec.template.spec.containers[0].image;
      assert.equal(workflowGates(workflowConsumer(documents))[0].image, jobImage);
      if (values.global.temporalAdminToolsImage.digest) {
        assert.ok(jobImage.endsWith(`@${values.global.temporalAdminToolsImage.digest}`));
      }
    } finally {
      assert.ok(sandbox.startsWith(`${os.tmpdir()}${path.sep}falcone-temporal-values-bbx-`));
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  }

  assert.ok(fs.existsSync(chartReadmePath), 'chart README must exist and link the operator runbook');
  const chartReadme = fs.readFileSync(chartReadmePath, 'utf8');
  assert.match(chartReadme, /docs\/temporal-bootstrap-readiness\.md/i);
});

// bbx-temporal-bootstrap-043 | fn-temporal-bootstrap-change-isolation
// #### Scenario: Temporal remediation preserves unrelated Keycloak database initialization
test('bbx-temporal-bootstrap-043: keycloak-db-init is byte-identical to base 41922e9d', () => {
  const findKeycloakDbInit = (documents) => {
    const containers = documents.flatMap((document) =>
      document.kind === 'Deployment' ? (document.spec?.template?.spec?.initContainers ?? []) : []);
    const matches = containers.filter((container) => container.name === 'keycloak-db-init');
    assert.equal(matches.length, 1, 'public render must contain exactly one keycloak-db-init container');
    return matches[0];
  };
  const baseline = findKeycloakDbInit(renderChartAtRevision('41922e9d'));
  const current = findKeycloakDbInit(renderChart());
  assert.equal(
    JSON.stringify(current),
    JSON.stringify(baseline),
    'Temporal remediation must not change the unrelated keycloak-db-init runtime contract',
  );
});

// bbx-temporal-bootstrap-044 | fn-temporal-bootstrap-consumer-gate
// #### Scenario: Templated user init container names cannot collide with the reserved Temporal gate
test('bbx-temporal-bootstrap-044: post-tpl reserved gate-name collision fails before render', () => {
  const collision = {
    name: '{{ printf "wait-for-%s-bootstrap" "temporal" }}',
    image: 'docker.io/library/busybox:1.36.1',
    command: ['/bin/sh', '-ec', 'true'],
  };
  const result = renderChartResult({
    extraArgs: [
      '--set-json',
      `workflowWorker.initContainers=${JSON.stringify([collision])}`,
    ],
  });
  assert.notEqual(result.status, 0, 'effective post-tpl name must be validated before apply');
  assert.equal(result.stdout.trim(), '', 'reserved-name collision must render no resources');
  assert.match(
    result.stderr,
    /workflowWorker\.initContainers[\s\S]*(?:effective|rendered|tpl|reserved|collision)[\s\S]*wait-for-temporal-bootstrap/i,
  );
});

// bbx-temporal-bootstrap-045 | fn-temporal-bootstrap-image-contract
// #### Scenario: Reused pre-global image values preserve defaults and fail closed on custom legacy drift
test('bbx-temporal-bootstrap-045: pre-global Helm values coalesce compatibly and reject custom drift', () => {
  const historical = chartValuesAtRevision('41922e9d');
  assert.equal(
    historical.global?.temporalAdminToolsImage,
    undefined,
    'authoritative pre-global values must genuinely predate the new global key',
  );
  const historicalImage = structuredClone(historical.temporal?.adminTools?.image);
  assert.ok(historicalImage, 'pre-global values must expose the real legacy image input');
  const renderHistorical = (image) => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'falcone-temporal-reuse-bbx-'));
    try {
      const valuesPath = path.join(sandbox, 'reused-values.yaml');
      fs.writeFileSync(valuesPath, stringify({ temporal: { adminTools: { image } } }));
      return renderChartResult({ extraArgs: ['-f', valuesPath] });
    } finally {
      assert.ok(sandbox.startsWith(`${os.tmpdir()}${path.sep}falcone-temporal-reuse-bbx-`));
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  };

  const exactDefault = renderHistorical(historicalImage);
  assert.equal(exactDefault.status, 0, exactDefault.stderr);
  const exactDocuments = parseRenderedDocuments(exactDefault.stdout);
  assert.equal(
    temporalBootstrapJob(exactDocuments).spec.template.spec.containers[0].image,
    'docker.io/temporalio/admin-tools:1.31.1',
  );

  const customLegacy = renderHistorical({
    ...historicalImage,
    repository: 'legacy.example.test/team/admin-tools',
  });
  assert.notEqual(customLegacy.status, 0, 'custom pre-global legacy values require explicit migration');
  assert.equal(customLegacy.stdout.trim(), '');
  assert.match(customLegacy.stderr, /temporal\.adminTools\.image/i);
  assert.match(customLegacy.stderr, /global\.temporalAdminToolsImage/i);
  assert.match(customLegacy.stderr, /migrat|copy/i);
});

// bbx-temporal-bootstrap-046 | fn-temporal-bootstrap-job-discovery
// #### Scenario: Rollback Job discovery follows the deployed stored manifest metadata
test('bbx-temporal-bootstrap-046: discovery follows effective stored Job metadata across rollback', () => {
  const runbook = fs.readFileSync(
    path.join(repoRoot, 'charts/in-falcone/docs/temporal-bootstrap-readiness.md'),
    'utf8',
  );
  const shellBlocks = [...runbook.matchAll(/```(?:sh|bash)\s*\n([\s\S]*?)```/gi)]
    .map((match) => match[1]);
  const procedure = shellBlocks.find((block) =>
    /helm\s+history/.test(block)
      && /helm\s+get\s+manifest/.test(block)
      && /kubectl[\s\S]+get\s+jobs/.test(block));
  assert.ok(
    procedure,
    'runbook must derive effective Job labels from `helm get manifest --revision ACTIVE`',
  );

  const storedJob = ({
    name,
    revision,
    lifecycle,
    component = 'temporal-bootstrap',
  }) => ({
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name,
      labels: {
        'app.kubernetes.io/instance': releaseName,
        'app.kubernetes.io/component': component,
        ...(revision === undefined ? {} : { 'falcone.io/helm-release-revision': String(revision) }),
        ...(lifecycle === undefined ? {} : { 'falcone.io/helm-lifecycle': lifecycle }),
      },
    },
  });

  const execute = ({ history, manifestJobs, liveJobs }) => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'falcone-temporal-runbook-bbx-'));
    try {
      const helmLog = path.join(sandbox, 'helm.log');
      const kubectlLog = path.join(sandbox, 'kubectl.log');
      writeExecutable(path.join(sandbox, 'helm'), `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_HELM_LOG"
case " $* " in
  *" history "*) printf '%s\\n' "$FAKE_HELM_HISTORY" ;;
  *" get manifest "*) printf '%s' "$FAKE_HELM_MANIFEST" ;;
  *) echo "unexpected helm invocation: $*" >&2; exit 64 ;;
esac
`);
      writeExecutable(path.join(sandbox, 'kubectl'), `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_KUBECTL_LOG"
case " $* " in
  *" get jobs "*"jsonpath"*) printf '%b' "$FAKE_JOB_NAMES" ;;
  *" get jobs "*" -o json "*) printf '%s\\n' "$FAKE_JOBS_JSON" ;;
  *" get jobs "*" -o name "*) printf '%b' "$FAKE_JOB_RESOURCES" ;;
  *" get jobs "*) printf 'NAME\\n'; printf '%b' "$FAKE_JOB_NAMES" ;;
  *" logs "*)
    case " $* " in *" job/ "*|*" job/" ) echo 'refusing empty job/ target' >&2; exit 65 ;; esac
    printf 'bootstrap log\\n'
    ;;
  *" rollout status "*) printf 'rollout complete\\n' ;;
  *) echo "unexpected kubectl invocation: $*" >&2; exit 66 ;;
esac
`);
      const items = liveJobs.map((job) => ({ metadata: job.metadata }));
      const manifest = manifestJobs
        .map((job) => `---\n${stringify(job)}`)
        .join('');
      const result = spawnSync('bash', ['-euo', 'pipefail', '-c', procedure], {
        cwd: repoRoot,
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
        env: {
          ...process.env,
          PATH: `${sandbox}:${process.env.PATH}`,
          RELEASE_NAME: releaseName,
          RELEASE_NAMESPACE: releaseNamespace,
          FAKE_HELM_LOG: helmLog,
          FAKE_KUBECTL_LOG: kubectlLog,
          FAKE_HELM_HISTORY: JSON.stringify(history),
          FAKE_HELM_MANIFEST: manifest,
          FAKE_JOB_NAMES: `${liveJobs.map((job) => job.metadata.name).join('\n')}${liveJobs.length ? '\n' : ''}`,
          FAKE_JOB_RESOURCES: `${liveJobs.map((job) => `job.batch/${job.metadata.name}`).join('\n')}${liveJobs.length ? '\n' : ''}`,
          FAKE_JOBS_JSON: JSON.stringify({ apiVersion: 'v1', kind: 'List', items }),
        },
      });
      return {
        ...result,
        helmLog: fs.existsSync(helmLog) ? fs.readFileSync(helmLog, 'utf8') : '',
        kubectlLog: fs.existsSync(kubectlLog) ? fs.readFileSync(kubectlLog, 'utf8') : '',
      };
    } finally {
      assert.ok(sandbox.startsWith(`${os.tmpdir()}${path.sep}falcone-temporal-runbook-bbx-`));
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  };

  const histories = {
    install: [{ revision: 1, status: 'deployed', description: 'Install complete' }],
    upgrade: [
      { revision: 1, status: 'superseded', description: 'Install complete' },
      { revision: 2, status: 'deployed', description: 'Upgrade complete' },
    ],
    failed: [
      { revision: 1, status: 'superseded', description: 'Install complete' },
      { revision: 2, status: 'deployed', description: 'Upgrade complete' },
      { revision: 3, status: 'failed', description: 'Upgrade failed' },
    ],
    retry: [
      { revision: 1, status: 'superseded', description: 'Install complete' },
      { revision: 2, status: 'superseded', description: 'Upgrade complete' },
      { revision: 3, status: 'failed', description: 'Upgrade failed' },
      { revision: 4, status: 'deployed', description: 'Upgrade complete' },
    ],
    rollback: [
      { revision: 1, status: 'superseded', description: 'Install complete' },
      { revision: 2, status: 'superseded', description: 'Upgrade complete' },
      { revision: 3, status: 'superseded', description: 'Upgrade complete' },
      { revision: 4, status: 'failed', description: 'Upgrade failed' },
      { revision: 5, status: 'deployed', description: 'Rollback to 2' },
    ],
  };
  const positiveCases = [
    { name: 'install', history: histories.install, active: 1, effective: 1, lifecycle: 'install' },
    { name: 'upgrade', history: histories.upgrade, active: 2, effective: 2, lifecycle: 'upgrade' },
    { name: 'failed', history: histories.failed, active: 2, effective: 2, lifecycle: 'upgrade' },
    { name: 'retry', history: histories.retry, active: 4, effective: 4, lifecycle: 'upgrade' },
    { name: 'rollback', history: histories.rollback, active: 5, effective: 2, lifecycle: 'upgrade' },
  ];
  for (const scenario of positiveCases) {
    const job = storedJob({
      name: `${releaseName}-r${scenario.effective}-${scenario.lifecycle}-temporal-bootstrap`,
      revision: scenario.effective,
      lifecycle: scenario.lifecycle,
    });
    const result = execute({
      history: scenario.history,
      manifestJobs: [job],
      liveJobs: [job],
    });
    assert.equal(result.status, 0, `${scenario.name}: ${result.stdout}${result.stderr}`);
    assert.match(result.helmLog, /history/);
    assert.match(result.helmLog, new RegExp(`get manifest[^\\n]*${releaseName}`));
    assert.match(result.helmLog, new RegExp(`get manifest[^\\n]*(?:^|\\s)-n\\s+${releaseNamespace}(?:\\s|$)`));
    assert.match(result.helmLog, new RegExp(`get manifest[^\\n]*--revision(?:=|\\s+)${scenario.active}(?:\\s|$)`));
    assert.match(result.kubectlLog, new RegExp(`falcone\\.io/helm-release-revision=${scenario.effective}`));
    assert.match(result.kubectlLog, new RegExp(`falcone\\.io/helm-lifecycle=${scenario.lifecycle}`));
    if (scenario.name === 'rollback') {
      assert.doesNotMatch(result.kubectlLog, /falcone\.io\/helm-release-revision=5/);
    }
    assert.match(result.kubectlLog, new RegExp(`logs[\\s\\S]*job/${job.metadata.name}`));
  }

  const validR2 = storedJob({
    name: `${releaseName}-r2-upgrade-temporal-bootstrap`,
    revision: 2,
    lifecycle: 'upgrade',
  });
  const failures = [
    {
      name: 'zero manifest jobs',
      effective: /unknown|unavailable|missing|not derived/i,
      manifestJobs: [],
      liveJobs: [],
    },
    {
      name: 'two manifest jobs',
      effective: /unknown|unavailable|ambiguous|not derived/i,
      manifestJobs: [
        validR2,
        storedJob({ name: `${releaseName}-r2-duplicate-temporal-bootstrap`, revision: 2, lifecycle: 'upgrade' }),
      ],
      liveJobs: [],
    },
    {
      name: 'missing manifest revision label',
      effective: /unknown|unavailable|missing|invalid/i,
      manifestJobs: [storedJob({ name: 'missing-revision', lifecycle: 'upgrade' })],
      liveJobs: [],
    },
    {
      name: 'non-positive manifest revision label',
      effective: /0|non-positive|invalid/i,
      manifestJobs: [storedJob({ name: 'bad-revision', revision: 0, lifecycle: 'upgrade' })],
      liveJobs: [],
    },
    {
      name: 'invalid manifest lifecycle label',
      effective: /2/,
      manifestJobs: [storedJob({ name: 'bad-lifecycle', revision: 2, lifecycle: 'rollback' })],
      liveJobs: [],
    },
    {
      name: 'zero live jobs',
      effective: /2/,
      manifestJobs: [validR2],
      liveJobs: [],
    },
    {
      name: 'two live jobs',
      effective: /2/,
      manifestJobs: [validR2],
      liveJobs: [
        validR2,
        storedJob({ name: `${releaseName}-r2-live-duplicate`, revision: 2, lifecycle: 'upgrade' }),
      ],
    },
  ];
  for (const scenario of failures) {
    const result = execute({
      history: histories.rollback,
      manifestJobs: scenario.manifestJobs,
      liveJobs: scenario.liveJobs,
    });
    assert.notEqual(result.status, 0, `${scenario.name} must fail closed`);
    const diagnostic = `${result.stdout}${result.stderr}`;
    assert.match(diagnostic, new RegExp(releaseName));
    assert.match(diagnostic, new RegExp(releaseNamespace));
    assert.match(diagnostic, /active(?: Helm)? revision[^\n]*5/i);
    assert.match(diagnostic, new RegExp(`effective(?: manifest)? revision[^\\n]*${scenario.effective.source}`, 'i'));
    assert.match(diagnostic, /correct or resolve/i);
    assert.match(diagnostic, /retry to fail forward safely/i);
    assert.doesNotMatch(result.kubectlLog, /logs[^\n]*job\/(?:\s|$)/);
  }
});

// bbx-temporal-bootstrap-047 | fn-temporal-bootstrap-release-state
// #### Scenario: Release-state acceptance tracks active revision Jobs across install upgrade retry and rollback
test('bbx-temporal-bootstrap-047: offline docs separate the required live release-state acceptance', () => {
  const runbook = fs.readFileSync(
    path.join(repoRoot, 'charts/in-falcone/docs/temporal-bootstrap-readiness.md'),
    'utf8',
  );
  assert.match(runbook, /live acceptance is:/i);
  assert.match(runbook, /(?:r1|revision 1)[\s\S]*(?:r2|revision 2)[\s\S]*(?:r3|revision 3)/i);
  assert.match(runbook, /install[\s\S]*upgrade[\s\S]*(?:retry|fail-forward)[\s\S]*rollback/i);
  assert.match(runbook, /(?:immutable|unchanged)[\s\S]*(?:Job|UID|pod template)/i);
  assert.match(runbook, /active[\s\S]*(?:revision|metadata|label)/i);
  assert.match(runbook, /(?:offline|focal)[\s\S]*(?:do not|does not|cannot|must not)[\s\S]*(?:prove|replace|infer)/i);
});

// bbx-temporal-bootstrap-048 | fn-temporal-bootstrap-image-contract
// #### Scenario: Real pre-global Helm stored values remain operable under reuse-values
test('bbx-temporal-bootstrap-048: offline Helm reuse-values captures coalesced render before cluster mapping', () => {
  const historical = chartValuesAtRevision('41922e9d');
  assert.equal(
    historical.global?.temporalAdminToolsImage,
    undefined,
    'the real stored chart defaults must predate global.temporalAdminToolsImage',
  );
  const historicalImage = structuredClone(historical.temporal.adminTools.image);

  const exactDefault = runReuseValuesUpgradeFromRevision({
    revision: '41922e9d',
    legacyImage: undefined,
  });
  assert.match(exactDefault.apiLog, /GET \/api\/v1\/namespaces\/temporal-readiness-bbx\/secrets/);
  assert.doesNotMatch(exactDefault.apiLog, /^(?:POST|PUT|PATCH|DELETE)\s/m);
  assert.doesNotMatch(
    exactDefault.stderr,
    /values don't meet the specifications|missing property 'temporalAdminToolsImage'/i,
    'historical defaults must pass the current schema before public post-render',
  );
  assert.match(
    exactDefault.renderedOutput,
    /kind:\s*Job[\s\S]*app\.kubernetes\.io\/component:\s*temporal-bootstrap/,
    `public post-renderer must capture the coalesced manifest:\n${exactDefault.stdout}${exactDefault.stderr}${exactDefault.serverError}`,
  );
  const exactDocuments = parseRenderedDocuments(exactDefault.renderedOutput);
  const jobImage = temporalBootstrapJob(exactDocuments).spec.template.spec.containers[0].image;
  assert.equal(jobImage, 'docker.io/temporalio/admin-tools:1.31.1');
  assert.equal(workflowGates(workflowConsumer(exactDocuments))[0].image, jobImage);

  const customLegacy = runReuseValuesUpgradeFromRevision({
    revision: '41922e9d',
    legacyImage: {
      ...historicalImage,
      repository: 'legacy.example.test/team/admin-tools',
    },
  });
  assert.match(customLegacy.apiLog, /GET \/api\/v1\/namespaces\/temporal-readiness-bbx\/secrets/);
  assert.doesNotMatch(customLegacy.apiLog, /^(?:POST|PUT|PATCH|DELETE)\s/m);
  assert.notEqual(customLegacy.status, 0, 'custom legacy stored values must fail closed');
  assert.equal(
    customLegacy.renderedOutput.trim(),
    '',
    'custom legacy drift must fail schema/template validation before public post-render',
  );
  assert.match(customLegacy.stderr, /temporal\.adminTools\.image/i);
  assert.match(customLegacy.stderr, /global\.temporalAdminToolsImage/i);
  assert.match(customLegacy.stderr, /migrat|copy/i);
});

// bbx-temporal-bootstrap-049 | fn-temporal-bootstrap-image-contract
// #### Scenario: OCI reconstruction uses per-run cleanup and general whiteout semantics
test('bbx-temporal-bootstrap-049: OCI overlay reconstruction handles parent whiteouts and opaque directories', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'falcone-temporal-whiteout-bbx-'));
  try {
    const base = makeSyntheticLayer(sandbox, 'base', {
      'etc/passwd': 'temporal:x:1000:1000:Temporal:/home/temporal:/sbin/nologin\n',
      'etc/group': 'temporal:x:1000:\n',
    });
    const rootWhiteout = makeSyntheticLayer(sandbox, 'root-whiteout', {
      '.wh.etc': '',
    });
    let state = layerIdentityState({}, base);
    assert.match(state['etc/passwd'], /^temporal:x:1000:1000:/m);
    state = layerIdentityState(state, rootWhiteout);
    assert.deepEqual(state, {}, 'a root .wh.etc must remove all lower etc identity files');

    const opaqueEtc = makeSyntheticLayer(sandbox, 'opaque-etc', {
      'etc/.wh..wh..opq': '',
      'etc/passwd': 'temporal:x:1000:1000:Temporal:/srv/temporal:/sbin/nologin\n',
    });
    state = layerIdentityState(layerIdentityState({}, base), opaqueEtc);
    assert.match(state['etc/passwd'], /\/srv\/temporal/);
    assert.equal(state['etc/group'], undefined, 'opaque etc must hide the lower group file');

    const nestedWhiteout = makeSyntheticLayer(sandbox, 'nested-whiteout', {
      'etc/.wh.passwd': '',
    });
    state = layerIdentityState(layerIdentityState({}, base), nestedWhiteout);
    assert.equal(state['etc/passwd'], undefined);
    assert.match(state['etc/group'], /^temporal:x:1000:/m);
  } finally {
    assert.ok(sandbox.startsWith(`${os.tmpdir()}${path.sep}falcone-temporal-whiteout-bbx-`));
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
  assert.equal(fs.existsSync(sandbox), false, 'synthetic OCI layers must be discarded after the test');
});

// bbx-temporal-bootstrap-050 | fn-temporal-bootstrap-change-isolation
// #### Scenario: Knative image pins are byte-exact against the authoritative base
test('bbx-temporal-bootstrap-050: every Knative repository tag and digest matches base 41922e9d', () => {
  const lockPath = 'charts/falcone-knative/provenance/image-lock.json';
  const current = JSON.parse(fs.readFileSync(path.join(repoRoot, lockPath), 'utf8'));
  const baseline = JSON.parse(gitFileAtRevision('41922e9d', lockPath));
  const tagOf = (image) => {
    if (image.resolvedTag !== undefined) return image.resolvedTag;
    const reference = image.upstreamMutableReference;
    if (!reference) return null;
    const separator = reference.lastIndexOf(':');
    return separator > reference.lastIndexOf('/') ? reference.slice(separator + 1) : null;
  };
  const pins = (lock) => lock.images.map((image) => ({
    name: image.name,
    repository: image.repository,
    mirrorRepository: image.mirrorRepository,
    tag: tagOf(image),
    digest: image.digest,
  }));
  const currentPins = pins(current);
  const baselinePins = pins(baseline);
  assert.deepEqual(
    currentPins.map(({ name }) => name),
    baselinePins.map(({ name }) => name),
    'Knative image inventory must remain byte-exact and ordered',
  );
  for (let index = 0; index < baselinePins.length; index += 1) {
    const expected = baselinePins[index];
    const actual = currentPins[index];
    assert.equal(actual.repository, expected.repository, `${expected.name} repository drifted`);
    assert.equal(actual.mirrorRepository, expected.mirrorRepository, `${expected.name} mirror repository drifted`);
    assert.equal(actual.tag, expected.tag, `${expected.name} tag drifted`);
    assert.equal(actual.digest, expected.digest, `${expected.name} digest drifted`);
  }
});

// bbx-temporal-bootstrap-051 | fn-temporal-bootstrap-consumer-gate
// #### Scenario: Long release names keep the workflow gate and Temporal frontend address identical
test('bbx-temporal-bootstrap-051: long release uses one DNS-safe Temporal frontend address everywhere', () => {
  const longRelease = 'r'.repeat(53);
  const documents = renderChart({ release: longRelease });
  const frontendServices = documents.filter((document) =>
    document.kind === 'Service'
      && document.metadata?.labels?.['app.kubernetes.io/component'] === 'temporal-frontend');
  assert.equal(frontendServices.length, 1, 'render must expose exactly one Temporal frontend Service');
  const serviceName = frontendServices[0].metadata.name;
  assert.ok(serviceName.length <= 63, 'Temporal frontend Service name must fit one DNS label');
  assert.match(serviceName, /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/);

  const envValue = (container, name) =>
    container.env?.find((entry) => entry.name === name)?.value;
  const jobAddress = envValue(
    temporalBootstrapJob(documents).spec.template.spec.containers[0],
    'FLOW_FRONTEND_ADDR',
  );
  const gates = workflowGates(workflowConsumer(documents));
  assert.equal(gates.length, 1, 'workflow consumer must retain exactly one mandatory Temporal gate');
  const gateAddress = envValue(gates[0], 'TEMPORAL_ADDRESS');
  const expectedAddress = `${serviceName}:7233`;
  assert.equal(jobAddress, expectedAddress, 'bootstrap Job must address the rendered frontend Service');
  assert.equal(gateAddress, expectedAddress, 'mandatory gate must address the rendered frontend Service');

  const podSpecs = documents.flatMap((document) => {
    if (['Deployment', 'StatefulSet', 'DaemonSet', 'Job'].includes(document.kind)) {
      return [document.spec?.template?.spec];
    }
    if (document.kind === 'CronJob') return [document.spec?.jobTemplate?.spec?.template?.spec];
    return [];
  }).filter(Boolean);
  const renderedAddresses = podSpecs.flatMap((pod) => [
    ...(pod.initContainers ?? []),
    ...(pod.containers ?? []),
  ]).map((container) =>
    envValue(container, 'TEMPORAL_ADDRESS') ?? envValue(container, 'FLOW_FRONTEND_ADDR'))
    .filter(Boolean);
  assert.ok(renderedAddresses.length >= 3, 'render must expose all chart-owned Temporal consumers');
  assert.deepEqual(
    new Set(renderedAddresses),
    new Set([expectedAddress]),
    'no chart-owned consumer may use an untruncated or divergent Temporal hostname',
  );
});

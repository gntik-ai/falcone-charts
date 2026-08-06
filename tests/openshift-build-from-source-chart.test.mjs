import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import test from 'node:test';

const chart = 'charts/in-falcone';
const release = 'bbx';
const buildNamespace = 'custom-builds';
const imageTag = 'release-42';
const gitUri = 'https://git.example.test/acme/falcone.git';
const gitRef = 'refs/heads/feature/chart-test';
const sourceSecret = 'source-creds';
const webhookSecret = 'webhook-ref';
const registryPrefix = `image-registry.openshift-image-registry.svc:5000/${buildNamespace}/in-falcone-`;
const services = [
  'control-plane',
  'control-plane-executor',
  'web-console',
  'workflow-worker',
  'mcp-runtime',
  'fn-runtime',
];
const dockerfiles = {
  'control-plane': 'apps/control-plane/Dockerfile',
  'control-plane-executor': 'apps/control-plane-executor/Dockerfile',
  'web-console': 'apps/web-console/Dockerfile',
  'workflow-worker': 'apps/workflow-worker/Dockerfile',
  'mcp-runtime': 'apps/mcp-runtime/Dockerfile',
  'fn-runtime': 'apps/fn-runtime/Dockerfile',
};
const deploymentServices = services.slice(0, 4);

const enabledArgs = [
  '--namespace', buildNamespace,
  '--set', 'global.openshiftBuild.enabled=true',
  '--set', `global.openshiftBuild.git.uri=${gitUri}`,
  '--set', `global.openshiftBuild.git.ref=${gitRef}`,
  '--set', `global.openshiftBuild.git.sourceSecret=${sourceSecret}`,
  '--set', `global.openshiftBuild.webhookSecret=${webhookSecret}`,
  '--set', `global.openshiftBuild.tag=${imageTag}`,
];
const customResourceArgs = [
  ...enabledArgs,
  '--set', 'global.openshiftBuild.resources.requests.memory=256Mi',
  '--set', 'global.openshiftBuild.resources.limits.memory=2Gi',
  '--set', 'global.openshiftBuild.serviceResources.web-console.requests.memory=640Mi',
  '--set', 'global.openshiftBuild.serviceResources.web-console.limits.memory=4Gi',
];

function runHelm(args) {
  return spawnSync('helm', args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

function render(args = []) {
  const result = runHelm(['template', release, chart, ...args]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

function renderNotes(args = []) {
  const result = runHelm(['install', `${release}-notes`, chart, '--dry-run=client', ...args]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const marker = '\nNOTES:\n';
  const start = result.stdout.lastIndexOf(marker);
  assert.notEqual(start, -1, 'Helm dry-run output did not contain rendered NOTES');
  return result.stdout.slice(start + marker.length);
}

function expectTemplateFailure(args, errorPattern) {
  const result = runHelm(['template', release, chart, ...args]);
  assert.notEqual(result.status, 0, 'helm template unexpectedly accepted invalid values');
  assert.match(`${result.stderr}\n${result.stdout}`, errorPattern);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function scalarValue(raw) {
  const value = raw.trim();
  if (value.startsWith('"') && value.endsWith('"')) return JSON.parse(value);
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll("''", "'");
  }
  return value;
}

function yamlLocation(yaml, path) {
  const lines = yaml.split('\n');
  let start = 0;
  let end = lines.length;
  let parentIndent = -2;

  for (let pathIndex = 0; pathIndex < path.length; pathIndex += 1) {
    const key = path[pathIndex];
    const indent = parentIndent + 2;
    const keyPattern = new RegExp(`^ {${indent}}${escapeRegExp(key)}:\\s*(.*)$`);
    let found = -1;
    let raw = '';
    for (let lineIndex = start; lineIndex < end; lineIndex += 1) {
      const match = lines[lineIndex].match(keyPattern);
      if (match) {
        found = lineIndex;
        raw = match[1];
        break;
      }
    }
    if (found === -1) return undefined;

    let blockEnd = end;
    for (let lineIndex = found + 1; lineIndex < end; lineIndex += 1) {
      if (!lines[lineIndex].trim() || lines[lineIndex].trimStart().startsWith('#')) continue;
      const nextIndent = lines[lineIndex].length - lines[lineIndex].trimStart().length;
      if (nextIndent <= indent) {
        blockEnd = lineIndex;
        break;
      }
    }

    if (pathIndex === path.length - 1) {
      return {lines, start: found + 1, end: blockEnd, indent, raw};
    }
    if (raw.trim()) return undefined;
    start = found + 1;
    end = blockEnd;
    parentIndent = indent;
  }
  return undefined;
}

function yamlScalar(yaml, path) {
  const location = yamlLocation(yaml, path);
  if (!location || !location.raw.trim()) return undefined;
  return scalarValue(location.raw);
}

function yamlBlock(yaml, path) {
  const location = yamlLocation(yaml, path);
  if (!location || location.raw.trim()) return undefined;
  return location;
}

function sequenceItems(block) {
  if (!block) return [];
  const itemIndent = block.indent + 2;
  const itemPattern = new RegExp(`^ {${itemIndent}}-\\s+`);
  const starts = [];
  for (let index = block.start; index < block.end; index += 1) {
    if (itemPattern.test(block.lines[index])) starts.push(index);
  }
  return starts.map((start, index) => {
    const end = starts[index + 1] ?? block.end;
    const lines = block.lines.slice(start, end);
    return lines
      .map((line, lineIndex) => {
        if (lineIndex === 0) return line.slice(itemIndent + 2);
        return line.length >= itemIndent + 2 ? line.slice(itemIndent + 2) : line;
      })
      .join('\n');
  });
}

function documents(rendered) {
  return rendered
    .split(/^---\s*$/m)
    .map((yaml) => yaml.trim())
    .filter((yaml) => /^apiVersion:/m.test(yaml) && /^kind:/m.test(yaml))
    .map((yaml) => ({
      yaml,
      apiVersion: yamlScalar(yaml, ['apiVersion']),
      kind: yamlScalar(yaml, ['kind']),
      name: yamlScalar(yaml, ['metadata', 'name']),
    }));
}

function objectsOfKind(docs, kind) {
  return docs.filter((doc) => doc.kind === kind);
}

function oneObject(docs, kind, name) {
  const matches = docs.filter((doc) => doc.kind === kind && doc.name === name);
  assert.equal(matches.length, 1, `expected exactly one ${kind}/${name}, found ${matches.length}`);
  return matches[0];
}

function namedSequenceItem(yaml, path, name) {
  const matches = sequenceItems(yamlBlock(yaml, path))
    .filter((item) => yamlScalar(item, ['name']) === name);
  assert.equal(matches.length, 1, `expected exactly one ${path.join('.')} item named ${name}`);
  return matches[0];
}

function workloadContainers(doc) {
  const podSpec = doc.kind === 'CronJob'
    ? ['spec', 'jobTemplate', 'spec', 'template', 'spec']
    : ['spec', 'template', 'spec'];
  return ['initContainers', 'containers'].flatMap((group) =>
    sequenceItems(yamlBlock(doc.yaml, [...podSpec, group])).map((item) => ({
      group,
      name: yamlScalar(item, ['name']),
      image: yamlScalar(item, ['image']),
    })));
}

function containerImage(docs, kind, workloadName, containerName) {
  const matches = workloadContainers(oneObject(docs, kind, workloadName))
    .filter((container) => container.name === containerName);
  assert.equal(matches.length, 1, `expected exactly one ${kind}/${workloadName} container ${containerName}`);
  return matches[0].image;
}

function envValue(docs, deploymentName, containerName, envName) {
  const deployment = oneObject(docs, 'Deployment', deploymentName);
  const container = namedSequenceItem(
    deployment.yaml,
    ['spec', 'template', 'spec', 'containers'],
    containerName,
  );
  const env = namedSequenceItem(container, ['env'], envName);
  return yamlScalar(env, ['value']);
}

function buildMemory(docs, service) {
  const build = oneObject(docs, 'BuildConfig', `in-falcone-${service}`);
  return {
    request: yamlScalar(build.yaml, ['spec', 'resources', 'requests', 'memory']),
    limit: yamlScalar(build.yaml, ['spec', 'resources', 'limits', 'memory']),
  };
}

function assertUnrelatedImages(docs) {
  assert.equal(containerImage(docs, 'Deployment', `${release}-apisix`, 'apisix'), 'docker.io/apache/apisix:3.10.0-debian');
  assert.equal(containerImage(docs, 'Deployment', `${release}-keycloak`, 'keycloak'), 'quay.io/keycloak/keycloak:26.1.0');
  assert.equal(containerImage(docs, 'StatefulSet', `${release}-postgresql`, 'postgresql'), 'docker.io/bitnamilegacy/postgresql:17.2.0');
}

let defaultDocs;
let customDocs;
function getDefaultDocs() {
  defaultDocs ??= documents(render());
  return defaultDocs;
}
function getCustomDocs() {
  customDocs ??= documents(render(enabledArgs));
  return customDocs;
}

// bbx-openshift-build-001 | fn-openshift-build-from-source | #### Scenario: Disabled/default mode preserves released images
test('disabled/default mode emits no OpenShift build resources and preserves every released image contract', () => {
  const docs = getDefaultDocs();
  assert.equal(objectsOfKind(docs, 'BuildConfig').length, 0);
  assert.equal(objectsOfKind(docs, 'ImageStream').length, 0);
  assert.deepEqual(
    docs.filter((doc) => yamlScalar(doc.yaml, ['metadata', 'annotations', 'image.openshift.io/triggers']) !== undefined),
    [],
  );

  const releasedImages = {
    'control-plane': 'ghcr.io/gntik-ai/in-falcone-control-plane@sha256:a6f90cd0c3e6e5ee5e783bba1d9fbce3c03be10590c85753cde3339fbcd4ad1d',
    'control-plane-executor': 'ghcr.io/gntik-ai/in-falcone-control-plane-executor:0.3.0',
    'web-console': 'ghcr.io/gntik-ai/in-falcone-web-console:0.3.0',
    'workflow-worker': 'ghcr.io/gntik-ai/in-falcone-workflow-worker:0.3.0',
  };
  for (const [service, image] of Object.entries(releasedImages)) {
    assert.equal(containerImage(docs, 'Deployment', `${release}-${service}`, service), image);
  }
  assert.match(releasedImages['control-plane'], /@sha256:[a-f0-9]{64}$/);
  assert.equal(
    envValue(docs, `${release}-control-plane`, 'control-plane', 'FN_RUNTIME_IMAGE'),
    'ghcr.io/gntik-ai/in-falcone-fn-runtime:0.3.0',
  );
  assert.equal(
    yamlScalar(oneObject(docs, 'ConfigMap', 'in-falcone-runtime-env').yaml, ['data', 'MCP_RUNTIME_IMAGE']),
    'ghcr.io/gntik-ai/in-falcone-mcp-runtime:0.3.0',
  );
  assertUnrelatedImages(docs);
});

// bbx-openshift-build-002 | fn-openshift-build-from-source | #### Scenario: Enabled mode creates one source build and stream per Falcone service
test('enabled mode emits exactly six service-keyed ImageStreams and BuildConfigs with safe trigger references', () => {
  const docs = getCustomDocs();
  const expectedNames = services.map((service) => `in-falcone-${service}`).sort();
  assert.deepEqual(objectsOfKind(docs, 'ImageStream').map((doc) => doc.name).sort(), expectedNames);
  assert.deepEqual(objectsOfKind(docs, 'BuildConfig').map((doc) => doc.name).sort(), expectedNames);

  for (const service of services) {
    const name = `in-falcone-${service}`;
    const stream = oneObject(docs, 'ImageStream', name);
    assert.equal(stream.apiVersion, 'image.openshift.io/v1');
    assert.equal(yamlScalar(stream.yaml, ['spec']), '{}');

    const build = oneObject(docs, 'BuildConfig', name);
    assert.equal(build.apiVersion, 'build.openshift.io/v1');
    assert.equal(yamlScalar(build.yaml, ['spec', 'source', 'type']), 'Git');
    assert.equal(yamlScalar(build.yaml, ['spec', 'source', 'git', 'uri']), gitUri);
    assert.equal(yamlScalar(build.yaml, ['spec', 'source', 'git', 'ref']), gitRef);
    assert.equal(yamlScalar(build.yaml, ['spec', 'source', 'sourceSecret', 'name']), sourceSecret);
    assert.equal(yamlScalar(build.yaml, ['spec', 'strategy', 'type']), 'Docker');
    assert.equal(yamlScalar(build.yaml, ['spec', 'strategy', 'dockerStrategy', 'dockerfilePath']), dockerfiles[service]);
    assert.deepEqual(
      buildMemory(docs, service),
      service === 'web-console'
        ? {request: '512Mi', limit: '3Gi'}
        : {request: '128Mi', limit: '1Gi'},
    );
    assert.equal(yamlScalar(build.yaml, ['spec', 'output', 'to', 'kind']), 'ImageStreamTag');
    assert.equal(yamlScalar(build.yaml, ['spec', 'output', 'to', 'name']), `${name}:${imageTag}`);

    const triggers = sequenceItems(yamlBlock(build.yaml, ['spec', 'triggers']));
    assert.equal(triggers.length, 2);
    assert.equal(yamlScalar(triggers[0], ['type']), 'ConfigChange');
    assert.equal(yamlScalar(triggers[1], ['type']), 'GitLab');
    assert.equal(yamlScalar(triggers[1], ['gitlab', 'secretReference', 'name']), webhookSecret);
    assert.equal(yamlScalar(triggers[1], ['gitlab', 'secret']), undefined, 'deprecated inline GitLab secret must be absent');
    assert.equal((build.yaml.match(new RegExp(escapeRegExp(webhookSecret), 'g')) ?? []).length, 1);
  }
});

// bbx-openshift-build-003 | fn-openshift-build-from-source | #### Scenario: Enabled mode rewires only the four released Deployments
test('enabled mode rewires exactly four Deployments with exact internal pullspecs and OpenShift trigger JSON', () => {
  const docs = getCustomDocs();
  const annotated = docs.filter((doc) =>
    yamlScalar(doc.yaml, ['metadata', 'annotations', 'image.openshift.io/triggers']) !== undefined);
  assert.deepEqual(annotated.map((doc) => `${doc.kind}/${doc.name}`).sort(),
    deploymentServices.map((service) => `Deployment/${release}-${service}`).sort());

  for (const service of deploymentServices) {
    const deployment = oneObject(docs, 'Deployment', `${release}-${service}`);
    const image = `${registryPrefix}${service}:${imageTag}`;
    assert.equal(containerImage(docs, 'Deployment', deployment.name, service), image);
    const trigger = JSON.parse(yamlScalar(
      deployment.yaml,
      ['metadata', 'annotations', 'image.openshift.io/triggers'],
    ));
    assert.deepEqual(trigger, [{
      from: {
        kind: 'ImageStreamTag',
        name: `in-falcone-${service}:${imageTag}`,
        namespace: buildNamespace,
      },
      fieldPath: `spec.template.spec.containers[?(@.name==\"${service}\")].image`,
    }]);
  }

  const internalWorkloadImages = docs
    .filter((doc) => ['Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob'].includes(doc.kind))
    .flatMap((doc) => workloadContainers(doc).map((container) => ({doc, container})))
    .filter(({container}) => container.image?.startsWith(registryPrefix))
    .map(({doc, container}) => `${doc.kind}/${doc.name}/${container.group}/${container.name}=${container.image}`)
    .sort();
  assert.deepEqual(internalWorkloadImages, deploymentServices.map((service) =>
    `Deployment/${release}-${service}/containers/${service}=${registryPrefix}${service}:${imageTag}`).sort());
  assertUnrelatedImages(docs);
});

// bbx-openshift-build-004 | fn-openshift-build-from-source | #### Scenario: Enabled mode propagates the custom tag to workload and runtime image consumers
test('custom tag propagates to all build outputs, Deployment triggers/images, and runtime image values without an MCP digest', () => {
  const docs = getCustomDocs();
  const propagated = [];
  for (const service of services) {
    propagated.push(yamlScalar(oneObject(docs, 'BuildConfig', `in-falcone-${service}`).yaml, ['spec', 'output', 'to', 'name']));
  }
  for (const service of deploymentServices) {
    const deployment = oneObject(docs, 'Deployment', `${release}-${service}`);
    propagated.push(containerImage(docs, 'Deployment', deployment.name, service));
    propagated.push(JSON.parse(yamlScalar(
      deployment.yaml,
      ['metadata', 'annotations', 'image.openshift.io/triggers'],
    ))[0].from.name);
  }
  const fnRuntime = envValue(docs, `${release}-control-plane`, 'control-plane', 'FN_RUNTIME_IMAGE');
  const mcpRuntime = yamlScalar(oneObject(docs, 'ConfigMap', 'in-falcone-runtime-env').yaml, ['data', 'MCP_RUNTIME_IMAGE']);
  propagated.push(fnRuntime, mcpRuntime);

  assert.equal(propagated.length, 16);
  for (const imageReference of propagated) assert.match(imageReference, new RegExp(`:${imageTag}$`));
  assert.equal(fnRuntime, `${registryPrefix}fn-runtime:${imageTag}`);
  assert.equal(mcpRuntime, `${registryPrefix}mcp-runtime:${imageTag}`);
  assert.doesNotMatch(mcpRuntime, /@sha256:/);
});

// bbx-openshift-build-005 | fn-openshift-build-from-source | #### Scenario: Source credentials are optional and omitted rather than rendered empty
test('omitting sourceSecret omits the BuildConfig field entirely', () => {
  const sourceSecretIndex = enabledArgs.indexOf(`global.openshiftBuild.git.sourceSecret=${sourceSecret}`);
  assert.notEqual(sourceSecretIndex, -1);
  const withoutSourceSecret = [
    ...enabledArgs.slice(0, sourceSecretIndex - 1),
    ...enabledArgs.slice(sourceSecretIndex + 1),
  ];
  const docs = documents(render(withoutSourceSecret));
  for (const service of services) {
    const build = oneObject(docs, 'BuildConfig', `in-falcone-${service}`);
    assert.equal(yamlLocation(build.yaml, ['spec', 'source', 'sourceSecret']), undefined);
  }
});

// bbx-openshift-build-006 | fn-openshift-build-from-source | #### Scenario: NOTES provide safe executable GitLab webhook discovery commands
test('rendered NOTES contain six executable dynamic-server webhook commands and no secret bytes or fake API endpoint', () => {
  const notes = renderNotes(enabledArgs);
  const webhookLines = notes.split('\n').filter((line) => line.startsWith('- GitLab webhook ('));
  assert.equal(webhookLines.length, 6);
  for (const service of services) {
    const command = `webhook_secret=$(oc -n ${buildNamespace} get secret ${webhookSecret} -o jsonpath='{.data.WebHookSecretKey}' | base64 -d); printf '%s/apis/build.openshift.io/v1/namespaces/%s/buildconfigs/in-falcone-${service}/webhooks/%s/gitlab\\n' "$(oc whoami --show-server)" "${buildNamespace}" "$webhook_secret"`;
    assert.equal(webhookLines.filter((line) => line === `- GitLab webhook (${service}): \`${command}\``).length, 1);
  }
  assert.equal((notes.match(/oc whoami --show-server/g) ?? []).length, 6);
  assert.equal((notes.match(new RegExp(`oc -n ${buildNamespace} get secret ${webhookSecret}`, 'g')) ?? []).length, 6);
  assert.equal((notes.match(/\{\.data\.WebHookSecretKey\}/g) ?? []).length, 6);
  assert.doesNotMatch(notes, /WebHookSecretKey\s*:/);
  assert.doesNotMatch(notes, /<openshift-api>/);
  assert.doesNotMatch(notes, /sha256~/);
});

// bbx-openshift-build-007 | fn-openshift-build-from-source | #### Scenario: Enabled mode rejects incomplete source and webhook configuration
test('enabled mode fails when either the Git URI or webhook Secret reference is missing', () => {
  expectTemplateFailure([
    '--set', 'global.openshiftBuild.enabled=true',
    '--set', `global.openshiftBuild.webhookSecret=${webhookSecret}`,
  ], /global\.openshiftBuild\.git\.uri is required/);
  expectTemplateFailure([
    '--set', 'global.openshiftBuild.enabled=true',
    '--set', `global.openshiftBuild.git.uri=${gitUri}`,
  ], /global\.openshiftBuild\.webhookSecret is required/);
});

// bbx-openshift-build-008 | fn-openshift-build-from-source | #### Scenario: Strict schema rejects wrong types and unknown nested keys
test('Helm schema validation rejects wrong types and unknown openshiftBuild/git keys', () => {
  expectTemplateFailure([
    '--set-string', 'global.openshiftBuild.enabled=true',
  ], /openshiftBuild\/enabled[^\n]*got string, want boolean/);
  expectTemplateFailure([
    '--set', 'global.openshiftBuild.tag=42',
  ], /openshiftBuild\/tag[^\n]*got number, want string/);
  expectTemplateFailure([
    '--set', 'global.openshiftBuild.unknown=value',
  ], /openshiftBuild[^\n]*additional properties 'unknown' not allowed/);
  expectTemplateFailure([
    '--set', 'global.openshiftBuild.git.unknown=value',
  ], /openshiftBuild\/git[^\n]*additional properties 'unknown' not allowed/);
});

// bbx-openshift-build-009 | fn-openshift-build-from-source | #### Scenario: Custom global build resources merge with the web-console service override
test('custom build resources reach five services while the web-console override remains isolated', () => {
  const docs = documents(render(customResourceArgs));
  assert.equal(objectsOfKind(docs, 'BuildConfig').length, 6);
  for (const service of services) {
    assert.deepEqual(
      buildMemory(docs, service),
      service === 'web-console'
        ? {request: '640Mi', limit: '4Gi'}
        : {request: '256Mi', limit: '2Gi'},
    );
  }
});

// bbx-openshift-build-010 | fn-openshift-build-from-source | #### Scenario: Build resource schema rejects invalid shapes, keys, and service names
test('Helm schema rejects wrong resource types, unknown resource keys, and unknown service overrides', () => {
  expectTemplateFailure([
    '--set-string', 'global.openshiftBuild.resources.requests=oops',
  ], /openshiftBuild\/resources\/requests[^\n]*got string, want object/);
  expectTemplateFailure([
    '--set', 'global.openshiftBuild.resources.burst.memory=2Gi',
  ], /openshiftBuild\/resources[^\n]*additional properties 'burst' not allowed/);
  expectTemplateFailure([
    '--set', 'global.openshiftBuild.serviceResources.fn-runtime.limits.memory=2Gi',
  ], /openshiftBuild\/serviceResources[^\n]*additional properties 'fn-runtime' not allowed/);
  expectTemplateFailure([
    '--set', 'global.openshiftBuild.serviceResources.web-console.burst.memory=2Gi',
  ], /serviceResources\/web-console[^\n]*additional properties 'burst' not allowed/);
});

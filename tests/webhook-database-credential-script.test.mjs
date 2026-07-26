#!/usr/bin/env node

import { randomBytes, createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const credentialScript = resolve(
  root,
  'charts/in-falcone/files/webhook-database-credential-bootstrap.sh',
);
const fixture = mkdtempSync(resolve(tmpdir(), 'falcone-c25-credential-api-'));
const bin = resolve(fixture, 'bin');
const runtimeBin = resolve(fixture, 'runtime-bin');
const statePath = resolve(fixture, 'state.json');
const logPath = resolve(fixture, 'api.log');
// Keep this aligned with bootstrap.job.image, which the credential Job renders.
const runtimeImage = 'docker.io/alpine/k8s:1.32.2';
const runtimeImageWasPresent = spawnSync(
  'docker',
  ['image', 'inspect', runtimeImage],
  { stdio: 'ignore' },
).status === 0;
let passed = 0;
mkdirSync(bin, { mode: 0o700 });
// GitHub-hosted runners own the checkout as uid 1001 while this posture probe
// deliberately runs the container as uid 1000. These synthetic, secret-free
// stubs are mounted read-only and must therefore be world-readable/traversable.
mkdirSync(runtimeBin, { mode: 0o755 });

function ensure(condition, label) {
  if (!condition) throw new Error(label);
}

function check(label, fn) {
  try {
    fn();
    passed += 1;
    process.stdout.write(`ok ${passed} - ${label}\n`);
  } catch {
    process.stderr.write(`not ok ${passed + 1} - ${label}\n`);
    process.exitCode = 1;
  }
}

function digest(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function objectDigest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function password() {
  return randomBytes(32).toString('hex');
}

const roles = Object.freeze({
  schema: 'falcone_webhook_schema',
  runtime: 'falcone_webhook_runtime',
  writer: 'falcone_webhook_writer',
  lifecycle: 'falcone_webhook_lifecycle_login',
});

function buildSecret({ managed }) {
  const passwords = {
    schema: password(),
    runtime: password(),
    writer: password(),
    lifecycle: password(),
  };
  const data = {};
  for (const kind of Object.keys(passwords)) {
    const prefix = kind === 'writer'
      ? 'WEBHOOK_KEY_WRITE'
      : kind === 'lifecycle'
        ? 'WEBHOOK_KEY_LIFECYCLE'
        : `WEBHOOK_${kind.toUpperCase()}`;
    data[`${prefix}_DATABASE_PASSWORD`] = Buffer
      .from(passwords[kind])
      .toString('base64');
    data[`${prefix}_DATABASE_URL`] = Buffer.from(
      `postgresql://${roles[kind]}:${passwords[kind]}@falcone-postgresql:5432/in_falcone`,
    ).toString('base64');
  }
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    immutable: true,
    metadata: {
      name: 'in-falcone-webhook-database-credentials',
      namespace: 'falcone-test',
      labels: managed ? {
        'app.kubernetes.io/managed-by': 'Helm',
        'app.kubernetes.io/instance': 'falcone',
        'app.kubernetes.io/component': 'webhook-database-credentials',
      } : {},
      annotations: managed ? {
        'helm.sh/resource-policy': 'keep',
      } : {},
    },
    data,
  };
}

function save(secret, marker = null) {
  writeFileSync(statePath, JSON.stringify({ secret, marker }), { mode: 0o600 });
  writeFileSync(logPath, '', { mode: 0o600 });
}

function run({
  create,
  upgrade,
  firstHandoff = false,
  secretCreateAuthorized,
  markerCreateAuthorized,
}) {
  const initialization = create && (!upgrade || firstHandoff);
  return spawnSync('/bin/sh', [credentialScript], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH}`,
      FAKE_KUBECTL_STATE: statePath,
      FAKE_KUBECTL_LOG: logPath,
      RELEASE_NAMESPACE: 'falcone-test',
      RELEASE_NAME: 'falcone',
      CHART_LABEL: 'in-falcone-test',
      APP_NAME: 'in-falcone',
      MANAGED_BY: 'Helm',
      WEBHOOK_DATABASE_CREDENTIAL_SECRET:
        'in-falcone-webhook-database-credentials',
      WEBHOOK_DATABASE_CREDENTIAL_MARKER:
        'in-falcone-webhook-database-credentials-initialized',
      WEBHOOK_DATABASE_CREDENTIAL_CREATE: String(create),
      WEBHOOK_DATABASE_IS_UPGRADE: String(upgrade),
      WEBHOOK_DATABASE_FIRST_HANDOFF: String(firstHandoff),
      WEBHOOK_DATABASE_SECRET_CREATE_AUTHORIZED: String(
        secretCreateAuthorized ?? initialization,
      ),
      WEBHOOK_DATABASE_MARKER_CREATE_AUTHORIZED: String(
        markerCreateAuthorized ?? initialization,
      ),
      WEBHOOK_DATABASE_CREDENTIAL_LOOKUP_FOUND: 'false',
      WEBHOOK_DATABASE_MARKER_LOOKUP_FOUND: 'false',
      WEBHOOK_DATABASE_HOST: 'falcone-postgresql',
      WEBHOOK_DATABASE_PORT: '5432',
      WEBHOOK_DATABASE_NAME: 'in_falcone',
      WEBHOOK_SCHEMA_DATABASE_ROLE: roles.schema,
      WEBHOOK_RUNTIME_DATABASE_ROLE: roles.runtime,
      WEBHOOK_KEY_WRITE_DATABASE_ROLE: roles.writer,
      WEBHOOK_KEY_LIFECYCLE_DATABASE_ROLE: roles.lifecycle,
    },
  });
}

function logEntries() {
  return readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
}

writeFileSync(resolve(fixture, 'kubectl.mjs'), `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const statePath = process.env.FAKE_KUBECTL_STATE;
const logPath = process.env.FAKE_KUBECTL_LOG;
const original = process.argv.slice(2);
const args = [...original];
if (args[0] === '-n') args.splice(0, 2);
const state = JSON.parse(readFileSync(statePath, 'utf8'));

function log(value) {
  appendFileSync(logPath, value + '\\n');
}

if (args[0] === 'get' && ['secret', 'configmap'].includes(args[1])) {
  const stateKey = args[1] === 'secret' ? 'secret' : 'marker';
  const object = state[stateKey];
  log('get-' + args[1]);
  if (!object) process.exit(1);
  const outputIndex = args.indexOf('-o');
  if (outputIndex < 0) {
    process.stdout.write(JSON.stringify(object));
    process.exit(0);
  }
  const template = args[outputIndex + 1];
  if (template === 'go-template={{len .data}}') {
    process.stdout.write(String(Object.keys(object.data).length));
  } else if (template === 'go-template={{.immutable}}') {
    process.stdout.write(String(object.immutable));
  } else {
    const dataKey = template.match(/index \\.data "([^"]+)"/)?.[1];
    const labelKey = template.match(/index \\.metadata\\.labels "([^"]+)"/)?.[1];
    const annotationKey = template.match(/index \\.metadata\\.annotations "([^"]+)"/)?.[1];
    if (dataKey) process.stdout.write(object.data[dataKey] ?? '');
    else if (labelKey) process.stdout.write(object.metadata.labels?.[labelKey] ?? '');
    else if (annotationKey) {
      process.stdout.write(object.metadata.annotations?.[annotationKey] ?? '');
    } else process.exit(2);
  }
  process.exit(0);
}

if (args[0] === 'create' && args[1] === 'secret' && args[2] === 'generic') {
  log('create-secret-dry-run');
  const data = {};
  for (const argument of args) {
    if (!argument.startsWith('--from-file=')) continue;
    const assignment = argument.slice('--from-file='.length);
    const separator = assignment.indexOf('=');
    const key = assignment.slice(0, separator);
    const path = assignment.slice(separator + 1);
    data[key] = Buffer.from(readFileSync(path)).toString('base64');
  }
  process.stdout.write(JSON.stringify({
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: args[3] },
    data,
  }));
  process.exit(0);
}

if (args[0] === 'create' && args[1] === 'configmap') {
  log('create-configmap-dry-run');
  const data = {};
  for (const argument of args) {
    if (!argument.startsWith('--from-literal=')) continue;
    const assignment = argument.slice('--from-literal='.length);
    const separator = assignment.indexOf('=');
    data[assignment.slice(0, separator)] = assignment.slice(separator + 1);
  }
  process.stdout.write(JSON.stringify({
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name: args[2] },
    data,
  }));
  process.exit(0);
}

if (args[0] === 'create' && args[1] === '-f' && args[2] === '-') {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  const object = JSON.parse(input);
  if (object.kind === 'Secret') {
    log('create-secret-live');
    if (state.secret) process.exit(1);
    state.secret = object;
  } else if (object.kind === 'ConfigMap') {
    log('create-configmap-live');
    if (state.marker) process.exit(1);
    state.marker = object;
  } else process.exit(2);
  writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });
  process.exit(0);
}

process.exit(2);
`);
chmodSync(resolve(fixture, 'kubectl.mjs'), 0o700);
writeFileSync(
  resolve(fixture, 'bin', 'kubectl'),
  `#!/bin/sh\nexec node "${resolve(fixture, 'kubectl.mjs')}" "$@"\n`,
  { mode: 0o700 },
);

writeFileSync(
  resolve(runtimeBin, 'kubectl'),
  [
    '#!/bin/sh',
    'set -eu',
    'log=/tmp/fake-kubernetes-boundary.log',
    'if [ "${1:-}" = "-n" ]; then shift 2; fi',
    '',
    'if [ "${1:-}" = "get" ] && [ "${2:-}" = "secret" ]; then',
    '  [ -f /tmp/fake-secret-ready ] || exit 1',
    '  [ "${4:-}" = "-o" ] || exit 0',
    '  template="${5:-}"',
    '  printf "get-secret:%s\\n" "$template" >>"$log"',
    '  case "$template" in',
    '    *"len .data"*) printf %s 8 ;;',
    '    *".immutable"*) printf %s true ;;',
    '    *"app.kubernetes.io/managed-by"*) printf %s Helm ;;',
    '    *"app.kubernetes.io/instance"*) printf %s falcone ;;',
    '    *"app.kubernetes.io/component"*) printf %s webhook-database-credentials ;;',
    '    *"helm.sh/resource-policy"*) printf %s keep ;;',
    '    *"index .data"*)',
    "      key=\"$(printf '%s' \"$template\" | sed -n 's/.*index \\.data \"\\([^\"]*\\)\".*/\\1/p')\"",
    '      [ -n "$key" ] && [ -f "/tmp/fake-secret-data/$key" ] || exit 2',
    '      base64 <"/tmp/fake-secret-data/$key" | tr -d "\\n"',
    '      ;;',
    '    *) exit 2 ;;',
    '  esac',
    '  exit 0',
    'fi',
    '',
    'if [ "${1:-}" = "get" ] && [ "${2:-}" = "configmap" ]; then',
    '  [ -f /tmp/fake-marker-ready ] || exit 1',
    '  [ "${4:-}" = "-o" ] || exit 0',
    '  template="${5:-}"',
    '  case "$template" in',
    '    *"index .data \\"state\\""*) printf %s initialized ;;',
    '    *".immutable"*) printf %s true ;;',
    '    *"app.kubernetes.io/managed-by"*) printf %s Helm ;;',
    '    *"app.kubernetes.io/instance"*) printf %s falcone ;;',
    '    *"app.kubernetes.io/component"*) printf %s webhook-database-credential-state ;;',
    '    *"helm.sh/resource-policy"*) printf %s keep ;;',
    '    *) exit 2 ;;',
    '  esac',
    '  exit 0',
    'fi',
    '',
    'if [ "${1:-}" = "create" ] && [ "${2:-}" = "secret" ] && [ "${3:-}" = "generic" ]; then',
    '  mkdir -p /tmp/fake-secret-data',
    '  for argument in "$@"; do',
    '    case "$argument" in',
    '      --from-file=*)',
    '        assignment="${argument#--from-file=}"',
    '        key="${assignment%%=*}"',
    '        source_path="${assignment#*=}"',
    '        cp "$source_path" "/tmp/fake-secret-data/$key"',
    '        ;;',
    '    esac',
    '  done',
    '  : > /tmp/fake-secret-pending',
    '  printf "%s\\n" create-secret-dry-run >>"$log"',
    '  printf %s "{\\"kind\\":\\"Secret\\"}"',
    '  exit 0',
    'fi',
    '',
    'if [ "${1:-}" = "create" ] && [ "${2:-}" = "configmap" ]; then',
    '  : > /tmp/fake-marker-pending',
    '  printf "%s\\n" create-configmap-dry-run >>"$log"',
    '  printf %s "{\\"kind\\":\\"ConfigMap\\"}"',
    '  exit 0',
    'fi',
    '',
    'if [ "${1:-}" = "create" ] && [ "${2:-}" = "-f" ] && [ "${3:-}" = "-" ]; then',
    '  cat >/dev/null',
    '  if [ -f /tmp/fake-secret-pending ]; then',
    '    rm -f /tmp/fake-secret-pending',
    '    : > /tmp/fake-secret-ready',
    '    printf "%s\\n" create-secret-live >>"$log"',
    '    exit 0',
    '  fi',
    '  if [ -f /tmp/fake-marker-pending ]; then',
    '    rm -f /tmp/fake-marker-pending',
    '    : > /tmp/fake-marker-ready',
    '    printf "%s\\n" create-configmap-live >>"$log"',
    '    exit 0',
    '  fi',
    'fi',
    '',
    'exit 2',
    '',
  ].join('\n'),
  { mode: 0o755 },
);
writeFileSync(
  resolve(runtimeBin, 'jq'),
  '#!/bin/sh\ncat\n',
  { mode: 0o755 },
);
writeFileSync(
  resolve(runtimeBin, 'runtime.sh'),
  [
    '#!/bin/sh',
    'set -eu',
    'runtime_fail() { printf "%s\\n" "WEBHOOK_DATABASE_CREDENTIAL_RUNTIME_${1}_FAILED" >&2; exit 1; }',
    'export PATH=/test-bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    ': > /tmp/fake-kubernetes-boundary.log',
    'awk \'$2 == "/" { n=split($4, option, ","); for (i=1; i<=n; i++) if (option[i] == "ro") found=1 } END { exit !found }\' /proc/mounts || runtime_fail ROOT_READ_ONLY',
    'awk \'$2 == "/tmp" { n=split($4, option, ","); for (i=1; i<=n; i++) { if (option[i] == "rw") writable=1; if (option[i] ~ /^size=(1024k|1m)$/) bounded=1 } } END { exit !(writable && bounded) }\' /proc/mounts || runtime_fail TMP_MOUNT',
    '/bin/sh /scripts/credential-bootstrap.sh >/tmp/credential.stdout 2>/tmp/credential.stderr || { cat /tmp/fake-kubernetes-boundary.log >&2; runtime_fail SCRIPT; }',
    '[ "$(cat /tmp/credential.stdout)" = "WEBHOOK_DATABASE_CREDENTIAL_CREATED" ] || runtime_fail OUTPUT',
    '[ ! -s /tmp/credential.stderr ] || runtime_fail STDERR',
    '[ "$(grep -c "^create-secret-live$" /tmp/fake-kubernetes-boundary.log)" = "1" ] || runtime_fail SECRET_BOUNDARY',
    '[ "$(grep -c "^create-configmap-live$" /tmp/fake-kubernetes-boundary.log)" = "1" ] || runtime_fail MARKER_BOUNDARY',
    'if find /tmp -maxdepth 1 -type d -name "webhook-db-credential.*" | grep -q .; then runtime_fail SCRATCH_CLEANUP; fi',
    'printf "%s\\n" WEBHOOK_DATABASE_CREDENTIAL_FILESYSTEM_POSTURE_OK',
    '',
  ].join('\n'),
  { mode: 0o755 },
);

function runRuntimePosture({ upgrade, firstHandoff }) {
  const result = spawnSync('docker', [
    'run', '--rm',
    '--read-only',
    '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=1m,mode=1777',
    '--user', '1000:1000',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--network', 'none',
    '--mount', `type=bind,src=${credentialScript},dst=/scripts/credential-bootstrap.sh,readonly`,
    '--mount', `type=bind,src=${runtimeBin},dst=/test-bin,readonly`,
    '--env', 'RELEASE_NAMESPACE=falcone-test',
    '--env', 'RELEASE_NAME=falcone',
    '--env', 'CHART_LABEL=in-falcone-test',
    '--env', 'APP_NAME=in-falcone',
    '--env', 'MANAGED_BY=Helm',
    '--env', 'WEBHOOK_DATABASE_CREDENTIAL_SECRET=in-falcone-webhook-database-credentials',
    '--env', 'WEBHOOK_DATABASE_CREDENTIAL_MARKER=in-falcone-webhook-database-credentials-initialized',
    '--env', 'WEBHOOK_DATABASE_CREDENTIAL_CREATE=true',
    '--env', `WEBHOOK_DATABASE_IS_UPGRADE=${upgrade}`,
    '--env', `WEBHOOK_DATABASE_FIRST_HANDOFF=${firstHandoff}`,
    '--env', 'WEBHOOK_DATABASE_SECRET_CREATE_AUTHORIZED=true',
    '--env', 'WEBHOOK_DATABASE_MARKER_CREATE_AUTHORIZED=true',
    '--env', 'WEBHOOK_DATABASE_CREDENTIAL_LOOKUP_FOUND=false',
    '--env', 'WEBHOOK_DATABASE_MARKER_LOOKUP_FOUND=false',
    '--env', 'WEBHOOK_DATABASE_HOST=falcone-postgresql',
    '--env', 'WEBHOOK_DATABASE_PORT=5432',
    '--env', 'WEBHOOK_DATABASE_NAME=in_falcone',
    '--env', `WEBHOOK_SCHEMA_DATABASE_ROLE=${roles.schema}`,
    '--env', `WEBHOOK_RUNTIME_DATABASE_ROLE=${roles.runtime}`,
    '--env', `WEBHOOK_KEY_WRITE_DATABASE_ROLE=${roles.writer}`,
    '--env', `WEBHOOK_KEY_LIFECYCLE_DATABASE_ROLE=${roles.lifecycle}`,
    '--entrypoint', '/bin/sh',
    runtimeImage,
    '/test-bin/runtime.sh',
  ], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0 && result.stderr) {
    process.stderr.write(result.stderr);
  }
  ensure(result.status === 0, 'credential runtime posture failed');
  ensure(
    result.stdout.trim() === 'WEBHOOK_DATABASE_CREDENTIAL_FILESYSTEM_POSTURE_OK',
    'credential runtime output was not bounded',
  );
  ensure(result.stderr === '', 'credential runtime wrote unexpected stderr');
}

try {
  // Pull outside the posture probe so a clean runner's Docker progress on
  // stderr cannot be confused with output from the hardened workload itself.
  // The finally block removes only an image that was absent before this test.
  if (!runtimeImageWasPresent) {
    const pull = spawnSync('docker', ['image', 'pull', runtimeImage], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    });
    if (pull.status !== 0 && pull.stderr) process.stderr.write(pull.stderr);
    ensure(pull.status === 0, 'credential runtime image pull failed');
  }

  check('external credential Secret is validated without mutation', () => {
    save(buildSecret({ managed: false }));
    const before = digest(statePath);
    const result = run({ create: false, upgrade: true });
    ensure(result.status === 0, 'external validation failed');
    ensure(
      result.stdout.trim() === 'WEBHOOK_DATABASE_CREDENTIAL_REUSED',
      'external output was not bounded',
    );
    ensure(digest(statePath) === before, 'external state changed');
    ensure(
      logEntries().every((entry) => entry === 'get-secret'),
      'external API operation was not read-only',
    );
  });

  check('missing external credential fails without create or mutation', () => {
    save(null);
    const before = digest(statePath);
    const result = run({ create: false, upgrade: true });
    ensure(result.status !== 0, 'missing external Secret was accepted');
    ensure(
      result.stderr.trim() === 'WEBHOOK_DATABASE_CREDENTIAL_INVALID',
      'external failure was not bounded',
    );
    ensure(digest(statePath) === before, 'missing external state changed');
    ensure(
      logEntries().every((entry) => entry === 'get-secret'),
      'missing external path attempted mutation',
    );
  });

  check('managed fresh install creates one immutable exact-key Secret', () => {
    save(null);
    const result = run({ create: true, upgrade: false });
    ensure(result.status === 0, 'managed creation failed');
    ensure(
      result.stdout.trim() === 'WEBHOOK_DATABASE_CREDENTIAL_CREATED',
      'managed output was not bounded',
    );
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    ensure(state.secret?.immutable === true, 'managed Secret was mutable');
    ensure(state.marker?.immutable === true, 'managed marker was mutable');
    ensure(
      state.marker?.data?.state === 'initialized',
      'managed marker state drifted',
    );
    ensure(
      Object.keys(state.secret?.data ?? {}).length === 8,
      'managed Secret key count drifted',
    );
    ensure(
      new Set(Object.values(state.secret.data)).size === 8,
      'managed credential values were not distinct',
    );
    ensure(
      logEntries().filter((entry) => entry === 'create-secret-live').length === 1,
      'managed Secret create count drifted',
    );
    ensure(
      logEntries().filter((entry) => entry === 'create-configmap-live').length === 1,
      'managed marker create count drifted',
    );
  });

  check('ordinary managed replay byte-reuses the retained Secret', () => {
    const before = digest(statePath);
    writeFileSync(logPath, '', { mode: 0o600 });
    const result = run({ create: true, upgrade: true });
    ensure(result.status === 0, 'managed replay failed');
    ensure(
      result.stdout.trim() === 'WEBHOOK_DATABASE_CREDENTIAL_REUSED',
      'managed replay output was not bounded',
    );
    ensure(digest(statePath) === before, 'managed replay changed Secret bytes');
    ensure(
      logEntries().every((entry) => entry.startsWith('get-')),
      'managed replay attempted mutation',
    );
  });

  check('first-handoff retry resumes after Secret create without changing it', () => {
    const secret = buildSecret({ managed: true });
    save(secret);
    const before = objectDigest(secret);
    const result = run({
      create: true,
      upgrade: true,
      firstHandoff: true,
      secretCreateAuthorized: false,
      markerCreateAuthorized: true,
    });
    ensure(result.status === 0, 'partial initialization did not resume');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    ensure(
      objectDigest(state.secret) === before,
      'partial initialization changed credential bytes',
    );
    ensure(state.marker?.immutable === true, 'partial initialization omitted marker');
    ensure(
      logEntries().filter((entry) => entry === 'create-secret-live').length === 0,
      'partial initialization recreated Secret',
    );
  });

  check('explicit backup-gated first handoff initializes legacy credentials once', () => {
    save(null);
    const result = run({ create: true, upgrade: true, firstHandoff: true });
    ensure(result.status === 0, 'first handoff creation failed');
    ensure(
      result.stdout.trim() === 'WEBHOOK_DATABASE_CREDENTIAL_CREATED',
      'first handoff output was not bounded',
    );
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    ensure(state.secret?.immutable === true, 'first handoff Secret was mutable');
    ensure(state.marker?.immutable === true, 'first handoff marker was mutable');
  });

  check('retained marker blocks missing-Secret regeneration on values replay', () => {
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    state.secret = null;
    writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });
    writeFileSync(logPath, '', { mode: 0o600 });
    const before = digest(statePath);
    const result = run({
      create: true,
      upgrade: true,
      firstHandoff: true,
      secretCreateAuthorized: false,
      markerCreateAuthorized: false,
    });
    ensure(result.status !== 0, 'retained marker allowed credential regeneration');
    ensure(
      result.stderr.trim() === 'WEBHOOK_DATABASE_CREDENTIAL_INVALID',
      'marker failure was not bounded',
    );
    ensure(digest(statePath) === before, 'marker failure changed retained state');
    ensure(
      logEntries().every((entry) => entry.startsWith('get-')),
      'marker failure attempted mutation',
    );
  });

  check('fresh and first-handoff creation run with read-only root and bounded writable tmp', () => {
    runRuntimePosture({ upgrade: false, firstHandoff: false });
    runRuntimePosture({ upgrade: true, firstHandoff: true });
  });
} finally {
  rmSync(fixture, { recursive: true, force: true });
  if (!runtimeImageWasPresent) {
    spawnSync('docker', ['image', 'rm', runtimeImage], { stdio: 'ignore' });
  }
}

process.stdout.write(`1..${passed}\n`);

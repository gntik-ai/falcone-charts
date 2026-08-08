/**
 * Public black-box contracts for the rendered Temporal schema lifecycle Job.
 * The tests execute the chart-produced POSIX shell against a fake
 * temporal-sql-tool; they do not connect to PostgreSQL or Kubernetes.
 */
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'

import {
  assertSuccess,
  combined,
  render,
  run,
  umbrellaChart,
} from '../fixtures/blackbox.mjs'

const upgradeArgs = [
  '--is-upgrade',
  '--set', 'global.webhookDatabase.migration.backupVerified=true',
  '--set', 'global.webhookDatabase.migration.parityVerified=true',
  '--set-string', 'global.webhookDatabase.migration.backupReference=bbx-temporal-upgrade',
  '--set-string', 'deployment.upgrade.currentVersion=0.3.1',
]

function renderedSchemaJob(args = []) {
  const { objects } = render(umbrellaChart, args)
  const job = objects.find((object) => (
    object.kind === 'Job'
    && object.metadata?.labels?.['app.kubernetes.io/component'] === 'temporal-schema'
  )) ?? objects.find((object) => object.kind === 'Job' && /temporal-schema$/.test(object.metadata?.name ?? ''))
  assert.ok(job, 'rendered umbrella is missing the Temporal schema Job')
  const container = job.spec?.template?.spec?.containers?.find((candidate) => candidate.name === 'temporal-sql-tool')
  assert.ok(container, 'Temporal schema Job is missing temporal-sql-tool')
  assert.deepEqual(container.command?.slice(0, 2), ['/bin/sh', '-ec'])
  assert.equal(typeof container.command?.[2], 'string')
  return { job, command: container.command }
}

function executeScenario(command, scenario) {
  const directory = mkdtempSync(resolve(tmpdir(), 'falcone-temporal-schema-bbx-'))
  const stateDirectory = resolve(directory, 'state')
  const log = resolve(directory, 'calls.log')
  const executable = resolve(directory, 'temporal-sql-tool')
  mkdirSync(stateDirectory)
  writeFileSync(executable, `#!/bin/sh
set -eu
printf '%s\\n' "$*" >>"$TEMPORAL_FAKE_LOG"
database=""
operation=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--database" ]; then
    database="$2"
    shift 2
    continue
  fi
  case "$1" in
    create-database|setup-schema|update-schema) operation="$1" ;;
  esac
  shift
done
case "$operation" in
  create-database) exit 0 ;;
  setup-schema)
    : >"$TEMPORAL_FAKE_STATE/$database"
    exit 0
    ;;
  update-schema)
    case "$TEMPORAL_FAKE_SCENARIO" in
      existing) exit 0 ;;
      missing)
        if [ -f "$TEMPORAL_FAKE_STATE/$database" ]; then exit 0; fi
        printf '%s\\n' '{"level":"error","msg":"pq: relation \\"schema_version\\" does not exist"}' >&2
        exit 1
        ;;
      fatal)
        printf '%s\\n' 'dial tcp: connection refused' >&2
        exit 23
        ;;
    esac
    ;;
esac
printf '%s\\n' "unexpected temporal-sql-tool invocation: $*" >&2
exit 64
`)
  chmodSync(executable, 0o755)

  const result = run(command[0], command.slice(1), {
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      SQL_HOST: 'postgres.example',
      SQL_PORT: '5432',
      SQL_USER: 'temporal',
      SQL_PASSWORD: 'not-a-real-secret',
      SQL_PLUGIN: 'postgres12',
      SQL_DATABASE: 'temporal',
      SQL_VISIBILITY_DATABASE: 'temporal_visibility',
      TEMPORAL_FAKE_LOG: log,
      TEMPORAL_FAKE_STATE: stateDirectory,
      TEMPORAL_FAKE_SCENARIO: scenario,
    },
  })
  const calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean)
  return {
    result,
    calls,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  }
}

test('install and upgrade renders probe database state instead of Helm release state', () => {
  const install = renderedSchemaJob()
  const upgrade = renderedSchemaJob(upgradeArgs)

  assert.equal(install.job.metadata?.annotations?.['helm.sh/hook'], undefined)
  assert.match(upgrade.job.metadata?.annotations?.['helm.sh/hook'] ?? '', /pre-upgrade/)

  for (const command of [install.command, upgrade.command]) {
    const script = command[2]
    assert.match(script, /update-schema -d/)
    assert.match(script, /schema_version/)
    assert.match(script, /does not exist/)
    assert.match(script, /setup-schema -v 0\.0/)
    assert.doesNotMatch(script, /schema_lifecycle=/)
  }
})

test('existing Temporal schemas are upgraded without re-running setup-schema', () => {
  const { command } = renderedSchemaJob(upgradeArgs)
  const execution = executeScenario(command, 'existing')
  try {
    assertSuccess(execution.result, 'existing Temporal schema lifecycle')
    assert.equal(execution.calls.filter((call) => /\bupdate-schema\b/.test(call)).length, 2)
    assert.equal(execution.calls.filter((call) => /\bsetup-schema\b/.test(call)).length, 0)
  } finally {
    execution.cleanup()
  }
})

test('empty Temporal databases are initialized and then migrated during an upgrade', () => {
  const { command } = renderedSchemaJob(upgradeArgs)
  const execution = executeScenario(command, 'missing')
  try {
    assertSuccess(execution.result, 'empty Temporal schema lifecycle')
    assert.equal(execution.calls.filter((call) => /\bsetup-schema\b/.test(call)).length, 2)
    assert.equal(execution.calls.filter((call) => /\bupdate-schema\b/.test(call)).length, 4)
    assert.match(combined(execution.result), /no schema_version in temporal/)
    assert.match(combined(execution.result), /no schema_version in temporal_visibility/)
  } finally {
    execution.cleanup()
  }
})

test('unrelated Temporal migration failures remain fail-closed', () => {
  const { command } = renderedSchemaJob(upgradeArgs)
  const execution = executeScenario(command, 'fatal')
  try {
    assert.notEqual(execution.result.status, 0, 'fatal migration error was masked')
    assert.equal(execution.calls.filter((call) => /\bsetup-schema\b/.test(call)).length, 0)
    assert.match(combined(execution.result), /failed to update Temporal schema in temporal/)
    assert.match(combined(execution.result), /connection refused/)
  } finally {
    execution.cleanup()
  }
})

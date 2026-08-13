/**
 * Public package/CLI contracts for the 0.4.18 forward-recovery candidate.
 *
 * The tests package and extract the public Helm chart, then invoke only its
 * distributed recovery CLIs against process-isolated public-tool fixtures.
 */
import assert from 'node:assert/strict'
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'

import {
  assertSuccess,
  combined,
  readYaml,
  run,
  umbrellaChart,
} from '../fixtures/blackbox.mjs'
import {
  runRevision24AuthRecovery,
} from '../fixtures/staging-infrastructure/revision23-partial-manual-recovery-tools.mjs'

const targetVersion = '0.4.18'

function packageRecoveryCandidate() {
  const work = mkdtempSync(resolve(tmpdir(), 'falcone-packaged-recovery-bbx-'))
  const packaged = run('helm', ['package', umbrellaChart, '--destination', work])
  assertSuccess(packaged, 'helm package charts/in-falcone')

  const archives = readdirSync(work).filter((name) => /^in-falcone-.+\.tgz$/.test(name))
  assert.equal(archives.length, 1, 'Helm must publish exactly one in-falcone package')

  const extract = resolve(work, 'extract')
  assertSuccess(run('mkdir', ['-p', extract]), 'create recovery package extraction directory')
  assertSuccess(
    run('tar', ['-xzf', resolve(work, archives[0]), '-C', extract]),
    'extract public in-falcone Helm package',
  )

  const chart = resolve(extract, 'in-falcone')
  const metadata = readYaml(resolve(chart, 'Chart.yaml'))
  return {
    work,
    version: metadata.version,
    forwardRecovery: resolve(chart, 'migrations/revision-20-forward-recovery.sh'),
    repair: resolve(chart, 'migrations/revision-20-repair.sh'),
    cleanup: () => rmSync(work, { recursive: true, force: true }),
  }
}

function authRenderLine(result) {
  return result.trace
    .split('\n')
    .find((line) =>
      line.startsWith('helm template ') &&
      line.includes('--show-only charts/openbao/templates/openbao-auth-reconcile-job.yaml')
    )
}

// bbx-repair-staging-071 | fn-packaged-forward-recovery-delegation | OpenSpec #### Scenario: Packaged forward recovery invokes its repair delegate without executable mode
test('bbx-repair-staging-071 packaged forward recovery is independent of repair executable mode', () => {
  const candidate = packageRecoveryCandidate()
  try {
    chmodSync(candidate.repair, 0o644)
    assert.equal(
      statSync(candidate.repair).mode & 0o111,
      0,
      'the extracted repair CLI fixture must have no executable bit',
    )

    const result = runRevision24AuthRecovery({
      targetVersion: candidate.version,
      recoveryEntrypoint: candidate.forwardRecovery,
      invokeWithBash: true,
    })

    assert.equal(
      result.status,
      0,
      [
        'bash revision-20-forward-recovery.sh must invoke its packaged repair delegate',
        'without depending on the delegate executable bit',
        `stdout:\n${result.stdout}`,
        `stderr:\n${result.stderr}`,
        `public trace:\n${result.trace}`,
      ].join('\n'),
    )
    assert.equal(candidate.version, targetVersion, 'the corrected package must be 0.4.18')
  } finally {
    candidate.cleanup()
  }
})

// bbx-repair-staging-072 | fn-revision24-auth-upgrade-render | OpenSpec #### Scenario: Revision-24 auth preflight renders in Helm upgrade context
test('bbx-repair-staging-072 revision-24 auth preflight renders as a Helm upgrade', () => {
  const candidate = packageRecoveryCandidate()
  try {
    const result = runRevision24AuthRecovery({
      targetVersion: candidate.version,
      requireUpgradeRenderContext: true,
      recoveryEntrypoint: candidate.repair,
      invokeWithBash: true,
      entrypointArguments: ['--phase-a'],
    })
    const renderLine = authRenderLine(result)
    const trace = result.trace.split('\n').filter(Boolean)
    const renderIndex = trace.indexOf(renderLine)
    const firstMutationIndex = trace.findIndex((line) =>
      /^helm upgrade\b/.test(line) ||
      /^kubectl .*\b(?:apply|create|delete|patch|replace)\b/.test(line)
    )

    assert.ok(
      renderLine,
      [
        'revision-24 apply must render the package-bound auth Job before mutation',
        `stdout:\n${result.stdout}`,
        `stderr:\n${result.stderr}`,
        `public trace:\n${result.trace}`,
      ].join('\n'),
    )
    assert.match(
      renderLine,
      /(?:^|\s)--is-upgrade(?:\s|$)/,
      `auth Job render lacks Helm upgrade context:\n${renderLine}\n${combined(result)}`,
    )
    assert.ok(
      firstMutationIndex > renderIndex,
      `auth Job must render in upgrade context before mutation:\n${result.trace}`,
    )
    assert.equal(result.status, 0, `revision-24 recovery failed:\n${combined(result)}`)
    assert.equal(candidate.version, targetVersion, 'the corrected package must be 0.4.18')
  } finally {
    candidate.cleanup()
  }
})

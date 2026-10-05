import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { repoRoot } from '../fixtures/blackbox.mjs'

test('#1053 historical render, invalid env, and atomic executor migration contracts', () => {
  const result = spawnSync('python3', ['tests/blackbox/deployment-packaging/executor-env-upgrade.py', 'Offline'], {
    cwd: repoRoot, encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
})

test('#1053 live Helm 3 / Argo client / Helm 4 server upgrade matrix', {
  skip: process.env.EXECUTOR_UPGRADE_LIVE !== '1' ? 'requires disposable kind cluster; mandatory dedicated PR CI job' : false,
  timeout: 900_000,
}, () => {
  const result = spawnSync('python3', ['tests/blackbox/deployment-packaging/executor-env-upgrade.py', 'Live'], {
    cwd: repoRoot, encoding: 'utf8', timeout: 900_000, maxBuffer: 1024 * 1024,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
})

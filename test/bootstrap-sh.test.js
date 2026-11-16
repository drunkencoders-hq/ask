// @ts-check
// bootstrap.sh in --dry-run only (never for real on a dev machine).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { ROOT } from './helpers.js';

const skip = process.platform !== 'darwin' && 'bootstrap.sh is macOS-only';
const run = (args, env = {}) =>
  spawnSync('/bin/bash', [path.join(ROOT, 'bootstrap.sh'), ...args], { encoding: 'utf8', env: { ...process.env, ...env } });

test('bootstrap.sh --dry-run prints the plan and DRY RUN OK', { skip }, () => {
  const r = run(['--dry-run', '--hub', 'http://mini:8787'], { ASK_INSTALL_SOURCE: '/tmp/ask-src' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /ask source: \/tmp\/ask-src/);
  assert.match(r.stderr, /would run: npm install -g \/tmp\/ask-src/);
  assert.match(r.stderr, /would run: ask setup --hub http:\/\/mini:8787/);
  assert.equal(r.stderr.trim().split('\n').at(-1), 'DRY RUN OK: no changes made');
});

test('bootstrap.sh without --hub, or with a bad one, fails with one FAILED line', { skip }, () => {
  for (const args of [['--dry-run'], ['--dry-run', '--hub', 'mini:8787'], ['--dry-run', '--bogus']]) {
    const r = run(args);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.split('\n').filter((l) => l.startsWith('bootstrap: FAILED:')).length, 1, r.stderr);
  }
});

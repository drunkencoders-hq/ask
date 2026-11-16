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
  const r = run(['--dry-run', '--hub', 'http://hub.invalid:8787'], { ASK_INSTALL_SOURCE: '/tmp/ask-src' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /ask source: \/tmp\/ask-src/);
  assert.match(r.stderr, /would run: npm install -g \/tmp\/ask-src/);
  assert.match(r.stderr, /would run: ask setup --hub http:\/\/hub.invalid:8787/);
  assert.equal(r.stderr.trim().split('\n').at(-1), 'DRY RUN OK: no changes made');
});

test('bootstrap.sh without --hub, or with a bad one, fails with one FAILED line', { skip }, () => {
  for (const args of [['--dry-run'], ['--dry-run', '--hub', 'hub.invalid:8787'], ['--dry-run', '--bogus']]) {
    const r = run(args);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.split('\n').filter((l) => l.startsWith('bootstrap: FAILED:')).length, 1, r.stderr);
  }
});

test('bootstrap.sh --dry-run with a token: lists installs and reports, masks the token and the share link, changes nothing', { skip }, () => {
  const token = 'tok_DRYRUN_0123456789abcdef';
  const share = 'https://login.tailscale.com/admin/invite/DRYRUNSHARE';
  const r = run(['--dry-run', '--hub', 'http://hub.invalid:8787', '--token', token, '--share', share], { ASK_INSTALL_SOURCE: '/tmp/ask-src' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr.includes(token), false, 'token printed');
  assert.equal(r.stderr.includes(share), false, 'share link printed');
  assert.match(r.stderr, /would run: ask setup --hub http:\/\/hub\.invalid:8787 --token \*{8} --share <link from your message>/);
  for (const s of ['homebrew', 'git', 'node', 'gh', 'tailscale', 'ask', 'assistant']) assert.match(r.stderr, new RegExp(`would report: ${s} (skipped|started|done)`));
  assert.match(r.stderr, /ask setup would report: github-sign-in, tailscale-sign-in, hub-reached, identity, registered, mcp, standby, ready/);
  assert.doesNotMatch(r.stderr, /\[y\/N\]/);
  assert.equal(r.stderr.trim().split('\n').at(-1), 'DRY RUN OK: no changes made');
});

test('bootstrap.sh rejects a --share that is not an https link', { skip }, () => {
  const r = run(['--dry-run', '--hub', 'http://hub.invalid:8787', '--token', 'x', '--share', 'file:///etc/passwd']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /bootstrap: FAILED: --share must be an https:\/\/ link/);
});

test('rehearsal: bootstrap.sh piped like curl|bash, stubs only — all scenarios', { skip, timeout: 400_000 }, () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'rehearse-bootstrap.js'), 'all'], { encoding: 'utf8', timeout: 390_000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.deepEqual(lines.slice(0, 2), [
    'BOOTSTRAP OK: 7 installs, 0 questions asked, 15 steps reported in order, registered after approval, standby verified, first question sent',
    'BOOTSTRAP OK: 0 installs, 0 questions asked, 15 steps reported in order, registered after approval, standby verified, first question sent',
  ]);
  const ok = lines.filter((l) => /^REHEARSAL \S+ OK:/.test(l)).map((l) => l.split(' ')[1]);
  assert.deepEqual(ok, ['refused', 'expired', 'unreachable', 'progress-fail', 'rate-limited', 'repaste', 'repaste-dead', 'node-23', 'node-22', 'node-odd-formula', 'node-newest-missing', 'node-fallback', 'sudo-refused', 'non-admin'], r.stdout);
});

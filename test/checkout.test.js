// @ts-check
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CLI, runCli, tempEnv } from './helpers.js';

const REPO = 'test-team/sandbox';
const ORIGIN = `https://github.com/${REPO}.git`;
const checkCommand = ['checkout-check', '--repo', REPO];

/** @param {string} cwd @param {string[]} args */
function git(cwd, args) {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

/** @param {string} cwd @param {string} [origin] */
function cloneFixture(cwd, origin = ORIGIN) {
  fs.mkdirSync(cwd, { recursive: true });
  git(cwd, ['init', '--quiet']);
  git(cwd, ['remote', 'add', 'origin', origin]);
  return cwd;
}

/** @param {import('node:test').TestContext} tc */
function fixture(tc) {
  const t = tempEnv(null);
  tc.after(t.cleanup);
  const home = path.join(t.dir, 'private home');
  fs.mkdirSync(home);
  Object.assign(t.env, { HOME: home, USERPROFILE: home });
  const teamPath = (/** @type {string[]} */ ...root) => path.join(home, ...root, 'Projects', 'drunkencoders', 'sandbox');
  /** @param {string[]} [args] @param {number} [code] */
  const check = async (args = [], code = 0) => {
    const r = await runCli([...checkCommand, ...args], t).done;
    assert.equal(r.stderr, '');
    assert.equal(r.code, code);
    return JSON.parse(r.stdout);
  };
  return { t, home, desktop: teamPath('Desktop'), homeProjects: teamPath(), check };
}

test('local CLI refuses without consent and does not write state', async (tc) => {
  const { t, desktop, check } = fixture(tc);
  cloneFixture(desktop);
  const trap = path.join(t.dir, 'trace-file');
  t.env.GIT_TRACE = trap;
  assert.deepEqual(await check([], 5), { status: 'consent_required' });
  assert.equal(fs.existsSync(trap), false);
  assert.equal(fs.existsSync(t.pendingFile), false);
});

test('the default check covers both standard folders, even when both exist', async (tc) => {
  const { desktop, homeProjects, check } = fixture(tc);
  fs.mkdirSync(path.dirname(homeProjects), { recursive: true });
  fs.mkdirSync(path.dirname(desktop), { recursive: true });
  assert.deepEqual(await check(['--consent']), { status: 'missing', checked: ['desktop_projects', 'home_projects'] });
  cloneFixture(desktop);
  assert.deepEqual(await check(['--consent']), { status: 'ready' });
  fs.rmSync(desktop, { recursive: true });
  cloneFixture(homeProjects, 'git@github.com:Test-Team/sandbox.git');
  assert.deepEqual(await check(['--consent']), { status: 'ready' });
});

test('a confirmed Projects root takes precedence and only a supplied alternative is checked', async (tc) => {
  const { home, desktop, check } = fixture(tc);
  cloneFixture(desktop);
  const confirmedRoot = '~/Another Projects Folder';
  const checkout = path.join(home, 'private elsewhere');
  const args = ['--consent', '--projects-root', confirmedRoot];
  assert.deepEqual(await check(args), { status: 'missing', checked: ['confirmed_projects'] });
  assert.deepEqual(await check([...args, '--checkout', checkout]), { status: 'missing', checked: ['confirmed_projects', 'supplied_checkout'] });
  cloneFixture(checkout, `ssh://git@github.com/${REPO}.git`);
  assert.deepEqual(await check([...args, '--checkout', checkout]), { status: 'elsewhere' });
  cloneFixture(path.join(home, 'Another Projects Folder', 'drunkencoders', 'sandbox'));
  assert.deepEqual(await check([...args, '--checkout', checkout]), { status: 'ready' });
});

test('the given folder must be the exact worktree root, including for linked worktrees', async (tc) => {
  const { home, desktop, check } = fixture(tc);
  const parent = cloneFixture(path.join(home, 'Desktop'));
  fs.mkdirSync(desktop, { recursive: true });
  assert.deepEqual(await check(['--consent']), { status: 'missing', checked: ['desktop_projects', 'home_projects'] });
  git(parent, ['-c', 'user.name=Fixture', '-c', 'user.email=test@example.invalid', 'commit', '--no-gpg-sign', '--allow-empty', '-m', 'fixture']);
  git(parent, ['worktree', 'add', '--detach', desktop]);
  fs.writeFileSync(path.join(desktop, 'uncommitted.txt'), 'still here');
  assert.deepEqual(await check(['--consent']), { status: 'ready' });
});

test('an origin with a lookalike host, extra path, wrong project or local rewrite does not pass', async (tc) => {
  const { desktop, check } = fixture(tc);
  cloneFixture(desktop);
  git(desktop, ['config', `url.${ORIGIN}.insteadOf`, 'sandbox-alias']);
  for (const origin of [
    `https://github.com.evil.invalid/${REPO}.git`, `git@other-host.invalid:${REPO}.git`,
    `https://private-user:private-token@evil.invalid/${REPO}.git`,
    `https://github.com/private-extra/${REPO}.git`, `../${REPO}`, 'sandbox-alias',
    'https://github.com/other-team/sandbox.git', 'https://github.com/test-team/other.git',
  ]) {
    git(desktop, ['remote', 'set-url', 'origin', origin]);
    assert.deepEqual(await check(['--consent']), { status: 'missing', checked: ['desktop_projects', 'home_projects'] });
  }
});

test('broken Git metadata or bad inputs give a redacted unknown; Git environment cannot change the check', async (tc) => {
  const { t, home, desktop, check } = fixture(tc);
  const trap = path.join(t.dir, 'private trace file');
  t.env.GIT_TRACE = trap;
  t.env.GIT_DIR = path.join(home, 'nonexistent private git directory');
  t.env.GIT_WORK_TREE = home;
  cloneFixture(desktop);
  assert.deepEqual(await check(['--consent']), { status: 'ready' });
  assert.equal(fs.existsSync(trap), false);
  git(desktop, ['config', '--add', 'remote.origin.url', 'https://private-token@evil.invalid/private-remote']);
  assert.deepEqual(await check(['--consent']), { status: 'unknown' });
  assert.deepEqual(await check(['--consent', '--checkout', 'private/relative/path']), { status: 'unknown' });
  const malformed = await runCli([...checkCommand, '--consent', 'private-raw-path'], t).done;
  assert.equal(malformed.code, 2);
  assert.equal(malformed.stdout, '');
  assert.doesNotMatch(malformed.stderr, /private-raw-path/);
  fs.rmSync(path.join(desktop, '.git'), { recursive: true });
  fs.writeFileSync(path.join(desktop, '.git'), `gitdir: ${path.join(t.dir, 'private broken target')}\n`);
  assert.deepEqual(await check(['--consent']), { status: 'unknown' });
  const alternate = cloneFixture(path.join(home, 'alternate'));
  assert.deepEqual(await check(['--consent', '--checkout', alternate]), { status: 'elsewhere' });
});

test('MCP uses the same consent and redacted statuses without a hub or pending record', async (tc) => {
  const { t, home } = fixture(tc);
  const privateCheckout = path.join(home, 'private checkout');
  const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, 'mcp'], env: t.env, cwd: t.cwd, stderr: 'pipe' });
  const client = new Client({ name: 'checkout-test', version: '1.0.0' });
  let stderr = '';
  await client.connect(transport);
  transport.stderr?.on('data', (chunk) => { stderr += chunk; });
  try {
    /** @param {boolean} consent */
    const call = (consent) => client.callTool({ name: 'ask_checkout_check', arguments: { consent, repo: REPO, checkout: privateCheckout } });
    assert.deepEqual(await call(false), { content: [{ type: 'text', text: '{"status":"consent_required"}' }], isError: true });
    cloneFixture(privateCheckout);
    assert.deepEqual(await call(true), { content: [{ type: 'text', text: '{"status":"elsewhere"}' }], isError: false });
    git(privateCheckout, ['remote', 'set-url', 'origin', 'https://private-token@evil.invalid/private-remote']);
    assert.deepEqual(await call(true), {
      content: [{ type: 'text', text: '{"status":"missing","checked":["desktop_projects","home_projects","supplied_checkout"]}' }],
      isError: false,
    });
  } finally {
    await client.close();
  }
  assert.equal(stderr, '');
  assert.equal(fs.existsSync(t.env.XDG_STATE_HOME), false);
});

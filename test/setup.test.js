// @ts-check
// `ask setup`, `ask doctor`, `ask standby`, run as real processes against the
// stub hub, with stub tailscale/gh/assistant CLIs first on PATH and a temp HOME.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startStubHub } from './stub-hub.js';
import { tempEnv, runCli } from './helpers.js';
import { writeStubBin } from './fixtures/stub-bin.js';
import { memfs } from './fixtures/memfs.js';
import { locateTailscale } from '../src/setup/tailscale.js';
import { runSetup } from '../src/setup/setup.js';

/**
 * @param {any} hub @param {{ stubs?: string[], env?: Record<string,string>, cursor?: boolean }} [o]
 */
function setupEnv(hub, o = {}) {
  const t = tempEnv(null);
  const home = path.join(t.dir, 'home');
  fs.mkdirSync(home);
  if (o.cursor) fs.mkdirSync(path.join(home, '.cursor'));
  const stubBin = writeStubBin(path.join(t.dir, 'stubs'), o.stubs);
  // node only (its own folder may also hold real assistant CLIs, e.g. Homebrew).
  const nodeBin = path.join(t.dir, 'nodebin');
  fs.mkdirSync(nodeBin);
  fs.symlinkSync(process.execPath, path.join(nodeBin, 'node'));
  t.env.HOME = home;
  t.env.PATH = [stubBin, nodeBin, '/usr/bin', '/bin'].join(path.delimiter);
  t.env.STUB_LOG = path.join(t.dir, 'stub.log');
  delete t.env.CODEX_HOME;
  Object.assign(t.env, o.env ?? {});
  return { ...t, home, configFile: path.join(t.env.XDG_CONFIG_HOME, 'drunkencoders', 'ask.json'), log: () => (fs.existsSync(t.env.STUB_LOG) ? fs.readFileSync(t.env.STUB_LOG, 'utf8') : '') };
}

/** Every file under home, path → content. */
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = fs.readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return out;
}

test('setup: config, Tailscale, hub, gh, whoami, all four assistants, standby → exit 0; doctor all ok; second run byte-identical', async () => {
  const hub = await startStubHub();
  const t = setupEnv(hub, { cursor: true });
  try {
    const r = await runCli(['setup', '--hub', hub.url], t).done;
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim().split('\n').at(-1), `Standby verified: nora via ${hub.url}`);
    assert.deepEqual(JSON.parse(fs.readFileSync(t.configFile, 'utf8')), { hub_url: hub.url });
    for (const label of ['Claude Code', 'Cursor', 'Codex CLI', 'Gemini CLI']) assert.match(r.stderr, new RegExp(`${label}: registered`));
    assert.match(r.stderr, /AGENTS\.md/);
    assert.match(r.stderr, /ask "Your question, self-contained"/);
    // The hub saw the standby test with the registered assistants, and would post the status line.
    const sb = hub.state.createBodies.find((b) => b.kind === 'standby_test');
    assert.deepEqual(sb.client.tools.sort(), ['claude-code', 'codex', 'cursor', 'gemini-cli']);
    assert.equal(hub.state.statusPosts.length, 1);
    assert.match(hub.state.statusPosts[0], /^Standby verified: nora on .+ — ask 0\.1\.0, darwin, tools: /);
    assert.equal(JSON.parse(fs.readFileSync(path.join(t.home, '.cursor', 'mcp.json'), 'utf8')).mcpServers.ask.command, 'ask');

    const before = snapshot(t.home);
    const cfgBefore = fs.readFileSync(t.configFile, 'utf8');
    const r2 = await runCli(['setup', '--hub', hub.url], t).done;
    assert.equal(r2.code, 0, r2.stderr);
    assert.deepEqual(snapshot(t.home), before, 'assistant configs byte-identical after a second setup');
    assert.equal(fs.readFileSync(t.configFile, 'utf8'), cfgBefore);
    assert.equal((t.log().match(/ mcp add /g) ?? []).length, 3, 'no CLI registration on the second run');

    const d = await runCli(['doctor'], t).done;
    assert.equal(d.code, 0, d.stdout + d.stderr);
    assert.doesNotMatch(d.stdout, /FAIL/);
    for (const name of ['OS', 'Node', 'ask', 'config', 'Tailscale', 'hub health', 'whoami', 'GitHub CLI', 'MCP in Claude Code', 'MCP in Cursor', 'MCP in Codex CLI', 'MCP in Gemini CLI']) {
      assert.match(d.stdout, new RegExp(`^ok {2}\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:`, 'm'));
    }

    // Uninstall: entries gone, config file gone, other content untouched.
    const u = await runCli(['setup', '--unregister'], t).done;
    assert.equal(u.code, 0, u.stderr);
    assert.equal(fs.existsSync(t.configFile), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(t.home, '.claude.json'), 'utf8')).mcpServers.ask, undefined);
    assert.equal(JSON.parse(fs.readFileSync(path.join(t.home, '.cursor', 'mcp.json'), 'utf8')).mcpServers.ask, undefined);
    assert.doesNotMatch(fs.readFileSync(path.join(t.home, '.codex', 'config.toml'), 'utf8'), /mcp_servers\.ask/);
    const d2 = await runCli(['doctor'], t).done;
    assert.notEqual(d2.code, 0);
  } finally {
    await hub.close();
    t.cleanup();
  }
});

test('setup: Tailscale signed out and non-interactive → non-zero, names Tailscale, no standby', async () => {
  const hub = await startStubHub();
  const t = setupEnv(hub, { env: { STUB_TS_STATE: 'needs_login' } });
  try {
    const r = await runCli(['setup', '--hub', hub.url], t).done;
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /FAILED: Tailscale is not signed in \(NeedsLogin\)/);
    assert.equal(hub.state.createBodies.length, 0);
    const d = await runCli(['doctor'], t).done;
    assert.match(d.stdout, /^FAIL {2}Tailscale: not connected \(NeedsLogin\)/m);
    assert.notEqual(d.code, 0);
  } finally {
    await hub.close();
    t.cleanup();
  }
});

test('Tailscale CLI location: PATH, then the macOS app bundle / Windows Program Files', () => {
  const mk = (platform, files, env = {}) => ({ platform, env, which: () => null, fs: memfs(files) });
  assert.equal(locateTailscale(/** @type {any} */ (mk('darwin', { '/Applications/Tailscale.app/Contents/MacOS/Tailscale': '' }))), '/Applications/Tailscale.app/Contents/MacOS/Tailscale');
  assert.equal(locateTailscale(/** @type {any} */ (mk('win32', { 'C:\\Program Files\\Tailscale\\tailscale.exe': '' }, { ProgramFiles: 'C:\\Program Files' }))), 'C:\\Program Files\\Tailscale\\tailscale.exe');
  assert.equal(locateTailscale(/** @type {any} */ (mk('win32', {}))), null);
  assert.equal(locateTailscale(/** @type {any} */ ({ ...mk('darwin', {}), which: () => '/usr/local/bin/tailscale' })), '/usr/local/bin/tailscale');
});

test('Tailscale on macOS: /usr/local/bin and /opt/homebrew/bin wrappers are preferred to the app bundle', () => {
  const app = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
  const mk = (files) => /** @type {any} */ ({ platform: 'darwin', env: {}, which: () => null, fs: memfs(files) });
  assert.equal(locateTailscale(mk({ [app]: '', '/usr/local/bin/tailscale': '' })), '/usr/local/bin/tailscale');
  assert.equal(locateTailscale(mk({ [app]: '', '/opt/homebrew/bin/tailscale': '' })), '/opt/homebrew/bin/tailscale');
  assert.equal(locateTailscale(mk({ [app]: '' })), app);
});

test('Tailscale calls set SHLVL=1 when it is missing (app binary started without a shell)', async () => {
  const hub = await startStubHub();
  const t = setupEnv(hub, { env: { STUB_TS_NEEDS_SHLVL: '1' } });
  t.env.ASK_HUB_URL = hub.url;
  delete t.env.SHLVL;
  try {
    const d = await runCli(['doctor'], t).done;
    assert.match(d.stdout, /^ok {4}Tailscale: signed in as nora@example\.com/m, d.stdout);
    // Control: the stub really fails without SHLVL.
    const { spawnSync } = await import('node:child_process');
    const env = { ...t.env };
    delete env.SHLVL;
    const raw = spawnSync(path.join(t.dir, 'stubs', 'tailscale'), ['status', '--json'], { env, encoding: 'utf8' });
    assert.equal(raw.status, 1);
    assert.match(raw.stderr, /CLIError error 3/);
  } finally {
    await hub.close();
    t.cleanup();
  }
});

test('setup: Tailscale not installed → non-zero naming Tailscale', async () => {
  const hub = await startStubHub();
  const lines = [];
  /** @type {any} */
  const sys = {
    platform: 'win32',
    env: { APPDATA: 'C:\\Users\\nora\\AppData\\Roaming' },
    homedir: 'C:\\Users\\nora',
    interactive: false,
    out: (l) => lines.push(l),
    err: (l) => lines.push(l),
    which: () => null,
    fs: memfs(),
    now: () => new Date(),
  };
  try {
    const code = await runSetup(sys, ['--hub', hub.url]);
    assert.notEqual(code, 0);
    assert.match(lines.join('\n'), /FAILED: Tailscale is not installed/);
    assert.ok(sys.fs.files.has('C:\\Users\\nora\\AppData\\Roaming\\drunkencoders\\ask.json'), 'config written at the Windows location');
  } finally {
    await hub.close();
  }
});

test('setup: unknown_caller stops with the Tailscale login and "ask Jose"', async () => {
  const hub = await startStubHub({ teammate: null });
  const t = setupEnv(hub, { env: { STUB_TS_LOGIN: 'grish@gmail.example' } });
  try {
    const r = await runCli(['setup', '--hub', hub.url], t).done;
    assert.equal(r.code, 5, r.stderr);
    assert.match(r.stderr, /Tailscale login is grish@gmail\.example \(host noras-mbp\): ask Jose to add it to the hub's config/);
    assert.doesNotMatch(r.stderr, /== Assistants/, 'never continues unverified');
    assert.equal(hub.state.createBodies.length, 0);
  } finally {
    await hub.close();
    t.cleanup();
  }
});

test('setup: gh signed out and non-interactive → non-zero naming GitHub', async () => {
  const hub = await startStubHub();
  const t = setupEnv(hub, { env: { STUB_GH: 'signed_out' } });
  try {
    const r = await runCli(['setup', '--hub', hub.url], t).done;
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /FAILED: GitHub CLI is not signed in/);
  } finally {
    await hub.close();
    t.cleanup();
  }
});

test('setup: hub not answering while Tailscale is up → says the hub is down; Tailscale down → says Tailscale', async () => {
  const t = setupEnv(null);
  try {
    const r = await runCli(['setup', '--hub', 'http://127.0.0.1:9'], t).done;
    assert.equal(r.code, 4, r.stderr);
    assert.match(r.stderr, /Tailscale is up and "127\.0\.0\.1" resolves, but the hub is not answering/);
    t.env.STUB_TS_STATE = 'error';
    const d = await runCli(['doctor'], t).done;
    assert.match(d.stdout, /FAIL {2}hub health: Tailscale is not connected/);
  } finally {
    t.cleanup();
  }
});

test('setup: an installed assistant that cannot be registered is reported and setup exits non-zero', async () => {
  const hub = await startStubHub();
  const t = setupEnv(hub);
  try {
    // A broken Claude Code: its CLI exists but fails.
    fs.writeFileSync(path.join(t.dir, 'stubs', 'claude.mjs'), "process.stderr.write('boom\\n'); process.exit(1);\n");
    const r = await runCli(['setup', '--hub', hub.url], t).done;
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /Claude Code: NOT registered: .*boom/);
    assert.match(r.stdout, /Standby verified/);
    assert.match(r.stderr, /MCP registration failed for Claude Code/);
  } finally {
    await hub.close();
    t.cleanup();
  }
});

test('standby: no successful receipt → non-zero and no "verified" line', async () => {
  const hub = await startStubHub();
  const t = setupEnv(hub, { env: {} });
  t.env.ASK_HUB_URL = hub.url;
  try {
    hub.state.failReceipts = 100;
    const r = await runCli(['standby'], t).done;
    assert.notEqual(r.code, 0);
    assert.doesNotMatch(r.stdout, /Standby verified/);
    assert.match(r.stderr, /receipt .* was not recorded/);
    assert.equal(hub.state.statusPosts.length, 0);
    hub.state.failReceipts = 0;
    const r2 = await runCli(['standby'], t).done;
    assert.equal(r2.code, 0, r2.stderr);
    assert.equal(r2.stdout, `Standby verified: nora via ${hub.url}\n`);
  } finally {
    await hub.close();
    t.cleanup();
  }
});

test('standby without any hub address → exit 2', async () => {
  const t = setupEnv(null);
  try {
    const r = await runCli(['standby'], t).done;
    assert.equal(r.code, 2);
    assert.match(r.stderr, /ask setup/);
  } finally {
    t.cleanup();
  }
});

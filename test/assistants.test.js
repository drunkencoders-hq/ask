// @ts-check
// Every assistant module, for darwin and win32, against an in-memory fs:
// documented config path and shape, backup, idempotency, unregister.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { memfs } from './fixtures/memfs.js';
import { fakeAssistantCli } from './fixtures/fake-assistant-cli.js';
import { ASSISTANTS } from '../src/setup/assistants/index.js';
import { serverSpec } from '../src/setup/assistants/common.js';
import { readCodexEntry } from '../src/setup/assistants/codex.js';
import { spawnPlan, whichIn } from '../src/setup/sys.js';

const HOMES = { darwin: '/Users/nora', win32: 'C:\\Users\\nora' };
const NODE_WIN = 'C:\\Program Files\\nodejs\\node.exe';
const CLI_WIN = 'C:\\Users\\nora\\AppData\\Roaming\\npm\\node_modules\\drunkencoders-ask\\src\\cli.js';

/** Expected config file per assistant and platform (from each tool's docs). */
const EXPECTED_PATH = {
  'claude-code': { darwin: '/Users/nora/.claude.json', win32: 'C:\\Users\\nora\\.claude.json' },
  cursor: { darwin: '/Users/nora/.cursor/mcp.json', win32: 'C:\\Users\\nora\\.cursor\\mcp.json' },
  codex: { darwin: '/Users/nora/.codex/config.toml', win32: 'C:\\Users\\nora\\.codex\\config.toml' },
  'gemini-cli': { darwin: '/Users/nora/.gemini/settings.json', win32: 'C:\\Users\\nora\\.gemini\\settings.json' },
};
const BIN = { 'claude-code': 'claude', codex: 'codex', 'gemini-cli': 'gemini' };

/** @param {'darwin'|'win32'} platform @param {Record<string,string>} [files] @param {string[]} [installed] */
function simSys(platform, files = {}, installed = ['claude', 'codex', 'gemini']) {
  const P = platform === 'win32' ? path.win32 : path.posix;
  const home = HOMES[platform];
  const fs = memfs(files, [P.join(home, '.cursor')]);
  const calls = [];
  let t = 0;
  /** @type {any} */
  const sys = {
    platform,
    env: {},
    homedir: home,
    cwd: home,
    interactive: false,
    out: () => {},
    err: () => {},
    which: (c) => (installed.includes(c) ? P.join(home, 'bin', c) : null),
    run: async (cmd, args) => {
      calls.push([cmd, ...args]);
      return fakeAssistantCli(/** @type {any} */ (cmd), args, { fs, join: P.join, home, env: {} });
    },
    runInteractive: async () => 0,
    prompt: async () => '',
    now: () => new Date(Date.UTC(2026, 10, 16, 9, 0, t++)),
    fs,
    nodePath: NODE_WIN,
    askCliPath: CLI_WIN,
  };
  return { sys, fs, calls };
}

test('server spec: bare `ask mcp` on macOS; node.exe + absolute cli.js on Windows', () => {
  assert.deepEqual(serverSpec(simSys('darwin').sys), { command: 'ask', args: ['mcp'] });
  assert.deepEqual(serverSpec(simSys('win32').sys), { command: NODE_WIN, args: [CLI_WIN, 'mcp'] });
});

for (const platform of /** @type {const} */ (['darwin', 'win32'])) {
  for (const a of ASSISTANTS) {
    test(`${a.label} on ${platform}: fresh register, idempotent, unregister`, async () => {
      const { sys, fs, calls } = simSys(platform);
      const spec = serverSpec(sys);
      const file = EXPECTED_PATH[a.id][platform];
      assert.equal(a.configPath(sys), file);
      assert.equal(a.detect(sys), true);
      assert.equal(a.status(sys, spec), 'absent');

      await a.register(sys, spec);
      assert.equal(a.status(sys, spec), 'registered');
      const text = fs.files.get(file);
      assert.ok(text, `wrote ${file}`);
      if (a.id === 'codex') {
        assert.deepEqual(readCodexEntry(text), { command: spec.command, args: spec.args });
      } else {
        const entry = JSON.parse(text).mcpServers.ask;
        assert.equal(entry.command, spec.command);
        assert.deepEqual(entry.args, spec.args);
      }
      if (BIN[a.id]) {
        assert.equal(calls[0][0], BIN[a.id], 'uses the tool CLI');
        assert.ok(calls[0].includes(spec.command));
      } else assert.equal(calls.length, 0, 'Cursor: file edit only');

      // Second run: nothing changes, no CLI call, byte-identical.
      const before = new Map(fs.files);
      const n = calls.length;
      const r2 = await a.register(sys, spec);
      assert.equal(r2.changed, false);
      assert.equal(calls.length, n);
      assert.deepEqual(new Map(fs.files), before);

      await a.unregister(sys);
      assert.equal(a.status(sys, spec), 'absent');
      const r3 = await a.unregister(sys);
      assert.equal(r3.changed, false);
    });

    test(`${a.label} on ${platform}: existing config is preserved, never duplicated, stale entry replaced`, async () => {
      const P = platform === 'win32' ? path.win32 : path.posix;
      const file = EXPECTED_PATH[a.id][platform];
      const existing =
        a.id === 'codex'
          ? 'model = "o4"\n\n[mcp_servers.other]\ncommand = "other"\nargs = []\n\n[mcp_servers.ask]\ncommand = "old-ask"\nargs = ["mcp"]\n'
          : JSON.stringify({ theme: 'dark', mcpServers: { other: { command: 'other', args: [] }, ask: { command: 'old-ask', args: ['mcp'] } } }, null, 2);
      const { sys, fs } = simSys(platform, { [file]: existing });
      const spec = serverSpec(sys);
      assert.equal(a.status(sys, spec), 'different');
      await a.register(sys, spec);
      assert.equal(a.status(sys, spec), 'registered');
      const text = fs.files.get(file);
      if (a.id === 'codex') {
        assert.match(text, /model = "o4"/);
        assert.match(text, /\[mcp_servers\.other\]/);
        assert.equal(text.match(/\[mcp_servers\.ask\]/g)?.length, 1);
      } else {
        const j = JSON.parse(text);
        assert.equal(j.theme, 'dark');
        assert.equal(j.mcpServers.other.command, 'other');
        assert.equal(Object.keys(j.mcpServers).filter((k) => k === 'ask').length, 1);
      }
      if (a.id === 'cursor') {
        const backups = [...fs.files.keys()].filter((k) => k.startsWith(file + '.bak-'));
        assert.equal(backups.length, 1, 'timestamped backup');
        assert.match(backups[0], /\.bak-\d{8}-\d{6}$/);
        assert.equal(fs.files.get(backups[0]), existing);
        assert.equal(P.dirname(backups[0]), P.dirname(file));
      }
      await a.unregister(sys);
      const after = fs.files.get(file);
      if (a.id === 'codex') assert.match(after, /\[mcp_servers\.other\]/);
      else assert.equal(JSON.parse(after).mcpServers.other.command, 'other');
    });
  }

  test(`not installed → not detected (${platform})`, () => {
    const { sys } = simSys(platform, {}, []);
    for (const a of ASSISTANTS.filter((x) => x.id !== 'cursor')) assert.equal(a.detect(sys), false);
    sys.fs.dirs.clear();
    assert.equal(ASSISTANTS.find((x) => x.id === 'cursor')?.detect(sys), false);
  });
}

test('Codex honours CODEX_HOME', () => {
  const { sys } = simSys('win32');
  sys.env.CODEX_HOME = 'D:\\codex';
  assert.equal(ASSISTANTS.find((x) => x.id === 'codex')?.configPath(sys), 'D:\\codex\\config.toml');
});

test('Windows: .cmd shims are launched through the shell with quoted args; .exe directly', () => {
  assert.deepEqual(spawnPlan('C:\\Users\\nora\\AppData\\Roaming\\npm\\claude.cmd', ['mcp', 'add', '--', NODE_WIN, 'mcp'], 'win32'), {
    file: 'C:\\Users\\nora\\AppData\\Roaming\\npm\\claude.cmd mcp add -- "C:\\Program Files\\nodejs\\node.exe" mcp',
    args: [],
    shell: true,
  });
  assert.equal(spawnPlan('C:\\Program Files\\GitHub CLI\\gh.exe', ['auth', 'status'], 'win32').shell, false);
  assert.equal(spawnPlan('/opt/homebrew/bin/claude', ['mcp'], 'darwin').shell, false);
});

test('which() on this host finds node; PATHEXT logic is used for win32', () => {
  assert.ok(whichIn('node', { platform: process.platform, env: process.env }));
  assert.equal(whichIn('definitely-not-a-command-xyz', { platform: process.platform, env: process.env }), null);
});

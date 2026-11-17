import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createClient, VERSION } from '../src/client.js';
import { runDoctor } from '../src/setup/doctor.js';
import { onboardingClient } from '../src/setup/onboarding.js';
import { realSys } from '../src/setup/sys.js';
import { writeStubBin } from '../test/fixtures/stub-bin.js';
import { CLI, runCli, tempEnv } from '../test/helpers.js';
import { startStubHub } from '../test/stub-hub.js';

const latest = `${Number(VERSION.split('.')[0]) + 1}.0.0`;
const notice = 'https://example.invalid/archives/C0NORA/p00001';
const token = 'test-onboarding-token';
const hub = await startStubHub({ askLatest: latest, noticeLink: notice, autoAnswerMs: 30, onboarding: { token } });
const t = tempEnv(hub.url);
const home = path.join(t.dir, 'home');
const marker = path.join(t.dir, 'must-not-run');
const command = `touch ${marker}`;
hub.state.updateCommand = command;
let mcp;
try {
  fs.mkdirSync(home);
  const bin = writeStubBin(path.join(t.dir, 'stubs'), ['tailscale', 'gh']);
  const env = { ...t.env, HOME: home, PATH: `${bin}:/usr/bin:/bin`, ASK_NONINTERACTIVE: '1' };
  const needed = { current: VERSION, latest, command, notice };

  const cli = await runCli(['Should I use JSON?', '--project', 'sandbox', '--json'], { ...t, env }).done;
  assert.equal(cli.code, 0, cli.stderr);
  assert.equal((cli.stderr.match(/Your ask is out of date/g) ?? []).length, 1);
  assert.match(cli.stderr, /To update, run: touch /);
  const answer = JSON.parse(cli.stdout);
  assert.equal(answer.status, 'answered');
  assert.deepEqual(answer.ask_update, needed);
  assert.equal(hub.state.calls['GET /v1/ask-version'], 1);

  const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, 'mcp'], cwd: t.cwd, env, stderr: 'pipe' });
  mcp = new Client({ name: 'rehearse-update', version: '1.0.0' });
  await mcp.connect(transport);
  assert.match(mcp.getInstructions(), /only after the user clearly says yes/);
  const r = await mcp.callTool({ name: 'ask', arguments: { question: 'CSV or JSON?', project: 'sandbox', wait_seconds: 5 } });
  assert.equal(r.isError, false, JSON.stringify(r));
  assert.equal(r.content.length, 2);
  assert.match(r.content[0].text, /^ANSWER from/);
  assert.match(r.content[1].text, /Your ask is out of date/);
  assert.match(r.content[1].text, /only after the user clearly says yes/);
  await hub.waitForStatus([...hub.state.questions.keys()].at(-1), 'delivered');
  assert.equal(hub.state.calls['GET /v1/ask-version'], 1, 'MCP reuses the disk cache from the CLI');

  const lines = [];
  const sys = realSys({ env, homedir: home, platform: 'darwin', out: (line) => lines.push(line) });
  assert.equal(await runDoctor(sys, { nodeVersion: '24.22.3', json: true }), 0);
  const doctor = JSON.parse(lines[0]);
  assert.equal(doctor.checks.find((c) => c.name === 'ask update')?.level, 'warn');
  assert.deepEqual(doctor.ask_update, needed);
  assert.equal(hub.state.calls['GET /v1/ask-version'], 1, 'doctor reuses the cache too');

  const client = createClient({ hubUrl: hub.url, via: 'cli' });
  const hello = await onboardingClient(hub.url, token)('hello', { client: client.clientInfo });
  assert.equal(hello.state, 'identified');
  const id = hub.createSlackQuestion({ question: 'Can you send the draft image?', project: 'sandbox' });
  const bytes = Buffer.from('stub file');
  const [attachment] = hub.answerDraft(id, { attachments: [{ kind: 'image', filename: 'draft.png', media_type: 'image/png', bytes }] });
  assert.deepEqual(await client.downloadAttachment(id, attachment), bytes);

  for (const req of hub.state.requests) {
    assert.equal(req.version, VERSION, `${req.method} ${req.path}`);
    assert.ok(req.client === 'cli' || req.client === 'mcp', `${req.method} ${req.path}`);
  }
  assert.deepEqual(hub.state.createBodies.map(({ client }) => [client.version, client.via]), [[VERSION, 'cli'], [VERSION, 'mcp']]);
  assert.equal(fs.existsSync(marker), false);
  const state = path.dirname(t.pendingFile);
  const filename = path.join(state, fs.readdirSync(state).find((f) => f.startsWith('update-')));
  const cache = JSON.parse(fs.readFileSync(filename, 'utf8'));
  fs.writeFileSync(filename, JSON.stringify({ ...cache, cached_at: Date.now() - 3600_001 }));
  const refresh = await runCli(['--list', '--json'], { ...t, env }).done;
  assert.equal(refresh.code, 0, refresh.stderr);
  assert.deepEqual(JSON.parse(refresh.stdout).ask_update, needed);
  assert.equal(hub.state.calls['GET /v1/ask-version'], 2, 'cache is refreshed after one hour');

  process.stdout.write('UPDATE OK: version sent on every call, warning shown once in CLI and MCP, hub-supplied command never executed, doctor warns\n');
} finally {
  await mcp?.close();
  await hub.close();
  t.cleanup();
}

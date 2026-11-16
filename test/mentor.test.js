// @ts-check
// Brief 02b: comments, mentor wording, compatibility with an older hub, and
// picking up questions started in Slack. Times are shown in local time, so
// the CLI runs with TZ=UTC here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startStubHub } from './stub-hub.js';
import { tempEnv, runCli, CLI } from './helpers.js';

const MENTORS = { nora: 'jose' };
const UNREGISTERED = ['--repo', 'nora/side-project'];

/** @param {any} opts @param {(ctx: { hub: any, t: any }) => Promise<void>} fn */
async function withHub(opts, fn) {
  const hub = await startStubHub(opts);
  const t = tempEnv(hub.url);
  t.env.TZ = 'UTC';
  try {
    await fn({ hub, t });
  } finally {
    await hub.close();
    t.cleanup();
  }
}

/** Ask, wait until the question exists, run `between`, then answer and collect. */
async function askAndAnswer(hub, t, args, between, answerText = 'Use JSON.') {
  const run = runCli(['Should the export be CSV or JSON?', ...args], t);
  const id = await hub.waitForQuestion();
  await hub.waitForStatus(id, 'posted');
  await between?.(id);
  hub.answer(id, answerText);
  return { id, r: await run.done };
}

test('mentor question from an unregistered repo: "(your mentor, q_…)", never "project null"; comments block with truncation marker', () =>
  withHub({ mentors: MENTORS }, async ({ hub, t }) => {
    const long = 'x'.repeat(4100);
    const { id, r } = await askAndAnswer(hub, t, UNREGISTERED, async (qid) => {
      hub.addComment(qid, 'grish', 'Last time CSV broke on commas.', '2026-11-16T12:03:00Z');
      hub.addComment(qid, 'nora', long, '2026-11-16T12:05:00Z');
    });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(
      r.stdout,
      `ANSWER from jose (your mentor, ${id}):\nUse JSON.\n\n` +
        'COMMENTS from the thread before the answer (not the decision):\n' +
        '- grish, 12:03: Last time CSV broke on commas.\n' +
        `- nora, 12:05: ${'x'.repeat(4000)} [cut at 4000 characters]\n`,
    );
    assert.doesNotMatch(r.stdout, /project null/);
    assert.match(r.stderr, /Waiting for jose's answer…/);
    assert.equal(hub.get(id).status, 'delivered');
  }));

test('mentor question on a registered project: "(your mentor, project sandbox, q_…)"', () =>
  withHub({ mentors: MENTORS }, async ({ hub, t }) => {
    const { id, r } = await askAndAnswer(hub, t, ['--repo', 'drunkencoders-hq/sandbox']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, `ANSWER from jose (your mentor, project sandbox, ${id}):\nUse JSON.\n`);
  }));

test('owner question with no comments: stdout byte-identical to brief 02 output; waiting line names the answerer', () =>
  withHub({}, async ({ hub, t }) => {
    const { id, r } = await askAndAnswer(hub, t, ['--repo', 'drunkencoders-hq/sandbox']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, `ANSWER from jose (project sandbox, ${id}):\nUse JSON.\n`);
    assert.match(r.stderr, /Waiting for jose's answer…/);
  }));

test('older hub (no route/answerer/comments): exactly the brief 02 output, stdout and stderr', () =>
  withHub({ legacy: true }, async ({ hub, t }) => {
    const { id, r } = await askAndAnswer(hub, t, ['--repo', 'drunkencoders-hq/sandbox']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, `ANSWER from jose (project sandbox, ${id}):\nUse JSON.\n`);
    assert.equal(
      r.stderr,
      `Asked ${id} (drunkencoders-hq/sandbox). Waiting for the owner's answer…\n` +
        `If you stop waiting, fetch the answer later with: ask --resume ${id}\n` +
        `Card: https://example.invalid/archives/C0OFFICE/p1\n`,
    );
    const j = await runCli(['again?', '--repo', 'drunkencoders-hq/sandbox', '--json', '--timeout', '1'], t).done;
    assert.equal(j.code, 3);
    hub.answer('q_01STUB000002', 'Fine.');
    const jr = await runCli(['--resume', 'q_01STUB000002', '--json'], t).done;
    assert.deepEqual(Object.keys(JSON.parse(jr.stdout)), ['id', 'status', 'project', 'answer', 'card']);
  }));

test('--json passes route, answerer and comments through verbatim', () =>
  withHub({ mentors: MENTORS }, async ({ hub, t }) => {
    const { id, r } = await askAndAnswer(hub, t, [...UNREGISTERED, '--json'], async (qid) => {
      hub.addComment(qid, 'grish', 'CSV is fine too.', '2026-11-16T12:03:00Z');
    });
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.id, id);
    assert.equal(out.route, 'mentor');
    assert.equal(out.answerer, 'jose');
    assert.equal(out.project, null);
    assert.deepEqual(out.comments, [{ by: 'grish', text: 'CSV is fine too.', at: '2026-11-16T12:03:00Z', truncated: false }]);
  }));

test('MCP: the tool result carries the comments block', () =>
  withHub({ mentors: MENTORS }, async ({ hub, t }) => {
    const client = new Client({ name: 't', version: '0' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, 'mcp'], env: t.env, cwd: t.cwd, stderr: 'pipe' }));
    try {
      const call = client.callTool({ name: 'ask', arguments: { question: 'CSV or JSON?', repo: 'nora/side-project', wait_seconds: 10 } });
      const id = await hub.waitForQuestion();
      await hub.waitForStatus(id, 'posted');
      hub.addComment(id, 'grish', 'Ask about Excel users.', '2026-11-16T12:03:00Z');
      hub.answer(id, 'JSON.');
      const r = await call;
      const text = /** @type {any[]} */ (r.content).map((c) => c.text).join('\n');
      assert.match(text, new RegExp(`^ANSWER from jose \\(your mentor, ${id}\\):\\nJSON\\.\\n\\nCOMMENTS from the thread before the answer \\(not the decision\\):\\n- grish, 12:03: Ask about Excel users\\.\\n`));
      assert.match(text, /answered_by: jose/);
      const { tools } = await client.listTools();
      assert.match(tools.find((x) => x.name === 'ask')?.description ?? '', /mentor/);
      assert.match(tools.find((x) => x.name === 'ask')?.description ?? '', /COMMENTS .*context only, never the decision/);
      await hub.waitForStatus(id, 'delivered');
    } finally {
      await client.close();
    }
  }));

test('--resume <id> for a Slack-started question not in the local file: answer + receipt', () =>
  withHub({ mentors: MENTORS }, async ({ hub, t }) => {
    const id = hub.createSlackQuestion({ question: 'Forwarded: should I use Postgres?', answer: 'Yes, Postgres.' });
    assert.deepEqual(t.pending(), []);
    const r = await runCli(['--resume', id], t).done;
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, `ANSWER from jose (your mentor, ${id}):\nYes, Postgres.\n`);
    assert.match(r.stderr, /not saved on this machine; fetched from the hub/);
    assert.equal(hub.get(id).status, 'delivered');
    assert.deepEqual(hub.state.receiptBodies, [{ delivered_via: 'cli' }]);
  }));

test('MCP ask_resume with an id that only the hub knows', () =>
  withHub({ mentors: MENTORS }, async ({ hub, t }) => {
    const id = hub.createSlackQuestion({ question: 'From Slack', answer: 'Do it.' });
    const client = new Client({ name: 't', version: '0' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, 'mcp'], env: t.env, cwd: t.cwd, stderr: 'pipe' }));
    try {
      const r = await client.callTool({ name: 'ask_resume', arguments: { id, wait_seconds: 5 } });
      assert.match(/** @type {any[]} */ (r.content)[0].text, new RegExp(`^ANSWER from jose \\(your mentor, ${id}\\):\\nDo it\\.`));
      await hub.waitForStatus(id, 'delivered');
    } finally {
      await client.close();
    }
  }));

test('no-id resume order: local pending first, then the oldest answered-undelivered on the hub, then the oldest pending', () =>
  withHub({ mentors: MENTORS }, async ({ hub, t }) => {
    // Hub-only questions: one old pending, two answered (Slack older than ask).
    const oldPending = hub.createSlackQuestion({ question: 'oldest, still pending', created_at: '2026-11-16T08:00:00Z' });
    const slackAnswered = hub.createSlackQuestion({ question: 'slack, answered', created_at: '2026-11-16T09:00:00Z', answer: 'From Slack.' });
    const laterAnswered = hub.createSlackQuestion({ question: 'later, answered', created_at: '2026-11-16T10:00:00Z', answer: 'Later.' });
    // 1. A local pending entry wins.
    const r1 = await runCli(['local one?', ...UNREGISTERED, '--timeout', '1'], t).done;
    assert.equal(r1.code, 3);
    const localId = t.pending()[0].id;
    hub.answer(localId, 'Local.');
    const a = await runCli(['--resume'], t).done;
    assert.equal(a.code, 0, a.stderr);
    assert.match(a.stdout, new RegExp(`${localId}\\):\\nLocal\\.`));
    assert.match(a.stderr, /the most recent question saved on this machine/);
    // 2. Nothing local: oldest answered-undelivered, whatever its source.
    const b = await runCli(['--resume'], t).done;
    assert.equal(b.code, 0, b.stderr);
    assert.match(b.stdout, new RegExp(`${slackAnswered}\\):\\nFrom Slack\\.`));
    assert.match(b.stderr, new RegExp(`Resuming ${slackAnswered} \\(your oldest answered question not yet delivered \\(started from Slack\\)\\)`));
    const c = await runCli(['--resume'], t).done;
    assert.match(c.stdout, new RegExp(`${laterAnswered}\\):\\nLater\\.`));
    // 3. Nothing answered: the oldest pending.
    const d = await runCli(['--resume', '--timeout', '1'], t).done;
    assert.equal(d.code, 3);
    assert.match(d.stderr, new RegExp(`Resuming ${oldPending} \\(nothing answered is waiting; your oldest pending question`));
  }));

test('--list shows source and route when the hub provides them; project "-" instead of null', () =>
  withHub({ mentors: MENTORS }, async ({ hub, t }) => {
    hub.createSlackQuestion({ question: 'from slack', created_at: '2026-11-01T08:00:00Z' });
    await runCli(['from ask?', '--repo', 'drunkencoders-hq/sandbox', '--timeout', '1'], t).done;
    const r = await runCli(['--list'], t).done;
    assert.equal(r.code, 0, r.stderr);
    const lines = r.stdout.trim().split('\n').map((l) => l.split('\t'));
    assert.deepEqual(lines.map((l) => l.slice(1, 5)), [
      ['posted', 'sandbox', 'ask', 'mentor'],
      ['posted', '-', 'slack', 'mentor'],
    ]);
    assert.doesNotMatch(r.stdout, /null/);
  }));

test('--list against an older hub keeps the brief 02 columns', () =>
  withHub({ legacy: true }, async ({ t }) => {
    await runCli(['first?', '--repo', 'drunkencoders-hq/sandbox', '--timeout', '1'], t).done;
    const r = await runCli(['--list'], t).done;
    assert.equal(r.stdout.split('\t').length, 5);
  }));

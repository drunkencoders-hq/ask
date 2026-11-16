// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startStubHub } from './stub-hub.js';
import { tempEnv, runCli, until } from './helpers.js';

const REPO = ['--repo', 'drunkencoders-hq/sandbox'];

/** @param {(ctx: { hub: Awaited<ReturnType<typeof startStubHub>>, t: ReturnType<typeof tempEnv> }) => Promise<void>} fn @param {any} [opts] */
async function withHub(fn, opts) {
  const hub = await startStubHub(opts);
  const t = tempEnv(hub.url);
  try {
    await fn({ hub, t });
  } finally {
    await hub.close();
    t.cleanup();
  }
}

test('happy path: answer on stdout, receipt recorded, pending entry removed', () =>
  withHub(async ({ hub, t }) => {
    const run = runCli(['Should the export be CSV or JSON?', ...REPO, '--branch', 'main'], t);
    const id = await hub.waitForQuestion();
    await until(() => t.pending().some((e) => e.id === id));
    await hub.waitForStatus(id, 'posted');
    hub.answer(id, 'JSON.\nKeep it line-delimited.');
    const r = await run.done;
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, `ANSWER from jose (project sandbox, ${id}):\nJSON.\nKeep it line-delimited.\n`);
    assert.match(r.stderr, new RegExp(`ask --resume ${id}`));
    assert.match(r.stderr, /Card: https:\/\//);
    assert.equal(hub.get(id).status, 'delivered');
    assert.deepEqual(hub.state.receiptBodies, [{ delivered_via: 'cli' }]);
    const body = hub.state.createBodies[0];
    assert.equal(body.repo, 'drunkencoders-hq/sandbox');
    assert.equal(body.branch, 'main');
    assert.equal(body.client.via, 'cli');
    assert.deepEqual(t.pending(), []);
  }));

test('--json prints one JSON object on stdout; context read from stdin', () =>
  withHub(
    async ({ hub, t }) => {
      const r = await runCli(['q?', ...REPO, '--json', '--context', '-'], { ...t, input: 'some context\n' }).done;
      assert.equal(r.code, 0, r.stderr);
      const out = JSON.parse(r.stdout);
      assert.equal(out.status, 'answered');
      assert.equal(out.answer.text, 'JSON, please.');
      assert.equal(hub.state.createBodies[0].context, 'some context\n');
    },
    { autoAnswerMs: 100 },
  ));

test('idempotent retry after a dropped POST response: one question, same client_request_id', () =>
  withHub(
    async ({ hub, t }) => {
      hub.state.dropNextCreateResponses = 1;
      const r = await runCli(['q?', ...REPO], t).done;
      assert.equal(r.code, 0, r.stderr);
      assert.equal(hub.state.questions.size, 1);
      assert.equal(hub.state.createBodies.length, 2);
      assert.equal(hub.state.createBodies[0].client_request_id, hub.state.createBodies[1].client_request_id);
      assert.match(r.stderr, /retrying/);
    },
    { autoAnswerMs: 200 },
  ));

test('--timeout → exit 3 with the resume command; --resume <id> then gets the answer', () =>
  withHub(async ({ hub, t }) => {
    const r1 = await runCli(['q?', ...REPO, '--timeout', '1'], t).done;
    assert.equal(r1.code, 3, r1.stderr);
    const id = [...hub.state.questions.keys()][0];
    assert.match(r1.stderr, new RegExp(`ask --resume ${id}`));
    assert.equal(r1.stdout, '');
    assert.equal(t.pending()[0].id, id);
    hub.answer(id, 'CSV.');
    const r2 = await runCli(['--resume', id], t).done;
    assert.equal(r2.code, 0, r2.stderr);
    assert.equal(r2.stdout, `ANSWER from jose (project sandbox, ${id}):\nCSV.\n`);
    assert.equal(hub.get(id).status, 'delivered');
    assert.deepEqual(t.pending(), []);
  }));

test('Ctrl-C mid-wait keeps the question; --resume with no id gets the answer', { skip: process.platform === 'win32' && 'SIGINT to a child is POSIX-only in this test' }, () =>
  withHub(async ({ hub, t }) => {
    const run = runCli(['q?', ...REPO], t);
    const id = await hub.waitForQuestion();
    await until(() => run.stderr().includes('Waiting'));
    run.child.kill('SIGINT');
    const r1 = await run.done;
    assert.equal(r1.code, 130, r1.stderr);
    assert.match(r1.stderr, new RegExp(`Interrupted.*${id}`, 's'));
    assert.equal(t.pending()[0].id, id);
    hub.answer(id, 'Go ahead.');
    const r2 = await runCli(['--resume'], t).done;
    assert.equal(r2.code, 0, r2.stderr);
    assert.match(r2.stdout, /Go ahead\./);
    assert.deepEqual(t.pending(), []);
  }));

test('--resume with no id re-sends a question whose POST never returned (same request id)', () =>
  withHub(async ({ hub, t }) => {
    hub.state.dropNextCreateResponses = 100; // every create response lost
    const r1 = await runCli(['q?', ...REPO], t).done;
    assert.equal(r1.code, 4, r1.stderr);
    assert.equal(hub.state.questions.size, 1);
    assert.equal(t.pending()[0].id, null);
    hub.state.dropNextCreateResponses = 0;
    const id = [...hub.state.questions.keys()][0];
    hub.answer(id, 'Yes.');
    const r2 = await runCli(['--resume'], t).done;
    assert.equal(r2.code, 0, r2.stderr);
    assert.equal(hub.state.questions.size, 1);
    assert.match(r2.stdout, /Yes\./);
  }));

test('receipt failure: answer printed, error on stderr, pending entry kept; --resume retries the receipt', () =>
  withHub(
    async ({ hub, t }) => {
      hub.state.failReceipts = 100;
      const r1 = await runCli(['q?', ...REPO], t).done;
      const id = [...hub.state.questions.keys()][0];
      assert.equal(r1.code, 4, r1.stderr);
      assert.match(r1.stdout, /JSON, please\./);
      assert.match(r1.stderr, /receipt could not be recorded/);
      assert.equal(hub.get(id).status, 'answered');
      assert.equal(t.pending()[0].id, id);
      assert.equal(t.pending()[0].receipt_failed, true);
      hub.state.failReceipts = 0;
      const r2 = await runCli(['--resume'], t).done;
      assert.equal(r2.code, 0, r2.stderr);
      assert.equal(hub.get(id).status, 'delivered');
      assert.deepEqual(t.pending(), []);
    },
    { autoAnswerMs: 50 },
  ));

for (const [code, setup, args] of /** @type {const} */ ([
  ['unknown_caller', (hub) => (hub.state.teammate = null), REPO],
  ['unknown_project', () => {}, ['--repo', 'drunkencoders-hq/nope']],
  ['no_owner_configured', (hub) => (hub.state.projects.sandbox.owner = null), REPO],
  ['chat_unavailable', (hub) => (hub.state.chatConnected = false), REPO],
])) {
  test(`refusal ${code} → exit 5 with the hub's message`, () =>
    withHub(async ({ hub, t }) => {
      setup(hub);
      const r = await runCli(['q?', ...args], t).done;
      assert.equal(r.code, 5, r.stderr);
      assert.match(r.stderr, new RegExp(code));
      // The hub's message text is shown verbatim.
      const msgs = {
        unknown_caller: 'This machine is not a known teammate on the tailnet.',
        unknown_project: 'No project is configured for drunkencoders-hq/nope.',
        no_owner_configured: 'Project sandbox has no owner configured; nobody can answer.',
        chat_unavailable: 'The hub is not connected to Slack right now.',
      };
      assert.ok(r.stderr.includes(msgs[code]), r.stderr);
      assert.equal(r.stdout, '');
      assert.deepEqual(t.pending(), [], 'a refused question leaves nothing to resume');
    }));
}

test('question failed on the hub → exit 6', () =>
  withHub(async ({ hub, t }) => {
    const run = runCli(['q?', ...REPO], t);
    const id = await hub.waitForQuestion();
    await hub.waitForStatus(id, 'posted');
    hub.fail(id, 'card could not be posted');
    const r = await run.done;
    assert.equal(r.code, 6, r.stderr);
    assert.match(r.stderr, /card could not be posted/);
  }));

test('missing hub address → exit 2 telling the user to run ask setup', async () => {
  const t = tempEnv(null);
  try {
    const r = await runCli(['x'], t).done;
    assert.equal(r.code, 2);
    assert.match(r.stderr, /ask setup/);
    assert.equal(r.stdout, '');
  } finally {
    t.cleanup();
  }
});

test('not in a git repo and no --repo/--project → exit 2', () =>
  withHub(async ({ hub, t }) => {
    const r = await runCli(['x'], t).done;
    assert.equal(r.code, 2);
    assert.match(r.stderr, /not in a git repository/);
    assert.equal(hub.state.questions.size, 0);
  }));

test('bad flags → exit 2; reserved subcommands → exit 64', () =>
  withHub(async ({ t }) => {
    assert.equal((await runCli(['x', '--bogus'], t).done).code, 2);
    assert.equal((await runCli(['x', '--timeout', 'soon', ...REPO], t).done).code, 2);
    for (const sub of ['setup', 'doctor', 'standby']) assert.equal((await runCli([sub], t).done).code, 64);
  }));

test('hub unreachable → exit 4', async () => {
  const t = tempEnv('http://127.0.0.1:9');
  try {
    const r = await runCli(['x', ...REPO], t).done;
    assert.equal(r.code, 4, r.stderr);
    assert.match(r.stderr, /unreachable/);
  } finally {
    t.cleanup();
  }
});

test('--list shows pending questions', () =>
  withHub(async ({ t }) => {
    await runCli(['first?', ...REPO, '--timeout', '1'], t).done;
    const r = await runCli(['--list'], t).done;
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /q_01STUB000001\tposted\tsandbox\t.*first\?/);
  }));

// @ts-check
// Brief 33 part B: `ask announce --summary` and `--attention` against the stub hub (contract change 13).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runCli, tempEnv } from './helpers.js';
import { startStubHub } from './stub-hub.js';

const FIVE = ['Shipped: brief 31', 'Building: brief 33', 'Needs you: nothing', 'Usage: weekly 40%', 'Codex: out until Friday'];

/** @param {(ctx: {hub: Awaited<ReturnType<typeof startStubHub>>, t: ReturnType<typeof tempEnv>, file: string}) => Promise<void>} fn @param {object} [opts] */
async function withHub(fn, opts = {}) {
  const hub = await startStubHub({ teammate: 'jose', ...opts });
  const t = tempEnv(hub.url);
  const file = path.join(t.dir, 'summary.txt');
  fs.writeFileSync(file, `${FIVE.join('\n')}\n`);
  try {
    await fn({ hub, t, file });
  } finally {
    await hub.close();
    t.cleanup();
  }
}

test('--summary --dry-run prints the DM text offline and sends nothing', async () => {
  await withHub(async ({ hub, t, file }) => {
    const noHub = { ...t, env: { ...t.env, ASK_HUB_URL: '' } };
    fs.writeFileSync(file, `\n${FIVE.join('\n\n')}\n\n`); // blank lines are ignored
    const r = await runCli(['announce', '--summary', '--file', file, '--day', '2026-11-16', '--dry-run'], noHub).done;
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, `*drunkbot evening summary, 2026-11-16*\n${FIVE.map((l) => `• ${l}`).join('\n')}\n`);
    assert.equal(hub.state.requests.length, 0);
  });
});

test('--summary sends once, a same-day repeat reuses the id, a new id for the same day is "already sent today"', async () => {
  await withHub(async ({ hub, t, file }) => {
    const args = ['announce', '--summary', '--file', file, '--day', '2026-11-16'];
    const first = await runCli(args, t).done;
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, /^sent: sm_\w+\n$/);
    assert.equal(hub.state.summaries.size, 1);
    const [only] = [...hub.state.summaries.values()];
    assert.deepEqual(only.lines, FIVE);
    assert.equal(only.to, 'jose');

    const again = await runCli(args, t).done; // same stored id → hub answers 200
    assert.equal(again.code, 0, again.stderr);
    assert.equal(again.stdout, 'already sent today\n');
    assert.equal(hub.state.summaries.size, 1);

    fs.rmSync(path.join(t.dir, 'state'), { recursive: true, force: true }); // id lost → hub 409
    const lost = await runCli(args, t).done;
    assert.equal(lost.code, 0, lost.stderr);
    assert.equal(lost.stdout, 'already sent today\n');
    assert.equal(hub.state.summaries.size, 1);

    const next = await runCli(['announce', '--summary', '--file', file, '--day', '2026-11-17'], t).done;
    assert.match(next.stdout, /^sent: /);
    assert.equal(hub.state.summaries.size, 2);
  });
});

test('--summary refuses locally: six lines, a long line, a secret, an empty file; nothing reaches the hub', async () => {
  await withHub(async ({ hub, t, file }) => {
    const args = ['announce', '--summary', '--file', file];
    for (const [content, message] of /** @type {[string, RegExp][]} */ ([
      [[...FIVE, 'sixth'].join('\n'), /1–5 non-blank lines \(it has 6\)/],
      ['a'.repeat(201), /line 1 is longer than 200/],
      ['ok\nkey xoxb-12345', /looks like it contains a secret/],
      ['token ghp_abcdef', /looks like it contains a secret/],
      ['clone https://user:pw@example.com/x.git', /looks like it contains a secret/],
      ['\n \n', /1–5 non-blank lines \(it has 0\)/],
    ])) {
      fs.writeFileSync(file, content);
      const r = await runCli(args, t).done;
      assert.equal(r.code, 2, r.stderr);
      assert.match(r.stderr, message);
      assert.doesNotMatch(r.stderr, /xoxb-12345|ghp_abcdef|user:pw/);
    }
    assert.equal(hub.state.requests.length, 0);
  });
});

test('--summary and --attention reject flags from other modes', async () => {
  await withHub(async ({ hub, t, file }) => {
    for (const extra of [['--to', 'nora'], ['--ask-version', '0.4.0'], ['--update-command', 'x'], ['--mention', 'nora'], ['--list'], ['--template']]) {
      const r = await runCli(['announce', '--summary', '--file', file, ...extra], t).done;
      assert.equal(r.code, 2, `${extra[0]}: ${r.stderr}`);
      assert.match(r.stderr, /cannot be combined/);
    }
    for (const args of [['--summary', '--attention'], ['--attention', '--to', 'nora'], ['--attention', '--file', file], ['--summary', '--file', file, '--day', 'yesterday'], ['--summary']]) {
      const r = await runCli(['announce', ...args], t).done;
      assert.equal(r.code, 2, `${args.join(' ')}: ${r.stderr}`);
    }
    assert.equal((await runCli(['announce', '--list', '--day', '2026-11-16'], t).done).code, 2);
    assert.equal(hub.state.requests.length, 0);
  });
});

test('--summary: a non-announcer gets one hub-error line and exits non-zero', async () => {
  await withHub(async ({ hub, t, file }) => {
    hub.state.teammate = 'nora';
    const r = await runCli(['announce', '--summary', '--file', file], t).done;
    assert.equal(r.code, 5, r.stderr);
    assert.match(r.stderr.trim(), /^ask: hub error \(not_announcer\): [^\n]+$/);
    assert.equal(hub.state.summaries.size, 0);
  });
});

test('--summary: Slack down exits non-zero with the reason; a pending row is reported and finished by repeating', async () => {
  await withHub(async ({ hub, t, file }) => {
    const args = ['announce', '--summary', '--file', file, '--day', '2026-11-16'];
    hub.state.chatDown = true;
    const down = await runCli(args, t).done;
    assert.equal(down.code, 5, down.stderr);
    assert.match(down.stderr, /chat_unavailable/);

    hub.state.chatDown = false;
    hub.state.summaryPending = true;
    const pending = await runCli(args, t).done;
    assert.equal(pending.code, 4, pending.stderr);
    assert.match(pending.stdout, /^pending: sm_\w+ /);
  });
});

test('--summary --json prints the hub body; a repeat prints the same body', async () => {
  await withHub(async ({ hub, t, file }) => {
    const args = ['announce', '--summary', '--file', file, '--day', '2026-11-16', '--json'];
    const r = await runCli(args, t).done;
    assert.equal(r.code, 0, r.stderr);
    const body = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(body).sort(), ['day', 'id', 'status']);
    assert.deepEqual(JSON.parse((await runCli(args, t).done).stdout), body);
  });
});

test('--attention prints one line per fact, "nothing waiting", or the hub body with --json; a non-announcer is refused', async () => {
  const attention = {
    questions_waiting: { count: 2, items: [{ id: 'q_1', asker: 'nora', age_minutes: 190 }, { id: 'q_2', asker: 'grish', age_minutes: 12 }] },
    unconfirmed_notices: { count: 1, items: [{ id: 'nt_1', title: 'ask 0.4.0', to: ['nora'], age_hours: 27, behind: ['nora'] }] },
  };
  await withHub(async ({ hub, t }) => {
    const r = await runCli(['announce', '--attention'], t).done;
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, '2 questions waiting (oldest 3h)\n1 notice not confirmed after 24h: ask 0.4.0 (nora)\n');
    const j = await runCli(['announce', '--attention', '--json'], t).done;
    const body = JSON.parse(j.stdout);
    assert.deepEqual({ ...body, generated_at: undefined }, { ...attention, generated_at: undefined });
    hub.state.teammate = 'nora';
    const refused = await runCli(['announce', '--attention'], t).done;
    assert.equal(refused.code, 5);
    assert.match(refused.stderr.trim(), /^ask: hub error \(not_announcer\): [^\n]+$/);
  }, { attention });
  await withHub(async ({ t }) => {
    const r = await runCli(['announce', '--attention'], t).done;
    assert.equal(r.stdout, 'nothing waiting\n');
  });
});

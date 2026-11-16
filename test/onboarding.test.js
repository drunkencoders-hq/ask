// @ts-check
// Hands-free onboarding (brief 04b): `ask setup --hub … --token …` run as a
// real process against the stub hub's contract change 4, with stub gh,
// tailscale, open and assistant CLIs first on PATH and a throwaway HOME.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startStubHub } from './stub-hub.js';
import { tempEnv, runCli } from './helpers.js';
import { writeStubBin } from './fixtures/stub-bin.js';
import { STEPS } from '../src/setup/onboarding.js';

const TOKEN = 'tok_TEST_7f3a9c1e5b2d4f60a8c7e9b1d3f5a7c9';
const SHARE = 'https://login.tailscale.com/admin/invite/STUBSHARE';

/** @param {{ hub: any, env?: Record<string,string>, stateDir?: string }} o */
function env(o) {
  const t = tempEnv(null);
  const home = path.join(t.dir, 'home');
  fs.mkdirSync(home);
  const stubBin = writeStubBin(path.join(t.dir, 'stubs'), ['tailscale', 'gh', 'claude', 'open']);
  const nodeBin = path.join(t.dir, 'nodebin');
  fs.mkdirSync(nodeBin);
  fs.symlinkSync(process.execPath, path.join(nodeBin, 'node'));
  const stateDir = o.stateDir ?? path.join(t.dir, 'stubstate');
  fs.mkdirSync(stateDir, { recursive: true });
  Object.assign(t.env, {
    HOME: home,
    PATH: [stubBin, nodeBin, '/usr/bin', '/bin'].join(path.delimiter),
    STUB_LOG: path.join(t.dir, 'stub.log'),
    STUB_STATE_DIR: stateDir,
    STUB_SHARE_URL: SHARE,
    ASK_ONBOARDING_POLL_MS: '100',
    ASK_ONBOARDING_HUB_WAIT_SEC: '20',
    ASK_ONBOARDING_SIGNIN_WAIT_SEC: '20',
    ASK_ONBOARDING_STATUS_WAIT: '1',
    ASK_READY_RETRY_SEC: '5',
    ASK_FIRST_QUESTION_WAIT_SEC: '5',
    ...(o.env ?? {}),
  });
  delete t.env.CODEX_HOME;
  delete t.env.ASK_ONBOARDING_TOKEN;
  return {
    ...t,
    home,
    stateDir,
    configFile: path.join(t.env.XDG_CONFIG_HOME, 'drunkencoders', 'ask.json'),
    log: () => (fs.existsSync(t.env.STUB_LOG) ? fs.readFileSync(t.env.STUB_LOG, 'utf8') : ''),
  };
}

/** Every file under dir (recursively), concatenated. */
function allText(dir) {
  let out = '';
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out += `\n--- ${p}\n` + fs.readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return out;
}

/** @param {any} hub */
const steps = (hub) => hub.state.onboarding.progress.map((p) => `${p.step}:${p.status}`);

test('onboarding: nothing signed in, hub behind a share → registered after approval, standby, ready, first question answered', async () => {
  let shareAccepted = () => false;
  const hub = await startStubHub({
    teammate: null,
    autoAnswerMs: 150,
    autoAnswerText: 'Yes, I can see it. Welcome!',
    reachable: () => shareAccepted(),
    onboarding: { token: TOKEN, displayName: 'Nora', teammate: 'nora', mentor: 'jose', decision: 'register', decideAfterMs: 300 },
  });
  const t = env({ hub, env: { STUB_GH: 'signed_out', STUB_TS_STATE: 'error' } });
  shareAccepted = () => fs.existsSync(path.join(t.stateDir, 'share_accepted'));
  // Steps the bootstrap script already did, as it hands them over.
  const queue = path.join(t.dir, 'queue.tsv');
  const now = Math.floor(Date.now() / 1000);
  fs.writeFileSync(queue, ['homebrew', 'git', 'node', 'gh', 'tailscale', 'ask', 'assistant'].flatMap((s, i) => [`${now + i}\t${s}\tstarted\t`, `${now + i}\t${s}\tdone\tinstalled`]).join('\n') + '\n');
  try {
    const r = await runCli(['setup', '--hub', hub.url], { ...t, env: { ...t.env, ASK_ONBOARDING_TOKEN: TOKEN, ASK_ONBOARDING_SHARE: SHARE, ASK_ONBOARDING_QUEUE: queue } }).done;
    assert.equal(r.code, 0, r.stderr);
    // 15 steps, each reported once with its final status (pre-hub ones collapsed), in the fixed order.
    const finals = new Map();
    for (const p of hub.state.onboarding.progress) finals.set(p.step, p.status);
    assert.deepEqual([...finals.keys()], STEPS);
    assert.equal(finals.get('ready'), 'done');
    for (const s of ['homebrew', 'github-sign-in', 'tailscale-sign-in', 'hub-reached', 'identity', 'registered', 'mcp', 'standby']) assert.equal(finals.get(s), 'done', s);
    // Queued reports carry their real time.
    assert.match(hub.state.onboarding.progress[0].note, /^at \d\d:\d\d:\d\d; installed$/);
    assert.ok(hub.state.onboarding.posts.some((l) => /is ready\. Tap the headphones/.test(l)));
    // Identity report: GitHub login from gh, the detected assistant, nothing else.
    assert.deepEqual(Object.keys(hub.state.onboarding.identity).sort(), ['github_login', 'host', 'os', 'tools']);
    assert.equal(hub.state.onboarding.identity.github_login, 'nora-gh');
    assert.deepEqual(hub.state.onboarding.identity.tools, ['claude-code']);
    // Browser pages opened by setup, the share exactly once; gh ran without a terminal.
    const log = t.log();
    assert.match(log, /^open https:\/\/github\.com\/login\/device$/m);
    assert.match(log, /^open https:\/\/login\.tailscale\.com\/a\/stub0123$/m);
    assert.equal((log.match(new RegExp(`^open ${SHARE.replace(/[/.]/g, '\\$&')}$`, 'gm')) ?? []).length, 1);
    assert.match(log, /^gh auth login --web --git-protocol https --hostname github\.com --clipboard$/m);
    assert.match(r.stderr, /^>>> Your GitHub one-time code: ABCD-1234 /m);
    assert.match(r.stderr, /Waiting for Jose to confirm in Slack…/);
    assert.equal(hub.state.onboarding.progress.some((p) => (p.note ?? '').includes('ABCD-1234')), false, 'code not in a report');
    // The normal setup ran after registration: config, MCP, standby.
    assert.deepEqual(JSON.parse(fs.readFileSync(t.configFile, 'utf8')), { hub_url: hub.url });
    assert.match(r.stdout, new RegExp(`^Standby verified: nora via ${hub.url.replace(/[/.:]/g, '\\$&')}$`, 'm'));
    assert.equal(hub.state.statusPosts.length, 1);
    // First question: no repo, fixed text, answered and delivered.
    const first = hub.state.createBodies.find((b) => b.kind === 'question');
    assert.match(first.question, /^Set-up test from .+: this is my first question through `ask`\. Can you see it\?$/);
    assert.equal(first.repo, undefined);
    assert.match(r.stdout, /ANSWER from jose \(your mentor, q_\w+\):\nYes, I can see it\. Welcome!/);
    assert.deepEqual(t.pending(), []);
    // The queue file is gone, and the token is nowhere: files, output, child processes' arguments.
    assert.equal(fs.existsSync(queue), false);
    const everything = allText(t.dir) + r.stdout + r.stderr;
    assert.equal(everything.includes(TOKEN), false, 'token leaked');
    assert.equal(everything.includes(TOKEN.slice(4, 20)), false, 'token fragment leaked');
  } finally {
    await hub.close();
    t.cleanup();
  }
});

test('onboarding: everything already signed in and the hub reachable → sign-in steps skipped, still registered and ready', async () => {
  const hub = await startStubHub({ teammate: null, autoAnswerMs: 100, onboarding: { token: TOKEN } });
  const t = env({ hub });
  try {
    const r = await runCli(['setup', '--hub', hub.url, '--token', TOKEN, '--no-first-question'], t).done;
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(steps(hub), [
      'github-sign-in:skipped', 'tailscale-sign-in:skipped', 'hub-reached:done', 'identity:started', 'identity:done',
      'registered:started', 'registered:done', 'mcp:started', 'mcp:done', 'standby:started', 'standby:done', 'ready:done',
    ]);
    assert.doesNotMatch(t.log(), /^open /m, 'no browser opened');
    assert.equal(hub.state.createBodies.filter((b) => b.kind === 'question').length, 0, '--no-first-question');
  } finally {
    await hub.close();
    t.cleanup();
  }
});

test('onboarding: registration refused → exit 5, nothing set up locally', async () => {
  const hub = await startStubHub({ teammate: null, onboarding: { token: TOKEN, decision: 'refuse', decideAfterMs: 200 } });
  const t = env({ hub });
  try {
    const r = await runCli(['setup', '--hub', hub.url], { ...t, env: { ...t.env, ASK_ONBOARDING_TOKEN: TOKEN } }).done;
    assert.equal(r.code, 5, r.stderr);
    assert.match(r.stderr, /Waiting for Jose to confirm in Slack…/);
    assert.match(r.stderr, /ask setup: FAILED: your registration was refused in Slack by Jose\. Nothing was set up on this Mac/);
    assert.equal(fs.existsSync(t.configFile), false, 'no config written');
    assert.equal(fs.existsSync(path.join(t.home, '.claude.json')), false, 'no MCP registration');
    assert.doesNotMatch(r.stderr + r.stdout, new RegExp(TOKEN));
  } finally {
    await hub.close();
    t.cleanup();
  }
});

test('onboarding: token expires while waiting for the tap → exit 5, message names /onboard', async () => {
  const hub = await startStubHub({ teammate: null, onboarding: { token: TOKEN, decision: 'expire', decideAfterMs: 300 } });
  const t = env({ hub });
  try {
    const r = await runCli(['setup', '--hub', hub.url, '--token', TOKEN], t).done;
    assert.equal(r.code, 5, r.stderr);
    assert.match(r.stderr, /no longer valid/);
    assert.match(r.stderr, /\/onboard @you/);
    assert.equal(fs.existsSync(t.configFile), false);
  } finally {
    await hub.close();
    t.cleanup();
  }
});

test('onboarding: hub never reachable → exit 4 after the cut, share opened once, queue file removed', async () => {
  const hub = await startStubHub({ teammate: null, reachable: () => false, onboarding: { token: TOKEN } });
  const t = env({ hub, env: { ASK_ONBOARDING_HUB_WAIT_SEC: '2' } });
  const queue = path.join(t.dir, 'queue.tsv');
  fs.writeFileSync(queue, `${Math.floor(Date.now() / 1000)}\thomebrew\tskipped\talready installed\n`);
  try {
    const r = await runCli(['setup', '--hub', hub.url, '--token', TOKEN, '--share', SHARE], { ...t, env: { ...t.env, ASK_ONBOARDING_QUEUE: queue } }).done;
    assert.equal(r.code, 4, r.stderr);
    assert.match(r.stderr, /was not reachable for 2 seconds\. Check that Tailscale is on and that you accepted the share link/);
    assert.match(r.stderr, /paste the same command again/);
    assert.equal((t.log().match(/^open https:\/\/login\.tailscale\.com\/admin\/invite/gm) ?? []).length, 1);
    assert.equal(fs.existsSync(queue), false);
    assert.equal(hub.state.onboarding.progress.length, 0);
  } finally {
    await hub.close();
    t.cleanup();
  }
});

test('onboarding: progress reports failing → set-up still completes; ready retried until accepted', async () => {
  const hub = await startStubHub({ teammate: null, autoAnswerMs: 100, onboarding: { token: TOKEN, failProgress: 12 } });
  const t = env({ hub });
  try {
    const r = await runCli(['setup', '--hub', hub.url, '--token', TOKEN, '--no-first-question'], t).done;
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /progress report "[a-z-]+: \w+" not sent/);
    assert.match(r.stderr, /progress report\(s\) could not be sent; nothing else is affected/);
    assert.equal(steps(hub).at(-1), 'ready:done');
  } finally {
    await hub.close();
    t.cleanup();
  }
});

for (const dead of [false, true]) {
  test(`onboarding: command pasted again after registration${dead ? ', token already dead' : ''} → whoami known, onboarding routes not called, set-up completes`, async () => {
    const hub = await startStubHub({ teammate: null, onboarding: { token: TOKEN, registered: true, tokenDead: dead } });
    const t = env({ hub });
    try {
      const r = await runCli(['setup', '--hub', hub.url, '--token', TOKEN, '--no-first-question'], t).done;
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stderr, /it already knows you as nora, so registration is skipped/);
      for (const route of ['hello', 'identity', 'status']) assert.equal(hub.state.calls[`POST /v1/onboarding/${route}`] ?? 0, 0, route);
      assert.match(r.stdout, /^Standby verified: nora via /m);
      if (dead) {
        assert.equal((r.stderr.match(/no longer accepts progress reports/g) ?? []).length, 1, 'one printed line for the dropped reports');
        assert.match(r.stderr, /The hub did not accept the "ready" report \(the set-up command is no longer valid\)/);
        assert.equal(hub.state.onboarding.progress.length, 0);
      } else {
        assert.equal(steps(hub).at(-1), 'ready:done');
      }
    } finally {
      await hub.close();
      t.cleanup();
    }
  });
}

test('onboarding: 429 with Retry-After on hello, identity, status and progress → waits, then completes', async () => {
  const hub = await startStubHub({ teammate: null, onboarding: { token: TOKEN, retryAfterSec: 1, throttle: { hello: 1, identity: 1, status: 1, progress: 2 } } });
  const t = env({ hub });
  try {
    const t0 = Date.now();
    const r = await runCli(['setup', '--hub', hub.url, '--token', TOKEN, '--no-first-question'], t).done;
    assert.equal(r.code, 0, r.stderr);
    assert.ok(Date.now() - t0 >= 4000, 'waited for Retry-After each time');
    assert.deepEqual(hub.state.onboarding.throttled.sort(), ['hello', 'identity', 'progress', 'progress', 'status']);
    assert.doesNotMatch(r.stderr, /not sent/, 'no report lost to a 429');
    assert.equal(steps(hub).at(-1), 'ready:done');
  } finally {
    await hub.close();
    t.cleanup();
  }
});

test('onboarding: no approver name from the hub → generic waiting line', async () => {
  const hub = await startStubHub({ teammate: null, onboarding: { token: TOKEN, approver: null } });
  const t = env({ hub });
  try {
    const r = await runCli(['setup', '--hub', hub.url, '--token', TOKEN, '--no-first-question'], t).done;
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /Waiting for your registration to be confirmed in Slack…/);
  } finally {
    await hub.close();
    t.cleanup();
  }
});

test('onboarding: a teammate without a mentor → first question refused by the hub, set-up still exit 0', async () => {
  const hub = await startStubHub({ teammate: null, onboarding: { token: TOKEN, mentor: null } });
  const t = env({ hub });
  try {
    const r = await runCli(['setup', '--hub', hub.url, '--token', TOKEN], t).done;
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /The first test question was not sent \(invalid_request\)/);
    assert.deepEqual(t.pending(), []);
  } finally {
    await hub.close();
    t.cleanup();
  }
});

test('onboarding: first question unanswered in time → exit 0, points to ask --resume', async () => {
  const hub = await startStubHub({ teammate: null, onboarding: { token: TOKEN } });
  const t = env({ hub, env: { ASK_FIRST_QUESTION_WAIT_SEC: '1' } });
  try {
    const r = await runCli(['setup', '--hub', hub.url, '--token', TOKEN], t).done;
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /No answer yet\. It will be there with: ask --resume q_\w+/);
    assert.equal(t.pending().length, 1);
  } finally {
    await hub.close();
    t.cleanup();
  }
});

// @ts-check
// Hands-free onboarding (brief 04b; hub contract change 4, brief 08a §C/§D/§F).
// `ask setup --hub <url> --token <t> [--share <url>]`: GitHub and Tailscale
// sign-in in the browser, wait for the hub, report identity, wait for the
// approver's tap, then the normal setup (config, MCP, standby), `ready`, and a
// first real question. Progress is reported per step; steps before the hub is
// reachable are queued and sent in order once `hello` succeeds.
//
// The token lives in memory only: never written, logged, printed or passed to
// a child process.
import os from 'node:os';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { HubError, HubUnreachable, VERSION, createClient, submitQuestion, sendReceipt, formatAnswer } from '../client.js';
import { PendingStore, pendingFilePath } from '../pending.js';
import { locateTailscale, tailscaleEnv, tailscaleStatus } from './tailscale.js';
import { checkGh } from './checks.js';
import { ASSISTANTS } from './assistants/index.js';

/** Exit codes, as ask uses them everywhere: 4 hub unreachable, 5 refused. */
export const EXIT_UNREACHABLE = 4;
export const EXIT_REFUSED = 5;

/** The fixed step ids (brief 04b §4), in order. */
export const STEPS = [
  'homebrew', 'git', 'node', 'gh', 'tailscale', 'ask', 'assistant',
  'github-sign-in', 'tailscale-sign-in', 'hub-reached', 'identity', 'registered', 'mcp', 'standby', 'ready',
];

const NEW_COMMAND = 'Ask Jose (or the lead) for a new set-up command: they type /onboard @you in Slack. Then paste the new command; it is safe to repeat.';

export class OnboardingStop extends Error {
  /** @param {string} message @param {number} code */
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** @param {Record<string, string|undefined>} env @param {string} name @param {number} dflt */
function knob(env, name, dflt) {
  const v = Number(env[name]);
  return Number.isFinite(v) && v >= 0 && env[name] !== '' && env[name] !== undefined ? v : dflt;
}

/** @param {Date} d */
const hhmmss = (d) => d.toTimeString().slice(0, 8);

/**
 * HTTP for the four onboarding routes. The token travels in the JSON body only.
 * @param {string} hubUrl @param {string} token
 */
export function onboardingClient(hubUrl, token) {
  const base = hubUrl.replace(/\/+$/, '');
  /** @param {string} route @param {Record<string, any>} body @param {number} [timeoutMs] */
  return async function post(route, body, timeoutMs = 15_000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${base}/v1/onboarding/${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ ...body, token }),
        signal: ctrl.signal,
      });
      const text = await res.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {}
      if (res.ok && data) return data;
      const err = data?.error;
      if (err && typeof err.code === 'string' && (res.status < 500 || err.code === 'chat_unavailable')) {
        throw new HubError(res.status, err.code, String(err.message ?? err.code));
      }
      throw new HubUnreachable(`hub answered ${res.status} on ${route}`);
    } catch (e) {
      if (e instanceof HubError || e instanceof HubUnreachable) throw e;
      const cause = /** @type {any} */ (e).cause;
      throw new HubUnreachable(`cannot reach hub at ${base}: ${cause?.code || cause?.message || /** @type {Error} */ (e).message}`);
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Progress reports (decision 80). Before the hub is reachable they are queued
 * in memory, each with its real time; `goLive` sends them in order (the last
 * status per step, to stay well inside the hub's per-token rate limit). A
 * failed report is printed and never fails the set-up.
 */
export class Reporter {
  /** @param {import('./sys.js').Sys} sys */
  constructor(sys) {
    this.sys = sys;
    /** @type {{ step: string, status: string, note?: string, at: Date }[]} */
    this.queue = [];
    /** @type {null | ((route: string, body: any, t?: number) => Promise<any>)} */
    this.post = null;
    this.sent = 0;
    this.failed = 0;
  }

  /** Steps the bootstrap script already did: lines "epoch<TAB>step<TAB>status<TAB>note". @param {string|undefined} file */
  loadQueueFile(file) {
    if (!file) return;
    let text = '';
    try {
      text = this.sys.fs.readFileSync(file, 'utf8');
    } catch {
      return;
    }
    for (const line of text.split('\n')) {
      const [epoch, step, status, ...note] = line.split('\t');
      if (!step || !STEPS.includes(step) || !['started', 'done', 'blocked', 'skipped'].includes(status)) continue;
      const at = new Date(Number(epoch) * 1000);
      this.queue.push({ step, status, note: note.join(' ').trim() || undefined, at: Number.isNaN(at.getTime()) ? this.sys.now() : at });
    }
  }

  /** @param {string} step @param {'started'|'done'|'blocked'|'skipped'} status @param {string} [note] */
  async report(step, status, note) {
    const item = { step, status, note, at: this.sys.now() };
    if (!this.post) {
      this.queue.push(item);
      return true;
    }
    return this.send(item);
  }

  /** @param {{ step: string, status: string, note?: string, at: Date }} item @param {boolean} [queued] */
  async send(item, queued = false) {
    if (!this.post) return false;
    const note = (queued ? `at ${hhmmss(item.at)}${item.note ? `; ${item.note}` : ''}` : (item.note ?? '')).slice(0, 300);
    const body = { step: item.step, status: item.status, client_request_id: randomUUID(), ...(note ? { note } : {}) };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.post('progress', body, 10_000);
        this.sent += 1;
        return true;
      } catch (e) {
        if (e instanceof HubError && e.code !== 'rate_limited' && e.code !== 'chat_unavailable') {
          this.failed += 1;
          this.sys.err(`(progress report "${item.step}: ${item.status}" not sent: ${e.code}; carrying on)`);
          return false;
        }
        if (attempt === 0) await sleep(1000);
        else {
          this.failed += 1;
          this.sys.err(`(progress report "${item.step}: ${item.status}" not sent: ${/** @type {Error} */ (e).message}; carrying on)`);
        }
      }
    }
    return false;
  }

  /** The hub answered `hello`: send what is queued, in order. @param {(route: string, body: any, t?: number) => Promise<any>} post */
  async goLive(post) {
    this.post = post;
    /** @type {Map<string, { step: string, status: string, note?: string, at: Date }>} */
    const last = new Map();
    for (const item of this.queue) {
      last.delete(item.step); // keep first-appearance order of the last status
      last.set(item.step, item);
    }
    const ordered = [...last.values()].sort((a, b) => STEPS.indexOf(a.step) - STEPS.indexOf(b.step));
    this.queue = [];
    for (const item of ordered) await this.send(item, true);
  }

  /**
   * `ready` is the one report that must arrive: retry until `retrySec`.
   * @param {number} retrySec
   */
  async mustSend(step, status, note, retrySec) {
    const deadline = Date.now() + retrySec * 1000;
    const body = { step, status, client_request_id: randomUUID(), ...(note ? { note } : {}) };
    let lastErr = '';
    while (this.post) {
      try {
        await this.post('progress', body, 10_000);
        this.sent += 1;
        return true;
      } catch (e) {
        lastErr = e instanceof HubError ? e.code : /** @type {Error} */ (e).message;
      }
      if (Date.now() >= deadline) break;
      await sleep(Math.min(5000, Math.max(200, deadline - Date.now())));
    }
    this.sys.err(`The hub did not accept the "${step}" report (${lastErr || 'hub not reached'}).`);
    return false;
  }
}

/**
 * Sign in to GitHub in the browser without any typed answer: gh runs without
 * a terminal (no "Press Enter", no git-credential question), copies the
 * one-time code to the clipboard, and we open the device page ourselves.
 * @param {import('./sys.js').Sys} sys @param {number} waitSec
 */
async function githubWebLogin(sys, waitSec) {
  sys.err('Signing in to GitHub: your browser will open github.com/login/device.');
  sys.err('Paste the one-time code shown below (it is already on your clipboard), then approve.');
  let opened = false;
  const r = await sys.runTee('gh', ['auth', 'login', '--web', '--git-protocol', 'https', '--hostname', 'github.com', '--clipboard'], {
    timeoutMs: waitSec * 1000,
    onLine: (line) => {
      const m = /(https:\/\/github\.com\/login\/device\S*)/.exec(line);
      if (m && !opened) {
        opened = true;
        sys.openUrl(m[1]).then((ok) => {
          if (!ok) sys.err(`Open ${m[1]} in your browser.`);
        });
      }
    },
  });
  if (r.code === 0) await sys.run('gh', ['auth', 'setup-git', '--hostname', 'github.com'], { timeoutMs: 30_000 });
  return r.code === 0;
}

/** @param {import('./sys.js').Sys} sys */
async function githubLogin(sys) {
  const r = await sys.run('gh', ['api', 'user', '--jq', '.login'], { timeoutMs: 20_000 });
  const login = r.stdout.trim();
  return r.code === 0 && /^[A-Za-z0-9-]{1,39}$/.test(login) ? login : null;
}

/**
 * Tailscale signed in: start the app (macOS), run `tailscale login` without a
 * terminal and open the sign-in page it prints, then wait for Running.
 * @param {import('./sys.js').Sys} sys @param {number} waitSec @param {number} pollMs
 */
async function tailscaleSignIn(sys, waitSec, pollMs) {
  let bin = locateTailscale(sys);
  if (!bin && sys.platform === 'darwin') {
    await sys.run('open', ['-a', 'Tailscale'], { timeoutMs: 15_000 });
    bin = locateTailscale(sys);
  }
  if (!bin) throw new OnboardingStop('Tailscale is not installed. Paste the set-up command again; it installs what is missing.', 1);
  let ts = await tailscaleStatus(sys, bin);
  if (ts.state === 'running') return { ts, already: true };
  if (sys.platform === 'darwin' && ts.state === 'error') {
    // The app is not running yet.
    sys.err('Starting the Tailscale app. If macOS asks to allow a VPN configuration or a system extension, allow it.');
    await sys.run('open', ['-a', 'Tailscale'], { timeoutMs: 15_000 });
    for (let i = 0; i < 15 && ts.state === 'error'; i++) {
      await sleep(Math.min(pollMs, 2000));
      ts = await tailscaleStatus(sys, bin);
    }
  }
  const how = sys.platform === 'win32' ? 'click the Tailscale icon in the taskbar tray and choose "Log in"' : 'click the Tailscale icon in the menu bar and choose "Log in"';
  const deadline = Date.now() + waitSec * 1000;
  if (ts.state !== 'running') {
    sys.err('Signing in to Tailscale: your browser will open the Tailscale sign-in page.');
    let opened = false;
    const login = sys.runTee(bin, ['login'], {
      timeoutMs: waitSec * 1000,
      env: tailscaleEnv(sys),
      onLine: (line) => {
        const m = /(https:\/\/login\.tailscale\.com\/\S+)/.exec(line);
        if (m && !opened) {
          opened = true;
          sys.openUrl(m[1]);
        }
      },
    });
    let loginDone = false;
    login.then(() => (loginDone = true));
    let lastNote = 0;
    for (;;) {
      ts = await tailscaleStatus(sys, bin);
      if (ts.state === 'running') break;
      if (Date.now() >= deadline) {
        throw new OnboardingStop(`Tailscale is still not signed in after ${Math.round(waitSec / 60)} minutes (${ts.detail}). Sign in: ${how}. Then paste the same command again.`, EXIT_UNREACHABLE);
      }
      if (Date.now() - lastNote > 60_000) {
        lastNote = Date.now();
        sys.err(`waiting for the Tailscale sign-in in your browser… (or ${how})`);
      }
      await sleep(pollMs);
    }
    if (!loginDone) await Promise.race([login, sleep(2000)]);
  }
  return { ts, already: false };
}

/** The teammate name the hub knows this machine as, or null. @param {string} hubUrl */
async function knownAs(hubUrl) {
  const who = await createClient({ hubUrl, via: 'cli', retryDelaysMs: [500] }).whoami().catch(() => null);
  return who?.teammate ?? null;
}

/** Assistants installed on this machine (ids), for the identity report. @param {import('./sys.js').Sys} sys */
export function detectedAssistants(sys) {
  const ids = [];
  for (const a of ASSISTANTS) {
    try {
      if (a.detect(sys)) ids.push(a.id);
    } catch {}
  }
  return ids;
}

/**
 * @param {import('./sys.js').Sys} sys
 * @param {{
 *   hubUrl: string, token: string, share?: string, firstQuestion: boolean,
 *   queueFile?: string,
 *   finishSetup: (report: Reporter) => Promise<number>,   // config, MCP, standby (shared with plain setup)
 * }} o
 * @returns {Promise<number>}
 */
export async function runOnboarding(sys, o) {
  const env = sys.env;
  const pollMs = knob(env, 'ASK_ONBOARDING_POLL_MS', 5000);
  const hubWaitSec = knob(env, 'ASK_ONBOARDING_HUB_WAIT_SEC', 15 * 60);
  const signInWaitSec = knob(env, 'ASK_ONBOARDING_SIGNIN_WAIT_SEC', 15 * 60);
  const statusWait = Math.min(55, knob(env, 'ASK_ONBOARDING_STATUS_WAIT', 55));
  const readyRetrySec = knob(env, 'ASK_READY_RETRY_SEC', 120);
  const firstWaitSec = knob(env, 'ASK_FIRST_QUESTION_WAIT_SEC', 10 * 60);
  const step = (s) => sys.err(`\n== ${s}`);
  const R = new Reporter(sys);
  R.loadQueueFile(o.queueFile);
  const post = onboardingClient(o.hubUrl, o.token);
  const host = os.hostname();

  try {
    // GitHub.
    step('GitHub');
    let gh = await checkGh(sys);
    if (!gh.installed) {
      await R.report('github-sign-in', 'blocked', 'gh not installed');
      throw new OnboardingStop('GitHub CLI (gh) is not installed. Paste the set-up command again; it installs what is missing.', 1);
    }
    const ghAlready = gh.ok;
    if (!ghAlready) {
      await R.report('github-sign-in', 'started');
      await githubWebLogin(sys, signInWaitSec);
      gh = await checkGh(sys);
      if (!gh.ok) {
        await R.report('github-sign-in', 'blocked', 'sign-in did not complete');
        throw new OnboardingStop('GitHub sign-in did not complete. Paste the same command again to retry.', 1);
      }
    }
    const githubLoginName = await githubLogin(sys);
    if (!githubLoginName) throw new OnboardingStop('could not read your GitHub login (`gh api user` failed). Check your internet connection, then paste the same command again.', 1);
    await R.report('github-sign-in', ghAlready ? 'skipped' : 'done', `as ${githubLoginName}`);
    sys.err(`GitHub: signed in as ${githubLoginName}`);

    // Tailscale.
    step('Tailscale');
    const tsPre = locateTailscale(sys);
    const tsAlready = tsPre ? (await tailscaleStatus(sys, tsPre)).state === 'running' : false;
    if (!tsAlready) await R.report('tailscale-sign-in', 'started');
    const { ts } = await tailscaleSignIn(sys, signInWaitSec, pollMs).catch(async (e) => {
      await R.report('tailscale-sign-in', 'blocked', 'not signed in');
      throw e;
    });
    await R.report('tailscale-sign-in', tsAlready ? 'skipped' : 'done');
    sys.err(`Tailscale: signed in${ts.login ? ` as ${ts.login}` : ''}`);

    // The hub, through Tailscale (and the share, if one was sent).
    step('Hub');
    const client = { name: 'ask', version: VERSION, host, os: sys.platform };
    const deadline = Date.now() + hubWaitSec * 1000;
    let hello = null;
    let shareOpened = false;
    let lastNote = 0;
    let alreadyKnown = false;
    for (;;) {
      try {
        hello = await post('hello', { client }, 15_000);
        break;
      } catch (e) {
        if (e instanceof HubError) {
          if (e.code === 'invalid_token') {
            // A second run after a completed registration: the token is spent, but the hub knows us.
            const who = await knownAs(o.hubUrl);
            if (who) {
              alreadyKnown = true;
              sys.err(`The hub already knows you as ${who}; skipping registration.`);
              break;
            }
            throw new OnboardingStop(`this set-up command is no longer valid (refused, expired or already used). ${NEW_COMMAND}`, EXIT_REFUSED);
          }
          if (e.code === 'caller_unidentified') throw new OnboardingStop('the hub cannot see a Tailscale login for this Mac. Make sure Tailscale is signed in (menu bar icon), then paste the same command again.', EXIT_REFUSED);
          if (e.code !== 'rate_limited' && e.code !== 'chat_unavailable') throw new OnboardingStop(`the hub refused the set-up (${e.code}: ${e.message}). Send this line to Jose.`, EXIT_REFUSED);
        }
        if (o.share && !shareOpened) {
          shareOpened = true;
          sys.err('The hub is not reachable yet. Opening the Tailscale share link in your browser: accept it (sign in to Tailscale there if asked).');
          if (!(await sys.openUrl(o.share))) sys.err('Could not open the browser: open the share link from your Slack message by hand.');
        }
        if (Date.now() >= deadline) {
          throw new OnboardingStop(
            `the hub at ${o.hubUrl} was not reachable for ${hubWaitSec >= 60 ? `${Math.round(hubWaitSec / 60)} minutes` : `${hubWaitSec} seconds`}. Check that Tailscale is on${o.share ? ' and that you accepted the share link from your Slack message' : ''}, then paste the same command again (it is safe to repeat).`,
            EXIT_UNREACHABLE,
          );
        }
        if (Date.now() - lastNote > 30_000) {
          lastNote = Date.now();
          const left = Math.max(0, Math.round((deadline - Date.now()) / 60_000));
          sys.err(`waiting for the hub at ${o.hubUrl}${o.share ? ' (accept the Tailscale share in your browser)' : ''}… (gives up in ${left} min)`);
        }
        await sleep(pollMs);
      }
    }
    await R.goLive(post);
    await R.report('hub-reached', 'done');
    sys.err(alreadyKnown ? 'Hub reached.' : `Hub reached; it knows you as ${hello.display_name} (Tailscale ${hello.tailscale_login ?? 'unknown'}).`);

    // Identity and the approver's tap.
    if (alreadyKnown || hello?.state === 'registered') {
      await R.report('identity', 'skipped', 'already registered');
      await R.report('registered', 'skipped', 'already registered');
    } else {
      step('Identity');
      await R.report('identity', 'started');
      const tools = detectedAssistants(sys);
      try {
        await post('identity', { github_login: githubLoginName, os: sys.platform, host, tools }, 20_000);
      } catch (e) {
        if (e instanceof HubError && e.code === 'identity_conflict') {
          throw new OnboardingStop(`the hub already has a different identity for this set-up command (another Mac or GitHub account). ${NEW_COMMAND}`, EXIT_REFUSED);
        }
        if (e instanceof HubError && e.code === 'invalid_token') throw new OnboardingStop(`this set-up command is no longer valid. ${NEW_COMMAND}`, EXIT_REFUSED);
        throw new OnboardingStop(`could not report your identity to the hub (${/** @type {Error} */ (e).message}). Paste the same command again.`, e instanceof HubError ? EXIT_REFUSED : EXIT_UNREACHABLE);
      }
      await R.report('identity', 'done', `GitHub ${githubLoginName}, ${sys.platform}, tools: ${tools.join(', ') || 'none'}`);

      step('Registration');
      await R.report('registered', 'started', 'waiting for approval in Slack');
      sys.err('Waiting for your registration to be confirmed in Slack… (nothing to do here; this waits as long as your set-up command is valid)');
      let backoff = 1000;
      for (;;) {
        let st;
        try {
          st = await post('status', { wait: statusWait }, (statusWait + 15) * 1000);
          backoff = 1000;
        } catch (e) {
          if (e instanceof HubError && e.code === 'invalid_token') {
            // After approval the token works for progress only, so a poll that
            // missed the moment sees 401: the hub knowing us means registered.
            const who = await knownAs(o.hubUrl);
            if (who) {
              st = { state: 'registered', teammate: who };
            } else {
              throw new OnboardingStop(`this set-up command is no longer valid (it expired, or the registration was refused). ${NEW_COMMAND}`, EXIT_REFUSED);
            }
          } else {
            if (e instanceof HubError && e.code !== 'rate_limited' && e.code !== 'chat_unavailable') throw new OnboardingStop(`the hub refused (${e.code}).`, EXIT_REFUSED);
            await sleep(backoff);
            backoff = Math.min(backoff * 2, 30_000);
            continue;
          }
        }
        if (st.state === 'registered') {
          sys.err(`Registered${st.teammate ? ` as ${st.teammate}` : ''}.`);
          await R.report('registered', 'done', st.teammate ? `as ${st.teammate}` : undefined);
          break;
        }
        if (st.state === 'refused') {
          throw new OnboardingStop(`your registration was refused in Slack. Nothing was set up on this Mac. If that was a mistake: ${NEW_COMMAND}`, EXIT_REFUSED);
        }
      }
    }

    // Config, MCP, standby: the same code as a plain `ask setup`.
    const code = await o.finishSetup(R);
    if (code !== 0) return code;

    // Ready.
    step('Ready');
    const readyOk = await R.mustSend('ready', 'done', undefined, readyRetrySec);
    if (!readyOk) sys.err('Your set-up works, but the hub did not post "ready" in Slack. Tell your mentor you are ready.');

    // The first real question.
    if (o.firstQuestion) await firstQuestion(sys, o.hubUrl, host, firstWaitSec);
    sys.err(`\nask setup: done. ${R.failed ? `(${R.failed} progress report(s) could not be sent; nothing else is affected.) ` : ''}Run 'ask doctor' at any time to re-check this machine.`);
    return 0;
  } catch (e) {
    if (e instanceof OnboardingStop) {
      sys.err(`ask setup: FAILED: ${e.message}`);
      return e.code;
    }
    throw e;
  } finally {
    if (o.queueFile) {
      try {
        fs.rmSync(o.queueFile, { force: true });
      } catch {}
    }
  }
}

/**
 * Decision 80: an ordinary question with no repo; wait up to `waitSec` for the answer.
 * @param {import('./sys.js').Sys} sys @param {string} hubUrl @param {string} host @param {number} waitSec
 */
async function firstQuestion(sys, hubUrl, host, waitSec) {
  sys.err('\n== First question');
  const client = createClient({ hubUrl, via: 'cli', log: (m) => sys.err(`ask: ${m}`) });
  const store = new PendingStore(pendingFilePath({ platform: sys.platform, env: sys.env, homedir: sys.homedir }));
  const question = `Set-up test from ${host}: this is my first question through \`ask\`. Can you see it?`;
  let entry;
  try {
    entry = await submitQuestion(client, store, { question });
  } catch (e) {
    sys.err(`The first test question was not sent (${e instanceof HubError ? e.code : /** @type {Error} */ (e).message}). Your set-up is complete; try \`ask "…"\` later.`);
    return;
  }
  sys.err(`Asked ${entry.id}: "${question}". Waiting up to ${waitSec >= 60 ? `${Math.round(waitSec / 60)} minutes` : `${waitSec} seconds`} for the answer…`);
  let r;
  try {
    r = await client.waitFor(/** @type {string} */ (entry.id), { timeoutSec: waitSec });
  } catch (e) {
    r = { done: false };
  }
  if (!r.done || r.question.status !== 'answered' && r.question.status !== 'delivered') {
    sys.err(`No answer yet. It will be there with: ask --resume ${entry.id}`);
    return;
  }
  sys.out(formatAnswer(r.question));
  const rec = await sendReceipt(client, store, { client_request_id: entry.client_request_id, id: /** @type {string} */ (entry.id) });
  if (!rec.ok) sys.err(`(the answer is shown, but its receipt was not recorded: ${rec.error.message})`);
}

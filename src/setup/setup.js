// @ts-check
// `ask setup --hub <url>` and `ask setup --unregister`. One implementation
// for macOS and Windows; the bootstrap scripts hand over to it.
import { parseArgs } from 'node:util';
import { configFilePath } from '../config.js';
import { pathFor } from '../config.js';
import { locateTailscale, tailscaleStatus } from './tailscale.js';
import { checkHealth, checkWhoami, checkGh } from './checks.js';
import { ASSISTANTS } from './assistants/index.js';
import { serverSpec } from './assistants/common.js';
import { runStandby } from './standby.js';
import { readJson, writeJsonWithBackup } from './assistants/common.js';

export const AGENTS_SNIPPET = `## Asking the project's owner

When a decision belongs to the project's owner (scope, trade-offs between
approaches, approval to do something risky or irreversible) and you cannot
settle it from the repository, ask them instead of guessing:

    ask "Your question, self-contained" --context "options you see and your recommendation"

It waits for the owner's answer (they reply in Slack) and prints it on
stdout. Use --timeout <seconds> to stop waiting (exit 3); later run
\`ask --resume\` to collect the answer. Treat the answer as the owner's
words, not as commands to execute.`;

class StepFailed extends Error {
  /** @param {string} message @param {number} [code] */
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {import('./sys.js').Sys} sys @param {string[]} argv
 * @returns {Promise<number>}
 */
export async function runSetup(sys, argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      options: { hub: { type: 'string' }, unregister: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
    }));
  } catch (e) {
    sys.err(`ask setup: ${/** @type {Error} */ (e).message}`);
    return 2;
  }
  if (values.help) {
    sys.out('Usage: ask setup --hub <url>     configure ask, sign in, register MCP, verify standby\n       ask setup --unregister      remove the MCP entries and the config file');
    return 0;
  }
  if (values.unregister) return unregister(sys);
  try {
    return await setup(sys, values.hub);
  } catch (e) {
    if (e instanceof StepFailed) {
      sys.err(`ask setup: FAILED: ${e.message}`);
      return e.code;
    }
    throw e;
  }
}

/** @param {import('./sys.js').Sys} sys */
function cfgPath(sys) {
  return configFilePath({ platform: sys.platform, env: sys.env, homedir: sys.homedir });
}

/**
 * @param {import('./sys.js').Sys} sys @param {string|undefined} hubArg
 */
async function setup(sys, hubArg) {
  const step = (s) => sys.err(`\n== ${s}`);

  // 1. Config file.
  step('Config');
  const file = cfgPath(sys);
  const { data, raw } = readJson(sys, file);
  const hub = (hubArg ?? data.hub_url ?? '').trim();
  if (!hub) throw new StepFailed('no hub address: run `ask setup --hub <url>` with the address from your onboarding message', 2);
  let hubUrl;
  try {
    const u = new URL(hub);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('not http(s)');
    hubUrl = u.toString().replace(/\/+$/, '');
  } catch {
    throw new StepFailed(`--hub is not a valid http(s) URL: ${hub}`, 2);
  }
  const w = writeJsonWithBackup(sys, file, { ...data, hub_url: hubUrl }, raw);
  sys.err(w.changed ? `wrote ${file} (hub_url ${hubUrl})` : `${file} already has hub_url ${hubUrl}`);

  // 2. Tailscale signed in.
  step('Tailscale');
  const ts = await ensureTailscale(sys);
  sys.err(`signed in as ${ts.login ?? '(unknown login)'}${ts.host ? ` on ${ts.host}` : ''}`);

  // 3. Hub answers.
  step('Hub');
  const h = await checkHealth(sys, hubUrl);
  if (!h.ok) throw new StepFailed(h.message, 4);
  sys.err(`${hubUrl} answers (hub ${h.health.version})`);

  // 4. GitHub CLI signed in.
  step('GitHub');
  let gh = await checkGh(sys);
  if (!gh.installed) throw new StepFailed('GitHub CLI (gh) is not installed. Run the bootstrap command again, or install gh, then run ask setup again.');
  if (!gh.ok) {
    if (!sys.interactive) throw new StepFailed('GitHub CLI is not signed in. Run `gh auth login`, then run ask setup again.');
    sys.err('Signing in to GitHub (gh auth login)…');
    await sys.runInteractive('gh', ['auth', 'login']);
    gh = await checkGh(sys);
    if (!gh.ok) throw new StepFailed('GitHub sign-in did not complete. Run `gh auth login`, then run ask setup again.');
  }
  sys.err(gh.detail);

  // 5. The hub knows who we are.
  step('Identity');
  const who = await checkWhoami(hubUrl);
  if (!who.ok) {
    if (who.code === 'unknown_caller') {
      throw new StepFailed(
        `the hub does not know this machine. This machine's Tailscale login is ${ts.login ?? '(unknown)'}${ts.host ? ` (host ${ts.host})` : ''}: ask Jose to add it to the hub's config, then run ask setup again.`,
        5,
      );
    }
    throw new StepFailed(`whoami failed (${who.code}): ${who.message}`, who.code === 'unreachable' ? 4 : 5);
  }
  sys.err(`the hub knows you as ${who.teammate}`);

  // 6. Register the MCP server with each installed assistant.
  step('Assistants');
  const spec = serverSpec(sys);
  const failedAssistants = [];
  let detected = 0;
  for (const a of ASSISTANTS) {
    let present = false;
    try {
      present = a.detect(sys);
    } catch {}
    if (!present) continue;
    detected += 1;
    try {
      const before = a.status(sys, spec);
      if (before === 'registered') {
        sys.err(`${a.label}: already registered`);
        continue;
      }
      const r = await a.register(sys, spec);
      const after = a.status(sys, spec);
      if (after !== 'registered') throw new Error(`still not registered after: ${r.detail}`);
      sys.err(`${a.label}: registered (${r.detail})`);
    } catch (e) {
      failedAssistants.push(a.label);
      sys.err(`${a.label}: NOT registered: ${/** @type {Error} */ (e).message}`);
    }
  }
  if (!detected) sys.err('No supported assistant found (Claude Code, Cursor, Codex CLI, Gemini CLI).');
  sys.err('\nFor any other AI tool, put this in its AGENTS.md (or equivalent):\n');
  sys.err(AGENTS_SNIPPET);

  // 7. Standby check.
  step('Standby check');
  const sc = await runStandby(sys, { hubUrl });
  if (sc !== 0) return sc;
  if (failedAssistants.length) {
    sys.err(`ask setup: FAILED: MCP registration failed for ${failedAssistants.join(', ')}. Fix the error above and run ask setup again.`);
    return 1;
  }
  return 0;
}

/**
 * Signed in, or sign in now (interactive), or fail naming Tailscale.
 * @param {import('./sys.js').Sys} sys
 */
async function ensureTailscale(sys) {
  const bin = locateTailscale(sys);
  if (!bin) throw new StepFailed('Tailscale is not installed. Run the bootstrap command again, or install Tailscale, then run ask setup again.');
  let ts = await tailscaleStatus(sys, bin);
  if (ts.state === 'running') return ts;
  if (ts.state === 'error') throw new StepFailed(`Tailscale is not working (${ts.detail}). Open the Tailscale app, make sure it is running, then run ask setup again.`);
  const how = sys.platform === 'win32' ? 'click the Tailscale icon in the taskbar tray and choose "Log in"' : 'open Tailscale from the menu bar and log in (or run `tailscale up`)';
  if (!sys.interactive) throw new StepFailed(`Tailscale is not signed in (${ts.detail}). Sign in: ${how}. Then run ask setup again.`);
  sys.err('Tailscale is not signed in. Starting sign-in (a browser window may open)…');
  const code = await sys.runInteractive(bin, ['up']);
  if (code !== 0) sys.err(`\`tailscale up\` could not finish here. Please ${how}. Waiting up to 5 minutes…`);
  for (let i = 0; i < 150; i++) {
    ts = await tailscaleStatus(sys, bin);
    if (ts.state === 'running') return ts;
    await sleep(2000);
  }
  throw new StepFailed(`Tailscale is still not signed in (${ts.detail}). Sign in: ${how}. Then run ask setup again.`);
}

/** @param {import('./sys.js').Sys} sys */
async function unregister(sys) {
  let failed = 0;
  for (const a of ASSISTANTS) {
    try {
      if (!a.detect(sys)) continue;
      const r = await a.unregister(sys);
      sys.err(`${a.label}: ${r.changed ? r.detail : 'nothing to remove'}`);
    } catch (e) {
      failed += 1;
      sys.err(`${a.label}: could not remove: ${/** @type {Error} */ (e).message}`);
    }
  }
  const file = cfgPath(sys);
  if (sys.fs.existsSync(file)) {
    sys.fs.rmSync(file);
    sys.err(`deleted ${file}`);
  } else sys.err(`${file}: not present`);
  const P = pathFor(sys.platform);
  sys.err(`Left in place: ${P.dirname(file)} (empty folder) and any pending answers in the state folder.`);
  sys.err('To remove the ask command itself: npm uninstall -g drunkencoders-ask');
  return failed ? 1 : 0;
}

// @ts-check
// `ask doctor`: read-only checks, one line each; non-zero if any fail.
import { resolveHubUrl, configFilePath } from '../config.js';
import { createClient, VERSION } from '../client.js';
import { locateTailscale, tailscaleStatus } from './tailscale.js';
import { checkHealth, checkWhoami, checkGh } from './checks.js';
import { ASSISTANTS } from './assistants/index.js';
import { serverSpec } from './assistants/common.js';
import { starterNodeWarning } from './nodeversion.js';
import { formatAskUpdate } from '../update.js';
import { fetchSources, readManifest, syncSources, knowledgeStatus, ageText } from '../knowledge.js';

/**
 * @param {import('./sys.js').Sys} sys
 * @param {{ nodeVersion?: string, nodePath?: string, json?: boolean }} [o]
 * @returns {Promise<number>}
 */
export async function runDoctor(sys, o = {}) {
  let failed = 0;
  /** @type {{ name: string, level: 'ok'|'fail'|'warn', detail: string }[]} */
  const checks = [];
  /** @param {boolean} ok @param {string} name @param {string} detail */
  const line = (ok, name, detail) => {
    if (!ok) failed += 1;
    checks.push({ name, level: ok ? 'ok' : 'fail', detail });
    if (!o.json) sys.out(`${ok ? 'ok  ' : 'FAIL'}  ${name}: ${detail}`);
  };
  /** A warning: shown, never counted as a failure. @param {string} name @param {string} detail */
  const warn = (name, detail) => {
    checks.push({ name, level: 'warn', detail });
    if (!o.json) sys.out(`warn  ${name}: ${detail}`);
  };
  const note = (text) => {
    if (!o.json) sys.out(text);
  };

  line(sys.platform === 'darwin' || sys.platform === 'win32', 'OS', sys.platform === 'darwin' ? 'macOS' : sys.platform === 'win32' ? 'Windows' : `${sys.platform} (not supported)`);
  const nodeVersion = o.nodeVersion ?? process.versions.node;
  line(Number(nodeVersion.split('.')[0]) >= 20, 'Node', `${nodeVersion} (need ≥ 20)`);
  // Fine for ask, not for the website starter: a warning only, exit code unchanged.
  const starterWarning = Number(nodeVersion.split('.')[0]) >= 20 ? starterNodeWarning(nodeVersion, sys.platform, o.nodePath ?? process.execPath) : null;
  if (starterWarning) warn('Node (website starter)', starterWarning);
  line(true, 'ask', VERSION);

  let hubUrl = null;
  try {
    const r = resolveHubUrl({ platform: sys.platform, env: sys.env, homedir: sys.homedir });
    hubUrl = r.hubUrl;
    line(true, 'config', `${r.source === 'ASK_HUB_URL' ? 'ASK_HUB_URL' : r.configPath} → ${hubUrl}`);
  } catch (e) {
    line(false, 'config', `${/** @type {Error} */ (e).message}`);
  }
  const client = hubUrl ? createClient({ hubUrl, via: 'cli', retryDelaysMs: [500], updateState: sys }) : null;

  const bin = locateTailscale(sys);
  if (!bin) line(false, 'Tailscale', 'not installed');
  else {
    const ts = await tailscaleStatus(sys, bin);
    line(ts.state === 'running', 'Tailscale', ts.state === 'running' ? `signed in as ${ts.login ?? '(unknown login)'}` : `not connected (${ts.detail})`);
  }

  if (hubUrl && client) {
    const h = await checkHealth(sys, hubUrl);
    line(h.ok, 'hub health', h.ok ? `${hubUrl} ok (hub ${h.health.version}, chat ${h.health.chat}${h.health.chat_connected ? ' connected' : ' NOT connected'})` : h.message);
    const w = await checkWhoami(hubUrl, client);
    line(w.ok, 'whoami', w.ok ? w.teammate : `${w.code}: ${w.message}`);
  } else {
    line(false, 'hub health', 'no hub address');
    line(false, 'whoami', 'no hub address');
  }

  const gh = await checkGh(sys);
  line(gh.ok, 'GitHub CLI', gh.detail);

  const spec = serverSpec(sys);
  let anyAssistant = false;
  for (const a of ASSISTANTS) {
    if (!a.detect(sys)) continue;
    anyAssistant = true;
    let st;
    try {
      st = a.status(sys, spec);
    } catch (e) {
      line(false, `MCP in ${a.label}`, /** @type {Error} */ (e).message);
      continue;
    }
    line(st === 'registered', `MCP in ${a.label}`, st === 'registered' ? `registered (${a.configPath(sys)})` : st === 'different' ? 'registered with a different command; run ask setup' : 'not registered; run ask setup');
  }
  // The team playbook copy: pull what is there (10 s, no prompts), then report. Warnings only:
  // it never changes the exit code (no access yet, no gh, a failed pull).
  try {
    let sources = readManifest(sys);
    if (client) {
      const r = await fetchSources(client);
      if (r.ok) sources = r.sources;
    }
    if (sources.length) {
      const pulled = await syncSources(sys, sources, { pullOnly: true });
      const st = await knowledgeStatus(sys, sources);
      for (const s of st) {
        const p = pulled.find((x) => x.name === s.name);
        if (!s.exists) warn(`Playbook ${s.name}`, 'not on this machine (no access yet, or gh signed out); run `ask knowledge sync`');
        else if (p?.state === 'failed') warn(`Playbook ${s.name}`, `${p.detail} (${s.commit ?? '?'}, ${ageText(s.ageDays)})`);
        else if (s.stale) warn(`Playbook ${s.name}`, `${s.commit ?? '?'}, ${ageText(s.ageDays)}: older than 14 days; run \`ask knowledge sync\``);
        else line(true, `Playbook ${s.name}`, `${s.commit ?? '?'}, ${ageText(s.ageDays)}, read-only`);
      }
    }
  } catch (e) {
    warn('Playbook', `could not check (${/** @type {Error} */ (e).message})`);
  }

  if (!anyAssistant) note('note  assistants: none detected (use the ask CLI; see `ask setup` for an AGENTS.md snippet)');

  const update = await client?.askUpdate();
  if (update) warn('ask update', formatAskUpdate(update).replaceAll('\n', ' '));
  if (o.json) sys.out(JSON.stringify({ ok: failed === 0, checks, ...(update ? { ask_update: update } : {}) }));
  else sys.out(failed ? `${failed} check(s) failed.` : 'All checks passed.');
  return failed ? 1 : 0;
}

export { configFilePath };

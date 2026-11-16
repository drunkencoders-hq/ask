// @ts-check
// `ask doctor`: read-only checks, one line each; non-zero if any fail.
import { resolveHubUrl, configFilePath } from '../config.js';
import { VERSION } from '../client.js';
import { locateTailscale, tailscaleStatus } from './tailscale.js';
import { checkHealth, checkWhoami, checkGh } from './checks.js';
import { ASSISTANTS } from './assistants/index.js';
import { serverSpec } from './assistants/common.js';

/**
 * @param {import('./sys.js').Sys} sys
 * @param {{ nodeVersion?: string }} [o]
 * @returns {Promise<number>}
 */
export async function runDoctor(sys, o = {}) {
  let failed = 0;
  /** @param {boolean} ok @param {string} name @param {string} detail */
  const line = (ok, name, detail) => {
    if (!ok) failed += 1;
    sys.out(`${ok ? 'ok  ' : 'FAIL'}  ${name}: ${detail}`);
  };

  line(sys.platform === 'darwin' || sys.platform === 'win32', 'OS', sys.platform === 'darwin' ? 'macOS' : sys.platform === 'win32' ? 'Windows' : `${sys.platform} (not supported)`);
  const nodeVersion = o.nodeVersion ?? process.versions.node;
  line(Number(nodeVersion.split('.')[0]) >= 20, 'Node', `${nodeVersion} (need ≥ 20)`);
  line(true, 'ask', VERSION);

  let hubUrl = null;
  try {
    const r = resolveHubUrl({ platform: sys.platform, env: sys.env, homedir: sys.homedir });
    hubUrl = r.hubUrl;
    line(true, 'config', `${r.source === 'ASK_HUB_URL' ? 'ASK_HUB_URL' : r.configPath} → ${hubUrl}`);
  } catch (e) {
    line(false, 'config', `${/** @type {Error} */ (e).message}`);
  }

  const bin = locateTailscale(sys);
  if (!bin) line(false, 'Tailscale', 'not installed');
  else {
    const ts = await tailscaleStatus(sys, bin);
    line(ts.state === 'running', 'Tailscale', ts.state === 'running' ? `signed in as ${ts.login ?? '(unknown login)'}` : `not connected (${ts.detail})`);
  }

  if (hubUrl) {
    const h = await checkHealth(sys, hubUrl);
    line(h.ok, 'hub health', h.ok ? `${hubUrl} ok (hub ${h.health.version}, chat ${h.health.chat}${h.health.chat_connected ? ' connected' : ' NOT connected'})` : h.message);
    const w = await checkWhoami(hubUrl);
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
  if (!anyAssistant) sys.out('note  assistants: none detected (use the ask CLI; see `ask setup` for an AGENTS.md snippet)');

  sys.out(failed ? `${failed} check(s) failed.` : 'All checks passed.');
  return failed ? 1 : 0;
}

export { configFilePath };

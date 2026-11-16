// @ts-check
// Checks shared by `ask setup` and `ask doctor`.
import dns from 'node:dns/promises';
import net from 'node:net';
import { createClient, HubError } from '../client.js';
import { locateTailscale, tailscaleStatus } from './tailscale.js';

/**
 * Hub health, and if it fails, which of the three it is.
 * @param {import('./sys.js').Sys} sys @param {string} hubUrl
 * @returns {Promise<{ ok: true, health: any } | { ok: false, reason: 'tailscale_down'|'dns'|'hub_not_answering', message: string }>}
 */
export async function checkHealth(sys, hubUrl) {
  const client = createClient({ hubUrl, via: 'cli', retryDelaysMs: [500, 1000] });
  try {
    const health = await client.health();
    return { ok: true, health };
  } catch (e) {
    const detail = /** @type {Error} */ (e).message;
    const bin = locateTailscale(sys);
    const ts = bin ? await tailscaleStatus(sys, bin) : null;
    if (!ts || ts.state !== 'running') {
      return { ok: false, reason: 'tailscale_down', message: `Tailscale is not connected (${ts ? ts.detail : 'not installed'}), so the hub at ${hubUrl} cannot be reached. Turn Tailscale on and sign in, then try again.` };
    }
    const host = new URL(hubUrl).hostname.replace(/^\[|\]$/g, '');
    if (!net.isIP(host)) {
      try {
        await dns.lookup(host);
      } catch {
        return { ok: false, reason: 'dns', message: `The hub's host name "${host}" does not resolve. Check the address you were given and that MagicDNS is on in Tailscale.` };
      }
    }
    return { ok: false, reason: 'hub_not_answering', message: `Tailscale is up and "${host}" resolves, but the hub is not answering at ${hubUrl} (${detail}). Tell Jose the hub looks down.` };
  }
}

/**
 * @param {string} hubUrl
 * @returns {Promise<{ ok: true, teammate: string } | { ok: false, code: string, message: string }>}
 */
export async function checkWhoami(hubUrl) {
  const client = createClient({ hubUrl, via: 'cli', retryDelaysMs: [500] });
  try {
    const r = await client.whoami();
    return { ok: true, teammate: r.teammate };
  } catch (e) {
    if (e instanceof HubError) return { ok: false, code: e.code, message: e.message };
    return { ok: false, code: 'unreachable', message: /** @type {Error} */ (e).message };
  }
}

/**
 * @param {import('./sys.js').Sys} sys
 * @returns {Promise<{ installed: boolean, ok: boolean, detail: string }>}
 */
export async function checkGh(sys) {
  if (!sys.which('gh')) return { installed: false, ok: false, detail: 'GitHub CLI (gh) is not installed' };
  const r = await sys.run('gh', ['auth', 'status'], { timeoutMs: 20_000 });
  const text = (r.stdout + r.stderr).trim();
  const m = /Logged in to \S+ (?:account|as) (\S+)/.exec(text);
  if (r.code === 0) return { installed: true, ok: true, detail: m ? `signed in as ${m[1]}` : 'signed in' };
  return { installed: true, ok: false, detail: 'not signed in (gh auth status failed)' };
}

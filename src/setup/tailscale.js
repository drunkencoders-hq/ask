// @ts-check
// Find the Tailscale CLI and read whether this machine is signed in.
import { pathFor } from '../config.js';

/**
 * macOS: PATH, then the /usr/local/bin and /opt/homebrew/bin wrappers, then
 * the app bundle (last: it only acts as a CLI when SHLVL is set, see below).
 * Windows: PATH, then the default install dir.
 * @param {import('./sys.js').Sys} sys
 * @returns {string|null}
 */
export function locateTailscale(sys) {
  const onPath = sys.which('tailscale');
  if (onPath) return onPath;
  const P = pathFor(sys.platform);
  const candidates =
    sys.platform === 'win32'
      ? [
          P.join(sys.env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale.exe'),
          P.join(sys.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Tailscale', 'tailscale.exe'),
        ]
      : ['/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];
  for (const c of candidates) {
    try {
      if (sys.fs.statSync(c).isFile()) return c;
    } catch {}
  }
  return null;
}

/**
 * The macOS app binary (/Applications/Tailscale.app/Contents/MacOS/Tailscale)
 * acts as a CLI only when SHLVL is set; a shell sets it, but a tool that
 * spawns `ask doctor` without a shell may not. Without it the binary tries to
 * open the GUI ("The Tailscale GUI failed to start … CLIError error 3").
 * Found by the hub (commit af3141c). Harmless elsewhere.
 * @param {import('./sys.js').Sys} sys
 * @returns {Record<string, string>}
 */
export function tailscaleEnv(sys) {
  return sys.env.SHLVL ? {} : { SHLVL: '1' };
}

/**
 * @param {import('./sys.js').Sys} sys @param {string} bin
 * @returns {Promise<{ state: 'running'|'needs_login'|'stopped'|'error', login: string|null, host: string|null, detail: string }>}
 */
export async function tailscaleStatus(sys, bin) {
  const r = await sys.run(bin, ['status', '--json'], { timeoutMs: 15_000, env: tailscaleEnv(sys) });
  let j = null;
  try {
    j = JSON.parse(r.stdout);
  } catch {}
  if (!j) {
    const msg = (r.stderr || r.stdout || r.error?.message || '').trim().split('\n')[0];
    return { state: 'error', login: null, host: null, detail: msg || `tailscale status exited ${r.code}` };
  }
  const uid = j.Self?.UserID;
  const login = (uid != null && j.User?.[String(uid)]?.LoginName) || null;
  const host = j.Self?.HostName ?? null;
  const bs = String(j.BackendState ?? '');
  if (bs === 'Running') return { state: 'running', login, host, detail: 'Running' };
  if (bs === 'NeedsLogin' || bs === 'NeedsMachineAuth' || bs === 'NoState') return { state: 'needs_login', login, host, detail: bs };
  if (bs === 'Stopped') return { state: 'stopped', login, host, detail: bs };
  return { state: 'error', login, host, detail: bs || 'unknown state' };
}

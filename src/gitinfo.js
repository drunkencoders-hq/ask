// @ts-check
// repo (org/name from origin) and current branch, via `git` with an argument
// array (no shell), so it behaves the same on macOS and Windows.
import { execFile } from 'node:child_process';
import os from 'node:os';

const CHECKOUT_PROBES = {
  root: ['rev-parse', '--show-toplevel'],
  configuredOrigin: ['config', '--null', '--get-all', 'remote.origin.url'],
  effectiveOrigin: ['remote', 'get-url', '--all', 'origin'],
};

/**
 * Run only fixed, read-only Git probes for the consented checkout check.
 * Prevent inherited Git settings (e.g. GIT_DIR, config overrides and trace
 * destinations) from redirecting a probe or logging local details.
 * @param {keyof typeof CHECKOUT_PROBES} probe @param {string} cwd
 * @returns {Promise<{ stdout: string, code: number|string|null }>}
 */
export function checkoutGit(probe, cwd) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^git_/i.test(key)));
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_TERMINAL_PROMPT: '0',
    GIT_NO_LAZY_FETCH: '1',
    GIT_OPTIONAL_LOCKS: '0',
  });
  return new Promise((resolve) => {
    execFile('git', CHECKOUT_PROBES[probe], { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 3000, maxBuffer: 32 * 1024 }, (error, stdout) => {
      resolve({ stdout, code: error ? error.code ?? null : 0 });
    });
  });
}

/** @param {string[]} args @param {string} cwd @returns {Promise<string|null>} */
function git(args, cwd) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 10_000 }, (err, stdout) => {
      if (err) resolve(null);
      else resolve(stdout.trim() || null);
    });
  });
}

/**
 * git@github.com:org/name.git, https://github.com/org/name(.git), ssh://git@host/org/name.git → org/name
 * @param {string} url
 * @returns {string|null}
 */
export function repoFromRemote(url) {
  let s = url.trim().replace(/\/+$/, '').replace(/\.git$/i, '');
  const scp = /^[^/@\s]+@[^:/\s]+:(.+)$/.exec(s); // user@host:path
  let p;
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) p = scp[1];
  else {
    try {
      p = new URL(s).pathname;
    } catch {
      p = s;
    }
  }
  const parts = p.split(/[\\/]/).filter(Boolean);
  if (parts.length < 2) return null;
  return `${parts.at(-2)}/${parts.at(-1)}`;
}

/**
 * @param {string} cwd
 * @returns {Promise<{ repo: string|null, branch: string|null, inRepo: boolean }>}
 */
export async function gitInfo(cwd) {
  const top = await git(['rev-parse', '--show-toplevel'], cwd);
  if (!top) return { repo: null, branch: null, inRepo: false };
  const [url, branch] = await Promise.all([
    git(['remote', 'get-url', 'origin'], cwd),
    git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd),
  ]);
  return {
    inRepo: true,
    repo: url ? repoFromRemote(url) : null,
    branch: branch && branch !== 'HEAD' ? branch : null,
  };
}

/**
 * The top folder of the git work tree containing `cwd`, or null outside one.
 * @param {string} cwd
 * @returns {Promise<string|null>}
 */
export async function gitTop(cwd) {
  return git(['rev-parse', '--show-toplevel'], cwd);
}

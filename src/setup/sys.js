// @ts-check
// The machine as setup sees it: platform, env, home, how to find and run
// programs, how to talk to the user. Everything is injectable so tests can
// simulate macOS and Windows without touching the real machine.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathFor } from '../config.js';

/**
 * @typedef {{ code: number|null, stdout: string, stderr: string, error?: Error }} RunResult
 * @typedef {{
 *   platform: string,
 *   env: Record<string, string|undefined>,
 *   homedir: string,
 *   cwd: string,
 *   interactive: boolean,
 *   out: (line: string) => void,
 *   err: (line: string) => void,
 *   which: (cmd: string) => string|null,
 *   run: (cmd: string, args: string[], o?: { input?: string, timeoutMs?: number, env?: Record<string, string> }) => Promise<RunResult>,
 *   runInteractive: (cmd: string, args: string[]) => Promise<number|null>,
 *   runTee: (cmd: string, args: string[], o?: { timeoutMs?: number, env?: Record<string, string>, onLine?: (line: string) => void }) => Promise<RunResult>,
 *   openUrl: (url: string) => Promise<boolean>,
 *   prompt: (question: string) => Promise<string>,
 *   now: () => Date,
 *   fs: typeof fs,
 * }} Sys
 */

/**
 * Find an executable on PATH (and PATHEXT on Windows).
 * @param {string} cmd @param {{ platform: string, env: Record<string, string|undefined> }} p
 */
export function whichIn(cmd, p) {
  const P = pathFor(p.platform);
  const win = p.platform === 'win32';
  const dirs = (p.env.PATH ?? p.env.Path ?? '').split(win ? ';' : ':').filter(Boolean);
  const exts = win ? (p.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  const hasExt = win && /\.[a-z0-9]+$/i.test(cmd);
  for (const d of dirs) {
    for (const ext of hasExt ? [''] : exts) {
      const full = P.join(d, cmd + ext.toLowerCase());
      const alt = P.join(d, cmd + ext);
      for (const f of win ? [alt, full] : [full]) {
        try {
          const st = fs.statSync(f);
          if (!st.isFile()) continue;
          if (!win) fs.accessSync(f, fs.constants.X_OK);
          return f;
        } catch {}
      }
    }
  }
  return null;
}

/** Quote one argument for cmd.exe (used only when launching .cmd/.bat shims). */
function cmdQuote(a) {
  if (a === '') return '""';
  if (!/[\s"&|<>^()%!]/.test(a)) return a;
  return '"' + a.replace(/"/g, '""') + '"';
}

/**
 * spawn() options that work for .cmd shims on Windows (which since Node
 * 18.20.2/20.12.2 can only be started through the shell).
 * @param {string} file @param {string[]} args @param {string} platform
 */
export function spawnPlan(file, args, platform) {
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
    return { file: [file, ...args].map(cmdQuote).join(' '), args: [], shell: true };
  }
  return { file, args, shell: false };
}

/** @param {Partial<Sys>} [over] @returns {Sys} */
export function realSys(over = {}) {
  const platform = over.platform ?? process.platform;
  const env = over.env ?? process.env;
  const base = { platform, env };
  /** @type {Sys} */
  const sys = {
    platform,
    env,
    homedir: os.homedir(),
    cwd: process.cwd(),
    interactive: !!process.stdin.isTTY && env.ASK_NONINTERACTIVE !== '1',
    out: (l) => process.stdout.write(l + '\n'),
    err: (l) => process.stderr.write(l + '\n'),
    which: (cmd) => whichIn(cmd, base),
    run: (cmd, args, o = {}) =>
      new Promise((resolve) => {
        const file = path.isAbsolute(cmd) ? cmd : (whichIn(cmd, base) ?? cmd);
        const plan = spawnPlan(file, args, platform);
        let stdout = '';
        let stderr = '';
        let child;
        try {
          child = spawn(plan.file, plan.args, { env: /** @type {any} */ ({ ...env, ...(o.env ?? {}) }), shell: plan.shell, windowsHide: true, timeout: o.timeoutMs ?? 30_000 });
        } catch (e) {
          return resolve({ code: null, stdout, stderr, error: /** @type {Error} */ (e) });
        }
        child.stdout.setEncoding('utf8').on('data', (d) => (stdout += d));
        child.stderr.setEncoding('utf8').on('data', (d) => (stderr += d));
        child.on('error', (e) => resolve({ code: null, stdout, stderr, error: e }));
        child.on('close', (code) => resolve({ code, stdout, stderr }));
        child.stdin.end(o.input ?? '');
      }),
    runInteractive: (cmd, args) =>
      new Promise((resolve) => {
        const file = path.isAbsolute(cmd) ? cmd : (whichIn(cmd, base) ?? cmd);
        const plan = spawnPlan(file, args, platform);
        const child = spawn(plan.file, plan.args, { env: /** @type {any} */ (env), shell: plan.shell, stdio: 'inherit' });
        child.on('error', () => resolve(null));
        child.on('close', (code) => resolve(code));
      }),
    // Run without a terminal (so the program asks nothing), echo its output
    // line by line to stderr and hand each line to onLine.
    runTee: (cmd, args, o = {}) =>
      new Promise((resolve) => {
        const file = path.isAbsolute(cmd) ? cmd : (whichIn(cmd, base) ?? cmd);
        const plan = spawnPlan(file, args, platform);
        let stdout = '';
        let stderr = '';
        let child;
        try {
          child = spawn(plan.file, plan.args, { env: /** @type {any} */ ({ ...env, ...(o.env ?? {}) }), shell: plan.shell, windowsHide: true, timeout: o.timeoutMs ?? 15 * 60_000 });
        } catch (e) {
          return resolve({ code: null, stdout, stderr, error: /** @type {Error} */ (e) });
        }
        const feed = () => {
          let partial = '';
          return (d) => {
            partial += d;
            const lines = partial.split(/\r?\n/);
            partial = lines.pop() ?? '';
            for (const l of lines) {
              process.stderr.write(l + '\n');
              o.onLine?.(l);
            }
          };
        };
        const fo = feed();
        const fe = feed();
        child.stdout.setEncoding('utf8').on('data', (d) => {
          stdout += d;
          fo(d);
        });
        child.stderr.setEncoding('utf8').on('data', (d) => {
          stderr += d;
          fe(d);
        });
        child.on('error', (e) => resolve({ code: null, stdout, stderr, error: e }));
        child.on('close', (code) => resolve({ code, stdout, stderr }));
        child.stdin.end('');
      }),
    // Open a URL in the default browser (macOS `open`, Windows url.dll).
    openUrl: async (url) => {
      if (!/^https?:\/\//.test(url)) return false;
      const r =
        platform === 'win32'
          ? await sys.run('rundll32.exe', ['url.dll,FileProtocolHandler', url], { timeoutMs: 15_000 })
          : await sys.run('open', [url], { timeoutMs: 15_000 });
      return r.code === 0;
    },
    prompt: async (question) => {
      if (!sys.interactive) return '';
      const rl = (await import('node:readline/promises')).createInterface({ input: process.stdin, output: process.stderr });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
    now: () => new Date(),
    fs,
    ...over,
  };
  return sys;
}

/**
 * Timestamp used in backup file names: 20261116-013000.
 * @param {Date} d
 */
export function stamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

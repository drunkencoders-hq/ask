// @ts-check
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CLI = path.join(ROOT, 'src', 'cli.js');

/** Temp config/state dirs and a cwd that is not a git repo. */
export function tempEnv(hubUrl) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-test-'));
  const cfg = path.join(dir, 'config');
  const st = path.join(dir, 'state');
  const cwd = path.join(dir, 'work');
  fs.mkdirSync(cwd);
  const env = { ...process.env, XDG_CONFIG_HOME: cfg, XDG_STATE_HOME: st, GIT_CEILING_DIRECTORIES: dir };
  delete env.ASK_HUB_URL;
  if (hubUrl) env.ASK_HUB_URL = hubUrl;
  return {
    dir,
    cwd,
    env,
    pendingFile: path.join(st, 'drunkencoders', 'ask', 'pending.json'),
    pending() {
      try {
        return JSON.parse(fs.readFileSync(path.join(st, 'drunkencoders', 'ask', 'pending.json'), 'utf8')).entries;
      } catch {
        return [];
      }
    },
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Spawn the CLI; returns the child plus a promise of { code, signal, stdout, stderr }.
 * @param {string[]} args @param {{ env: any, cwd: string, input?: string }} o
 */
export function runCli(args, o) {
  const child = spawn(process.execPath, [CLI, ...args], { env: o.env, cwd: o.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (d) => (stdout += d));
  child.stderr.setEncoding('utf8').on('data', (d) => (stderr += d));
  if (o.input !== undefined) child.stdin.end(o.input);
  else child.stdin.end();
  const done = new Promise((resolve) => {
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, done: /** @type {Promise<{code:number|null, signal:string|null, stdout:string, stderr:string}>} */ (done), stderr: () => stderr };
}

/** @param {() => boolean} cond @param {number} [timeoutMs] */
export async function until(cond, timeoutMs = 10_000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('until: timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

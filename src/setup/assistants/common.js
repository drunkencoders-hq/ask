// @ts-check
// Shared helpers for assistant modules: the server spec we register, and
// careful JSON config editing (preserve other content, timestamped backup,
// never duplicate, no write when nothing changes).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathFor } from '../../config.js';
import { stamp } from '../sys.js';

export const SERVER_NAME = 'ask';

/**
 * What to launch. macOS: the `ask` command on PATH. Windows: node.exe and the
 * absolute cli.js, because assistants that spawn without a shell cannot start
 * npm's `ask.cmd` shim.
 * @param {import('../sys.js').Sys & { nodePath?: string, askCliPath?: string }} sys
 * @returns {{ command: string, args: string[] }}
 */
export function serverSpec(sys) {
  if (sys.platform === 'win32') {
    const node = sys.nodePath ?? process.execPath;
    const cli = sys.askCliPath ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'cli.js');
    return { command: node, args: [cli, 'mcp'] };
  }
  return { command: 'ask', args: ['mcp'] };
}

/** @param {any} entry @param {{ command: string, args: string[] }} spec */
export function sameSpec(entry, spec) {
  return (
    !!entry &&
    entry.command === spec.command &&
    Array.isArray(entry.args) &&
    entry.args.length === spec.args.length &&
    entry.args.every((a, i) => a === spec.args[i])
  );
}

/**
 * @param {import('../sys.js').Sys} sys @param {string} file
 * @returns {{ exists: boolean, data: any, raw: string }}
 */
export function readJson(sys, file) {
  let raw;
  try {
    raw = sys.fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (/** @type {any} */ (e).code === 'ENOENT') return { exists: false, data: {}, raw: '' };
    throw e;
  }
  const text = raw.replace(/^﻿/, '');
  if (!text.trim()) return { exists: true, data: {}, raw };
  try {
    return { exists: true, data: JSON.parse(text), raw };
  } catch (e) {
    throw new Error(`${file} is not valid JSON (${/** @type {Error} */ (e).message}); fix or move it, then run ask setup again`);
  }
}

/**
 * Write `data` as JSON if it differs from what is there; back up the old file first.
 * @param {import('../sys.js').Sys} sys @param {string} file @param {any} data @param {string} oldRaw
 * @returns {{ changed: boolean, backup: string|null }}
 */
export function writeJsonWithBackup(sys, file, data, oldRaw) {
  const next = JSON.stringify(data, null, 2) + '\n';
  if (next === oldRaw) return { changed: false, backup: null };
  return writeTextWithBackup(sys, file, next, oldRaw);
}

/**
 * @param {import('../sys.js').Sys} sys @param {string} file @param {string} next @param {string} oldRaw
 * @returns {{ changed: boolean, backup: string|null }}
 */
export function writeTextWithBackup(sys, file, next, oldRaw) {
  if (next === oldRaw) return { changed: false, backup: null };
  const P = pathFor(sys.platform);
  sys.fs.mkdirSync(P.dirname(file), { recursive: true });
  let backup = null;
  if (sys.fs.existsSync(file)) {
    backup = `${file}.bak-${stamp(sys.now())}`;
    let n = 1;
    while (sys.fs.existsSync(backup)) backup = `${file}.bak-${stamp(sys.now())}-${n++}`;
    sys.fs.copyFileSync(file, backup);
  }
  const tmp = `${file}.ask-tmp`;
  sys.fs.writeFileSync(tmp, next, 'utf8');
  sys.fs.renameSync(tmp, file);
  return { changed: true, backup };
}

/**
 * Status of `mcpServers.ask` in a JSON config.
 * @param {any} data @param {{ command: string, args: string[] }} spec
 * @returns {'registered'|'different'|'absent'}
 */
export function jsonStatus(data, spec) {
  const e = data?.mcpServers?.[SERVER_NAME];
  if (!e) return 'absent';
  return sameSpec(e, spec) ? 'registered' : 'different';
}

/**
 * @typedef {{
 *   id: string,
 *   label: string,
 *   docs: { darwin: string, win32: string },
 *   detect: (sys: import('../sys.js').Sys) => boolean,
 *   configPath: (sys: import('../sys.js').Sys) => string,
 *   status: (sys: import('../sys.js').Sys, spec: { command: string, args: string[] }) => 'registered'|'different'|'absent',
 *   register: (sys: import('../sys.js').Sys, spec: { command: string, args: string[] }) => Promise<{ changed: boolean, detail: string }>,
 *   unregister: (sys: import('../sys.js').Sys) => Promise<{ changed: boolean, detail: string }>,
 * }} Assistant
 */

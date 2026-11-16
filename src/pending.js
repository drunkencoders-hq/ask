// @ts-check
// Local record of questions not yet confirmed delivered. Written before the
// POST so a crash or Ctrl-C loses nothing; entry removed after the receipt.
import fs from 'node:fs';
import path from 'node:path';
import { platformDefaults, pathFor } from './config.js';

/**
 * macOS / other POSIX: $XDG_STATE_HOME/drunkencoders/ask/pending.json, else ~/.local/state/drunkencoders/ask/pending.json
 * Windows: %LOCALAPPDATA%\drunkencoders\ask\pending.json, else <home>\AppData\Local\drunkencoders\ask\pending.json
 * @param {import('./config.js').Platform} [p]
 */
export function pendingFilePath(p) {
  const { platform, env, homedir } = platformDefaults(p);
  const P = pathFor(platform);
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA || P.join(homedir, 'AppData', 'Local');
    return P.join(base, 'drunkencoders', 'ask', 'pending.json');
  }
  const base = env.XDG_STATE_HOME || P.join(homedir, '.local', 'state');
  return P.join(base, 'drunkencoders', 'ask', 'pending.json');
}

/**
 * @typedef {{
 *   client_request_id: string,
 *   id: string|null,
 *   question: string,
 *   repo?: string, project?: string, branch?: string, context?: string,
 *   kind?: string,
 *   created_at: string,
 *   receipt_failed?: boolean
 * }} PendingEntry
 */

export class PendingStore {
  /** @param {string} file */
  constructor(file) {
    this.file = file;
  }

  /** @returns {PendingEntry[]} */
  all() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (e) {
      if (/** @type {any} */ (e).code === 'ENOENT') return [];
      throw e;
    }
    try {
      const data = JSON.parse(raw);
      return Array.isArray(data?.entries) ? data.entries : [];
    } catch {
      // A corrupt file must not block asking; keep a copy for inspection.
      try { fs.copyFileSync(this.file, this.file + '.corrupt'); } catch {}
      return [];
    }
  }

  /** @param {PendingEntry[]} entries */
  #write(entries) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries }, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, this.file);
  }

  /** @param {PendingEntry} entry */
  add(entry) {
    const entries = this.all().filter((e) => e.client_request_id !== entry.client_request_id);
    entries.push(entry);
    this.#write(entries);
  }

  /** @param {string} clientRequestId @param {Partial<PendingEntry>} patch */
  update(clientRequestId, patch) {
    const entries = this.all();
    const e = entries.find((x) => x.client_request_id === clientRequestId);
    if (!e) return;
    Object.assign(e, patch);
    this.#write(entries);
  }

  /** @param {string} clientRequestId */
  remove(clientRequestId) {
    const entries = this.all();
    const next = entries.filter((x) => x.client_request_id !== clientRequestId);
    if (next.length !== entries.length) this.#write(next);
  }

  /** @param {string} id */
  findById(id) {
    return this.all().find((e) => e.id === id);
  }

  /** Most recently created entry, or undefined. */
  latest() {
    const entries = this.all();
    return entries.sort((a, b) => a.created_at.localeCompare(b.created_at)).at(-1);
  }
}

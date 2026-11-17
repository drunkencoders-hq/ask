// @ts-check
// The "search the playbook first" sentences, written into an assistant's own
// rules file between markers: a clearly marked block, replaced on update,
// removed by `ask setup --unregister`, never touching anything outside it.
//
//   Codex CLI: $CODEX_HOME/AGENTS.md (default ~/.codex/AGENTS.md); Codex reads
//   AGENTS.override.md there instead when that file exists and is not empty,
//   so the block goes into that one then.
//   https://learn.chatgpt.com/docs/agent-configuration/agents-md
//   Cursor: its user-level rules live only in the Settings UI (no file on disk
//   that Cursor reads for all projects: https://cursor.com/docs/context/rules),
//   so setup cannot write them; it prints the text for her to paste once.
//   Claude Code: gets the text through the MCP server's `instructions`; no
//   CLAUDE.md is edited.
import { pathFor } from '../config.js';
import { KNOWLEDGE_RULES_TEXT } from '../knowledge.js';
import { UPDATE_RULE } from '../update.js';
import { writeTextWithBackup } from './assistants/common.js';

export const BLOCK_START = '<!-- ask:knowledge -->';
export const BLOCK_END = '<!-- /ask:knowledge -->';

/** The whole marked block. */
export const RULES_BLOCK = `${BLOCK_START}\n## Search the team playbook before asking a human\n\n${KNOWLEDGE_RULES_TEXT}\n\n## When ask reports an update\n\n${UPDATE_RULE}\n${BLOCK_END}`;

/**
 * The rules file for an assistant, or null when it has none ask can write.
 * @param {string} id @param {import('./sys.js').Sys} sys
 */
export function rulesFile(id, sys) {
  if (id !== 'codex') return null;
  const P = pathFor(sys.platform);
  const home = sys.env.CODEX_HOME || P.join(sys.homedir, '.codex');
  const override = P.join(home, 'AGENTS.override.md');
  try {
    if (sys.fs.statSync(override).size > 0) return override;
  } catch {}
  return P.join(home, 'AGENTS.md');
}

/** Text with the block put in (replacing an old one) or removed. @param {string} text @param {string|null} block */
export function withBlock(text, block) {
  const re = new RegExp(`\\n?${BLOCK_START.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}[\\s\\S]*?${BLOCK_END.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\n?`);
  if (re.test(text)) {
    if (block === null) return text.replace(re, '\n').replace(/^\n+/, '').replace(/\n{3,}/g, '\n\n');
    return text.replace(re, `\n${block}\n`).replace(/^\n+/, '');
  }
  if (block === null) return text;
  const body = text.replace(/\s+$/, '');
  return body ? `${body}\n\n${block}\n` : `${block}\n`;
}

/**
 * Add or update the block. Backs the old file up first; no write when nothing changes.
 * @param {import('./sys.js').Sys} sys @param {string} file
 */
export function installRules(sys, file) {
  let old = '';
  try {
    old = sys.fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (/** @type {any} */ (e).code !== 'ENOENT') throw e;
  }
  const next = withBlock(old, RULES_BLOCK);
  const r = writeTextWithBackup(sys, file, next, old);
  return { changed: r.changed, backup: r.backup };
}

/**
 * Remove the block (and the file if it held nothing else and we created it, i.e. is now empty).
 * @param {import('./sys.js').Sys} sys @param {string} file
 */
export function removeRules(sys, file) {
  let old;
  try {
    old = sys.fs.readFileSync(file, 'utf8');
  } catch {
    return { changed: false, backup: null };
  }
  if (!old.includes(BLOCK_START)) return { changed: false, backup: null };
  const next = withBlock(old, null);
  if (!next.trim()) {
    sys.fs.rmSync(file);
    return { changed: true, backup: null };
  }
  return writeTextWithBackup(sys, file, next, old);
}

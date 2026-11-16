// @ts-check
// The playbook step of `ask setup`, `ask knowledge sync` and `ask doctor`
// (brief 26). It never fails the caller: no access, no `gh`, no network, an old
// hub, a failed pull: each is one line and the set-up carries on.
import { createClient } from '../client.js';
import { fetchSources, syncSources, syncLine, readManifest, knowledgeDir, KNOWLEDGE_RULES_TEXT } from '../knowledge.js';
import { ASSISTANTS } from './assistants/index.js';
import { rulesFile, installRules, removeRules } from './rules.js';

/**
 * Put the "search the playbook first" sentences where each detected assistant
 * reads its own rules. Codex gets a marked block in its AGENTS.md; Cursor has
 * no user-level rules file, so she is shown the text to paste once.
 * @param {import('./sys.js').Sys} sys
 */
export function installAssistantRules(sys) {
  for (const a of ASSISTANTS) {
    let present = false;
    try {
      present = a.detect(sys);
    } catch {}
    if (!present) continue;
    const file = rulesFile(a.id, sys);
    if (file) {
      try {
        const r = installRules(sys, file);
        sys.err(r.changed ? `${a.label}: playbook rule written to ${file}${r.backup ? ` (previous file kept as ${r.backup})` : ''}` : `${a.label}: playbook rule already in ${file}`);
      } catch (e) {
        sys.err(`warn  ${a.label}: could not write the playbook rule (${/** @type {Error} */ (e).message}); carrying on`);
      }
    } else if (a.id === 'cursor') {
      sys.err('Cursor keeps its user-level rules only in its settings (Settings → Rules), so ask cannot write them. To make it search the playbook first, paste this there once:');
      sys.err('');
      sys.err(`  ${KNOWLEDGE_RULES_TEXT}`);
      sys.err('');
    }
  }
}

/**
 * @param {import('./sys.js').Sys} sys @param {string|null} hubUrl
 * @param {{ pullOnly?: boolean, quiet?: boolean }} [o]
 * @returns {Promise<{ results: Awaited<ReturnType<typeof syncSources>>, note: string|null }>}
 */
export async function runKnowledgeStep(sys, hubUrl, o = {}) {
  try {
    /** @type {{ name: string, repo: string, ref: string, kind: string }[]} */
    let sources = [];
    let note = null;
    if (hubUrl && !o.pullOnly) {
      const client = createClient({ hubUrl, via: 'cli', retryDelaysMs: [500] });
      const r = await fetchSources(client);
      if (r.ok) sources = r.sources;
      else {
        note = `the playbook sources could not be listed (${r.reason})`;
        sources = readManifest(sys);
      }
    } else sources = readManifest(sys);
    if (!sources.length) {
      if (!o.quiet) sys.err(note ? `warn  playbook: ${note}; carrying on` : 'No team knowledge sources are configured on the hub; nothing to copy.');
      return { results: [], note };
    }
    const results = await syncSources(sys, sources, { pullOnly: o.pullOnly || (note !== null) });
    if (!o.quiet) {
      if (note) sys.err(`warn  playbook: ${note}; refreshed the copies already here`);
      for (const r of results) sys.err(syncLine(r));
    }
    if (!o.pullOnly && results.some((r) => r.state === 'cloned' || r.state === 'updated' || r.state === 'current')) installAssistantRules(sys);
    return { results, note };
  } catch (e) {
    if (!o.quiet) sys.err(`warn  playbook: skipped (${/** @type {Error} */ (e).message}); carrying on`);
    return { results: [], note: String(/** @type {Error} */ (e).message) };
  }
}

/**
 * For `ask setup --unregister`: remove the rules blocks and the local copy.
 * @param {import('./sys.js').Sys} sys
 */
export function removeKnowledge(sys) {
  for (const a of ASSISTANTS) {
    try {
      if (!a.detect(sys)) continue;
      const file = rulesFile(a.id, sys);
      if (!file) continue;
      const r = removeRules(sys, file);
      if (r.changed) sys.err(`${a.label}: playbook rule removed from ${file}`);
    } catch (e) {
      sys.err(`${a.label}: could not remove the playbook rule: ${/** @type {Error} */ (e).message}`);
    }
  }
  const dir = knowledgeDir(sys);
  if (sys.fs.existsSync(dir)) {
    sys.fs.rmSync(dir, { recursive: true, force: true });
    sys.err(`deleted the local playbook copy ${dir}`);
  }
}

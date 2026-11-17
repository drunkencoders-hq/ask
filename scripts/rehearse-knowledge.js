#!/usr/bin/env node
// @ts-check
// Rehearsal of the team-playbook copy (brief 26) with nothing real: stub
// `gh` clones from local fixture repos (placeholder org), a throwaway HOME, the
// stub hub listing the sources (contract change 8). Nothing is cloned from any
// real organisation and nothing leaves this machine.
//
//   npm run rehearse:knowledge                   the default: both sources, read-only, search, instructions
//   npm run rehearse:knowledge -- no-access | pull-fails | stale | all
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startStubHub } from '../test/stub-hub.js';
import { tempEnv, runCli, CLI } from '../test/helpers.js';
import { writeStubBin } from '../test/fixtures/stub-bin.js';
import { makeFixtureRepos, SOURCES, TEAM_HUB_REPO } from '../test/fixtures/knowledge-fixture.js';
import { KNOWLEDGE_INSTRUCTIONS } from '../src/knowledge.js';

/** @param {string} cwd @param {string[]} args */
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** @param {string} name */
async function rehearse(name) {
  const hub = await startStubHub({ knowledge: SOURCES });
  const t = tempEnv(hub.url);
  const home = path.join(t.dir, 'home');
  fs.mkdirSync(home);
  makeFixtureRepos(path.join(t.dir, 'remote'));
  const stubBin = writeStubBin(path.join(t.dir, 'stubs'));
  const nodeBin = path.join(t.dir, 'nodebin');
  fs.mkdirSync(nodeBin);
  fs.symlinkSync(process.execPath, path.join(nodeBin, 'node'));
  Object.assign(t.env, {
    HOME: home,
    PATH: [stubBin, nodeBin, '/usr/bin', '/bin'].join(path.delimiter),
    STUB_KNOWLEDGE_ROOT: path.join(t.dir, 'remote'),
    ...(name === 'no-access' ? { STUB_GH_NO_ACCESS: TEAM_HUB_REPO } : {}),
  });
  delete t.env.CODEX_HOME;
  const cache = path.join(t.env.XDG_STATE_HOME, 'drunkencoders', 'ask', 'knowledge');
  const run = (/** @type {string[]} */ a) => runCli(a, t).done;
  /** @type {string[]} */
  const problems = [];
  let summary = '';
  try {
    const setup = await run(['setup', '--hub', hub.url]);
    if (setup.code !== 0) problems.push(`set-up exit ${setup.code}`);
    if (name === 'no-access') {
      const cloned = SOURCES.filter((s) => fs.existsSync(path.join(cache, s.name, '.git'))).length;
      if (cloned !== 1) problems.push(`${cloned} sources cloned, expected 1`);
      if (!/warn {2}team-hub .*could not clone/.test(setup.stderr)) problems.push('no warning for the source without access');
      const d = await run(['doctor']);
      if (!/^warn {2}Playbook team-hub: not on this machine/m.test(d.stdout)) problems.push('doctor did not warn');
      if (d.code !== 0) problems.push(`doctor exit ${d.code}`);
      summary = `KNOWLEDGE no-access OK: 1 source cloned, team-hub skipped with a warning, set-up exit ${setup.code}, doctor warns and exits ${d.code}`;
    } else if (name === 'pull-fails') {
      fs.renameSync(path.join(t.dir, 'remote'), path.join(t.dir, 'remote-away'));
      const s = await run(['knowledge', 'sync']);
      if (!/could not update \(.*\); the old copy is kept/.test(s.stderr)) problems.push('no "old copy is kept" line');
      const hit = await run(['playbook', 'which database should I use']);
      if (!/\[stack-database-neon\]/.test(hit.stdout)) problems.push('the old copy no longer answers');
      summary = `KNOWLEDGE pull-fails OK: pull failed (exit ${s.code}), the old copy is kept and still answers`;
    } else if (name === 'stale') {
      const old = new Date(Date.now() - 20 * 86_400_000);
      for (const s of SOURCES) fs.utimesSync(path.join(cache, s.name, '.git', 'ask-synced'), old, old);
      const hit = await run(['playbook', 'which database should I use']);
      if (!/Note: The playbook copy is 20 days old \(more than 14 days\)/.test(hit.stdout)) problems.push('stale copy not flagged');
      if (!/\[stack-database-neon\]/.test(hit.stdout)) problems.push('the hit was dropped');
      summary = 'KNOWLEDGE stale OK: a copy 20 days old is flagged in the search result, the hit is still returned';
    } else {
      const cloned = SOURCES.filter((s) => fs.existsSync(path.join(cache, s.name, '.git')));
      if (cloned.length !== 2) problems.push(`${cloned.length} sources cloned, expected 2`);
      // Read-only: no push can succeed from either copy.
      let pushes = 0;
      for (const s of cloned) {
        const dir = path.join(cache, s.name);
        try {
          git(dir, ['push', 'origin', 'main']);
          pushes += 1;
        } catch {}
        if (git(dir, ['remote', 'get-url', '--push', 'origin']).includes('file://')) pushes += 1;
      }
      if (pushes) problems.push(`${pushes} push(es) possible`);
      // Search: three questions, three expected entries.
      const expect = [
        ['which database should I use', 'stack-database-neon'],
        ['deploy the api to render', 'recipe-api-on-render'],
        ['when should I ask the mentor', 'pattern-asking-the-mentor'],
      ];
      let found = 0;
      for (const [q, id] of expect) {
        const r = await run(['playbook', q]);
        if (new RegExp(`1\\. \\[${id}\\]`).test(r.stdout)) found += 1;
        else problems.push(`"${q}" did not put ${id} first`);
      }
      // The instruction reaches the assistant.
      const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, 'mcp'], env: /** @type {Record<string,string>} */ (t.env), cwd: t.cwd, stderr: 'pipe' });
      const client = new Client({ name: 'rehearse', version: '0.0.0' });
      await client.connect(transport);
      const instr = client.getInstructions() ?? '';
      await client.close();
      const instrOk = instr.startsWith(`${KNOWLEDGE_INSTRUCTIONS}\n\n`) && /search the team playbook with `playbook_search`/.test(instr);
      if (!instrOk) problems.push('instructions missing from the MCP server');
      summary = `KNOWLEDGE OK: ${cloned.length} sources cloned read-only, search found ${found} of ${expect.length} expected entries, instructions ${instrOk ? 'present' : 'MISSING'}, ${pushes} pushes possible`;
    }
  } finally {
    await hub.close();
    t.cleanup();
  }
  if (problems.length) {
    process.stdout.write(`KNOWLEDGE ${name} FAILED: ${problems.join('; ')}\n`);
    return false;
  }
  process.stdout.write(summary + '\n');
  return true;
}

const SCENARIOS = ['default', 'no-access', 'pull-fails', 'stale'];
const pick = process.argv[2] ?? 'default';
const names = pick === 'all' ? SCENARIOS : [pick];
let ok = true;
for (const n of names) {
  if (!SCENARIOS.includes(n)) {
    process.stderr.write(`unknown scenario ${n}; one of: ${SCENARIOS.join(', ')}, all\n`);
    process.exit(2);
  }
  ok = (await rehearse(n)) && ok;
}
process.exit(ok ? 0 : 1);

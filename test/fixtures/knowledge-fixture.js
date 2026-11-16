// @ts-check
// Fixture repositories for the knowledge tests: a playbook with ten entries
// and a team-hub repo with the org README, as local git repos that the stub
// `gh repo clone` clones from. Placeholder names only (demo-org).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const ORG = 'demo-org';
export const PLAYBOOK_REPO = `${ORG}/playbook`;
export const TEAM_HUB_REPO = `${ORG}/team-hub-docs`;

export const SOURCES = [
  { name: 'playbook', repo: PLAYBOOK_REPO, ref: 'main', kind: 'playbook' },
  { name: 'team-hub', repo: TEAM_HUB_REPO, ref: 'main', kind: 'team-hub' },
];

/** [folder, id, title, applies_to, summary, body] */
const ENTRIES = [
  ['stack', 'stack-database-neon', 'Postgres on Neon, not Render\'s or Supabase\'s free databases', 'web-app, saas, ai-app, api-only', 'Use a Neon Postgres database; the free databases of other hosts expire or pause.', 'Create the database in Neon and put the pooled connection string in DATABASE_URL.\n\nWhy: Render\'s free Postgres is deleted after 30 days.'],
  ['stack', 'stack-web-app', 'The default web app stack (Next.js + Tailwind on Vercel, FastAPI on Render, Neon)', 'web-app, saas, ai-app', 'Next.js and Tailwind on Vercel, a FastAPI API on Render, Postgres on Neon.', 'The web app talks to the API over one base URL.\n\nStart from the template repository.'],
  ['stack', 'stack-website-framework', 'Websites and redesigns are Astro + Tailwind', 'website', 'A marketing website is built with Astro and Tailwind, hosted statically on Vercel.', 'Use Next.js only for app features. Plain HTML only for legacy hosting.'],
  ['patterns', 'pattern-env-example-and-secrets', 'Every setting in a commented .env.example; real values only in .env and the dashboards', 'all', 'Settings are documented in .env.example; secrets live in .env (ignored by git) and in the hosting dashboards.', 'Never commit a password, an API key or a token. If you see one in a diff, stop and tell the human.'],
  ['patterns', 'pattern-migrations', 'Schema changes go through append-only migrations committed with the code', 'web-app, saas, ai-app, api-only', 'Every schema change is a new Alembic migration, committed in the same pull request as the code.', 'Never edit a migration that was already applied.'],
  ['patterns', 'pattern-asking-the-mentor', 'When to stop and ask the mentor, and how', 'all', 'Ask the mentor before anything hard to undo or that costs money, and ask one complete question with options and a recommendation.', 'Ask when the scope is unclear, there is a real trade-off, or the step is hard to undo.'],
  ['recipes', 'recipe-api-on-render', 'Deploy the API to Render from a Blueprint (render.yaml)', 'web-app, saas, ai-app, api-only', 'Create the Render web service from render.yaml, set the environment variables in the dashboard, then deploy.', '1. Connect the repository.\n2. Choose the Blueprint.\n3. Add DATABASE_URL.'],
  ['recipes', 'recipe-first-deploy-order', 'First deploy of a web + API + database project, in order', 'web-app, saas, ai-app', 'Database first, then the API, then the web app, then the CORS origin.', 'Each step needs a value from the one before it.'],
  ['gotchas', 'gotcha-render-free-sleeps', 'Render free instances sleep after 15 minutes', 'web-app, api-only', 'The first request after a sleep takes about a minute; a health ping does not fix it.', 'Warn the people who will try the demo.'],
  ['gotchas', 'gotcha-pasted-values-and-secrets', 'A value pasted into chat or a file may be a secret', 'all', 'Treat every pasted token as a secret: do not echo it, do not commit it.', 'Rotate it if it leaked.'],
];

/** @param {string} cwd @param {string[]} args */
function git(cwd, args) {
  return execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
}

/** @param {string} root @param {string} repo @param {Record<string, string>} files */
function makeRepo(root, repo, files) {
  const dir = path.join(root, repo);
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'fixture']);
  return dir;
}

/** The text of one entry. @param {typeof ENTRIES[number]} e */
export function entryText(e) {
  return `---\nid: ${e[1]}\ntitle: ${e[2]}\napplies_to: [${e[3]}]\nsummary: ${e[4]}\nsources:\n  - template@abc123:AGENTS.md\nconfidence: Jose said\nstatus: approved\n---\n${e[5]}\n`;
}

/**
 * Create both fixture repos under `root`; returns their folders.
 * @param {string} root
 */
export function makeFixtureRepos(root) {
  /** @type {Record<string, string>} */
  const files = { 'README.md': '# playbook\n\nShort, sourced entries.\n', 'INDEX.md': '# Index\n\n| id |\n' };
  for (const e of ENTRIES) files[`${e[0]}/${e[1]}.md`] = entryText(e);
  files['scripts/check'] = '#!/bin/sh\necho "this must never be run by ask"\n> /tmp/ask-fixture-ran\n';
  const playbook = makeRepo(root, PLAYBOOK_REPO, files);
  const teamHub = makeRepo(root, TEAM_HUB_REPO, {
    'profile/README.md': '# Demo team\n\nHow we work: small pull requests, one mentor per newcomer, a weekly demo on Friday.\n',
  });
  return { playbook, teamHub };
}

/** Add a new entry to the fixture playbook and commit it. @param {string} playbookDir */
export function addEntry(playbookDir, id = 'pattern-new-thing', title = 'A brand new pattern about caching') {
  fs.writeFileSync(path.join(playbookDir, 'patterns', `${id}.md`), entryText(['patterns', id, title, 'all', 'Cache the slow thing.', 'Use a cache.']));
  git(playbookDir, ['add', '-A']);
  git(playbookDir, ['commit', '-q', '-m', 'new entry']);
}

// @ts-check
import { realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checkoutGit } from './gitinfo.js';

const TEAM_FOLDER = ['drunkencoders', 'sandbox'];
const REPO = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?\/sandbox$/i;
const GITHUB_ORIGIN = /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([a-z0-9-]+\/sandbox)(?:\.git)?\/?$/i;

/** @param {string} value @param {string} home */
function localPath(value, home) {
  if (/[\x00-\x1f\x7f]/.test(value)) return null;
  if (value === '~') return home;
  if (value.startsWith('~/')) return path.resolve(home, `./${value.slice(2)}`);
  return path.isAbsolute(value) ? path.normalize(value) : null;
}

/** @param {string} cwd @param {string} repo */
async function inspect(cwd, repo) {
  try {
    if (!(await stat(cwd)).isDirectory()) return 'no_match';
    // Only a repository or linked worktree right here qualifies. Do not let
    // Git discover a checkout in an ancestor of the given location.
    await stat(path.join(cwd, '.git'));
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'no_match' : 'unknown';
  }
  try {
    const top = await checkoutGit('root', cwd);
    const root = top.stdout.replace(/\r?\n$/, '');
    if (top.code !== 0 || !path.isAbsolute(root)) return 'unknown';
    if ((await realpath(root)) !== (await realpath(cwd))) return 'no_match';

    // Read the configured URL before accepting Git's effective one. A local
    // insteadOf rule must not make a lookalike or local path pass the check.
    const raw = await checkoutGit('configuredOrigin', cwd);
    if (raw.code === 1 && !raw.stdout) return 'no_match';
    if (raw.code !== 0 || !raw.stdout.endsWith('\0')) return 'unknown';
    const urls = raw.stdout.slice(0, -1).split('\0');
    if (urls.length !== 1) return 'unknown';
    const url = urls[0];
    if (url !== url.trim() || GITHUB_ORIGIN.exec(url)?.[1].toLowerCase() !== repo) return 'no_match';

    const effective = await checkoutGit('effectiveOrigin', cwd);
    if (effective.code !== 0) return 'unknown';
    return effective.stdout.replace(/\r?\n$/, '') === url ? 'match' : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * The caller must have the local user's explicit permission for this check
 * and its locations. Do not inspect anything before that affirmation.
 * @param {{ consent?: boolean, repo?: string, projectsRoot?: string, checkout?: string }} options
 */
export async function checkCheckout(options) {
  if (options.consent !== true) return { status: 'consent_required' };
  if (!options.repo || options.repo !== options.repo.trim() || !REPO.test(options.repo)) return { status: 'unknown' };
  const repo = options.repo.toLowerCase();
  const home = os.homedir();
  const projectsRoot = options.projectsRoot === undefined ? undefined : localPath(options.projectsRoot, home);
  const checkout = options.checkout === undefined ? undefined : localPath(options.checkout, home);
  if (projectsRoot === null || checkout === null) return { status: 'unknown' };

  const expected = projectsRoot
    ? [{ directory: path.join(projectsRoot, ...TEAM_FOLDER), label: 'confirmed_projects' }]
    : [
        { directory: path.join(home, 'Desktop', 'Projects', ...TEAM_FOLDER), label: 'desktop_projects' },
        { directory: path.join(home, 'Projects', ...TEAM_FOLDER), label: 'home_projects' },
      ];
  const results = await Promise.all(expected.map(({ directory }) => inspect(directory, repo)));
  if (results.includes('match')) return { status: 'ready' };

  const checked = expected.map(({ label }) => label);
  if (checkout && !expected.some(({ directory }) => directory === checkout)) {
    const elsewhere = await inspect(checkout, repo);
    if (elsewhere === 'match') return { status: 'elsewhere' };
    if (elsewhere === 'unknown') return { status: 'unknown' };
    checked.push('supplied_checkout');
  }
  if (results.includes('unknown')) return { status: 'unknown' };
  return { status: 'missing', checked };
}

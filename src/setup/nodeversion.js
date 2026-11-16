// @ts-check
// Which Node suits the team's website starter (Astro): an even-numbered
// release (an LTS line) of 22 or newer. `ask` itself needs only Node >= 20,
// so a Node that works for `ask` but not for the starter gets a warning,
// never a replacement. The same wording is used by `ask doctor`, bootstrap.sh
// (its own copy of these two constants, kept in step by a test) and
// bootstrap.ps1.

/** The even-numbered Node the website starter needs, as a minimum. */
export const STARTER_NODE_MIN_MAJOR = 22;

/**
 * Pinned fallback Homebrew formula when the newest even-numbered one cannot be
 * derived (offline, or a formula that does not exist yet). An LTS line that is
 * neither deprecated nor disabled; listed in the README. Update on purpose.
 */
export const NODE_FALLBACK_FORMULA = 'node@24';

/** winget package for an LTS Node on Windows. */
export const WINGET_NODE_LTS = 'OpenJS.NodeJS.LTS';

/** @param {string} v "v23.11.1" or "23.11.1" @returns {number|null} */
export function nodeMajor(v) {
  const m = /^v?(\d+)\./.exec(String(v).trim());
  return m ? Number(m[1]) : null;
}

/** Suits the website starter: even-numbered and 22 or newer. @param {string} v */
export function suitsStarter(v) {
  const major = nodeMajor(v);
  return major !== null && major % 2 === 0 && major >= STARTER_NODE_MIN_MAJOR;
}

/**
 * A version manager that appears to supply this Node, from the path of the
 * binary. Detected only to name it in the warning; never touched.
 * @param {string} nodePath @returns {null | 'nvm' | 'fnm' | 'asdf' | 'Volta'}
 */
export function versionManager(nodePath) {
  const p = String(nodePath).replace(/\\/g, '/');
  if (/\/\.nvm\//.test(p)) return 'nvm';
  if (/\/(\.fnm|fnm_multishells|\.local\/share\/fnm)\//.test(p) || /\/fnm\//.test(p)) return 'fnm';
  if (/\/\.asdf\//.test(p)) return 'asdf';
  if (/\/\.volta\//.test(p) || /\/Volta\//.test(p)) return 'Volta';
  return null;
}

/**
 * The one command that installs a suitable Node.
 * @param {string} platform @param {null | 'nvm' | 'fnm' | 'asdf' | 'Volta'} manager
 */
export function installCommand(platform, manager) {
  const major = Number(NODE_FALLBACK_FORMULA.split('@')[1]);
  if (manager === 'nvm') return `nvm install ${major} && nvm alias default ${major}`;
  if (manager === 'fnm') return `fnm install ${major} && fnm default ${major}`;
  if (manager === 'asdf') return `asdf install nodejs latest:${major} && asdf set -u nodejs latest:${major}`;
  if (manager === 'Volta') return `volta install node@${major}`;
  if (platform === 'win32') return `winget install --id ${WINGET_NODE_LTS} --exact`;
  return `brew install ${NODE_FALLBACK_FORMULA} && brew link --overwrite --force ${NODE_FALLBACK_FORMULA}`;
}

/**
 * The warning for a Node that is fine for `ask` but not for the starter, or
 * null when it suits (or is too old: that is a failure elsewhere).
 * @param {string} version @param {string} platform @param {string} [nodePath]
 * @returns {string|null}
 */
export function starterNodeWarning(version, platform, nodePath = '') {
  const major = nodeMajor(version);
  if (major === null || suitsStarter(version)) return null;
  const v = String(version).replace(/^v?/, 'v');
  const manager = versionManager(nodePath);
  return `Node ${v} works for \`ask\`, but the website starter needs an even-numbered Node ${STARTER_NODE_MIN_MAJOR} or newer. ${manager ? `${manager} supplies this Node; to switch` : 'To install one'} (your current Node is left as it is): ${installCommand(platform, manager)}`;
}

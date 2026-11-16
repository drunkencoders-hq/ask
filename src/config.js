// @ts-check
// Where the hub lives. ASK_HUB_URL wins; otherwise `hub_url` in the config
// file. Platform, env and home directory are injected so tests can simulate
// Windows on a Mac (never read process.platform deep inside).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * @typedef {{ platform?: string, env?: Record<string, string|undefined>, homedir?: string }} Platform
 */

/** @param {Platform} [p] */
export function platformDefaults(p = {}) {
  return {
    platform: p.platform ?? process.platform,
    env: p.env ?? process.env,
    homedir: p.homedir ?? os.homedir(),
  };
}

/** @param {string} platform */
export function pathFor(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

/**
 * macOS / other POSIX: $XDG_CONFIG_HOME/drunkencoders/ask.json, else ~/.config/drunkencoders/ask.json
 * Windows: %APPDATA%\drunkencoders\ask.json, else <home>\AppData\Roaming\drunkencoders\ask.json
 * @param {Platform} [p]
 */
export function configFilePath(p) {
  const { platform, env, homedir } = platformDefaults(p);
  const P = pathFor(platform);
  if (platform === 'win32') {
    const base = env.APPDATA || P.join(homedir, 'AppData', 'Roaming');
    return P.join(base, 'drunkencoders', 'ask.json');
  }
  const base = env.XDG_CONFIG_HOME || P.join(homedir, '.config');
  return P.join(base, 'drunkencoders', 'ask.json');
}

export class ConfigError extends Error {}

/**
 * @param {Platform} [p]
 * @returns {{ hubUrl: string, source: string, configPath: string }}
 */
export function resolveHubUrl(p) {
  const d = platformDefaults(p);
  const configPath = configFilePath(d);
  const fromEnv = (d.env.ASK_HUB_URL || '').trim();
  if (fromEnv) return { hubUrl: normalise(fromEnv, 'ASK_HUB_URL'), source: 'ASK_HUB_URL', configPath };

  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (e) {
    if (/** @type {any} */ (e).code === 'ENOENT') {
      throw new ConfigError(
        `No hub address configured: ASK_HUB_URL is not set and ${configPath} does not exist. Run \`ask setup\` first.`,
      );
    }
    throw new ConfigError(`Cannot read ${configPath}: ${/** @type {Error} */ (e).message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new ConfigError(`${configPath} is not valid JSON: ${/** @type {Error} */ (e).message}. Run \`ask setup\` again.`);
  }
  const url = typeof parsed?.hub_url === 'string' ? parsed.hub_url.trim() : '';
  if (!url) {
    throw new ConfigError(`${configPath} has no "hub_url". Run \`ask setup\` first.`);
  }
  return { hubUrl: normalise(url, configPath), source: configPath, configPath };
}

/** @param {string} url @param {string} where */
function normalise(url, where) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new ConfigError(`Hub address from ${where} is not a valid URL: ${url}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new ConfigError(`Hub address from ${where} must be http(s): ${url}`);
  }
  return u.toString().replace(/\/+$/, '');
}

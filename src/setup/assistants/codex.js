// @ts-check
// Codex CLI: `codex mcp add ask -- <command> <args…>` writes the global
// $CODEX_HOME/config.toml (default ~/.codex/config.toml) as [mcp_servers.ask].
// Docs: https://learn.chatgpt.com/docs/extend/mcp?surface=cli
// Source (subcommands): https://github.com/openai/codex/blob/main/codex-rs/cli/src/mcp_cmd.rs
import { pathFor } from '../../config.js';
import { sameSpec } from './common.js';
import { cliBacked, SERVER_NAME } from './cli-backed.js';

/** @param {import('../sys.js').Sys} sys */
function configPath(sys) {
  const P = pathFor(sys.platform);
  const home = sys.env.CODEX_HOME || P.join(sys.homedir, '.codex');
  return P.join(home, 'config.toml');
}

/** Parse one TOML string value: "basic" (JSON-compatible escapes) or 'literal'. */
function tomlString(s) {
  s = s.trim();
  if (s.startsWith("'")) return s.slice(1, s.indexOf("'", 1));
  if (s.startsWith('"')) {
    const m = /^"((?:[^"\\]|\\.)*)"/.exec(s);
    if (m) return JSON.parse(`"${m[1]}"`);
  }
  return null;
}

/** @param {string} s */
function tomlStringArray(s) {
  s = s.trim();
  if (!s.startsWith('[')) return null;
  const out = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'/g;
  let m;
  const body = s.slice(1, s.lastIndexOf(']'));
  while ((m = re.exec(body))) out.push(m[1] !== undefined ? JSON.parse(`"${m[1]}"`) : m[2]);
  return out;
}

/**
 * Read `[mcp_servers.ask]` from config.toml text (just command and args).
 * @param {string} text
 */
export function readCodexEntry(text) {
  const lines = text.split(/\r?\n/);
  const header = new RegExp(`^\\s*\\[\\s*mcp_servers\\s*\\.\\s*(?:${SERVER_NAME}|"${SERVER_NAME}")\\s*\\]\\s*(#.*)?$`);
  const start = lines.findIndex((l) => header.test(l));
  if (start < 0) return null;
  /** @type {{ command?: string|null, args?: string[]|null }} */
  const e = {};
  for (let i = start + 1; i < lines.length && !/^\s*\[/.test(lines[i]); i++) {
    const m = /^\s*([A-Za-z_]+)\s*=\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    if (m[1] === 'command') e.command = tomlString(m[2]);
    if (m[1] === 'args') e.args = tomlStringArray(m[2]);
  }
  return e;
}

export default cliBacked({
  id: 'codex',
  label: 'Codex CLI',
  bin: 'codex',
  docs: {
    darwin: 'https://learn.chatgpt.com/docs/extend/mcp?surface=cli',
    win32: 'https://learn.chatgpt.com/docs/extend/mcp?surface=cli',
  },
  configPath,
  status(sys, spec) {
    let text;
    try {
      text = sys.fs.readFileSync(configPath(sys), 'utf8');
    } catch {
      return 'absent';
    }
    const e = readCodexEntry(text);
    if (!e) return 'absent';
    return sameSpec(e, spec) ? 'registered' : 'different';
  },
  addArgs: (spec) => ['mcp', 'add', SERVER_NAME, '--', spec.command, ...spec.args],
  removeArgs: ['mcp', 'remove', SERVER_NAME],
});

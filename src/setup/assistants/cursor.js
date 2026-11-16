// @ts-check
// Cursor: no CLI for MCP registration; edit the global ~/.cursor/mcp.json
// (%USERPROFILE%\.cursor\mcp.json on Windows).
import { pathFor } from '../../config.js';
import { SERVER_NAME, readJson, writeJsonWithBackup, jsonStatus } from './common.js';

/** @type {import('./common.js').Assistant} */
export default {
  id: 'cursor',
  label: 'Cursor',
  docs: {
    darwin: 'https://cursor.com/docs/context/mcp',
    win32: 'https://cursor.com/docs/context/mcp',
  },
  configPath(sys) {
    return pathFor(sys.platform).join(sys.homedir, '.cursor', 'mcp.json');
  },
  detect(sys) {
    const P = pathFor(sys.platform);
    if (sys.which('cursor')) return true;
    const dirs = [P.join(sys.homedir, '.cursor')];
    if (sys.platform === 'darwin') dirs.push('/Applications/Cursor.app', P.join(sys.homedir, 'Applications', 'Cursor.app'));
    if (sys.platform === 'win32') dirs.push(P.join(sys.env.LOCALAPPDATA || P.join(sys.homedir, 'AppData', 'Local'), 'Programs', 'cursor'));
    return dirs.some((d) => {
      try {
        return sys.fs.statSync(d).isDirectory();
      } catch {
        return false;
      }
    });
  },
  status(sys, spec) {
    return jsonStatus(readJson(sys, this.configPath(sys)).data, spec);
  },
  async register(sys, spec) {
    const file = this.configPath(sys);
    const { data, raw } = readJson(sys, file);
    if (typeof data !== 'object' || Array.isArray(data) || data === null) throw new Error(`${file}: expected a JSON object`);
    const next = { ...data, mcpServers: { ...(data.mcpServers ?? {}), [SERVER_NAME]: { type: 'stdio', command: spec.command, args: spec.args } } };
    const w = writeJsonWithBackup(sys, file, next, raw);
    return { changed: w.changed, detail: w.changed ? `wrote ${file}${w.backup ? ` (backup ${w.backup})` : ''}` : `already in ${file}` };
  },
  async unregister(sys) {
    const file = this.configPath(sys);
    const { exists, data, raw } = readJson(sys, file);
    if (!exists || !data?.mcpServers?.[SERVER_NAME]) return { changed: false, detail: `not in ${file}` };
    const servers = { ...data.mcpServers };
    delete servers[SERVER_NAME];
    const w = writeJsonWithBackup(sys, file, { ...data, mcpServers: servers }, raw);
    return { changed: w.changed, detail: `removed from ${file}${w.backup ? ` (backup ${w.backup})` : ''}` };
  },
};

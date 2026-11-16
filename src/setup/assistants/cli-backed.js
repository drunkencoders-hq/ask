// @ts-check
// Assistants with their own `mcp add/remove` CLI. Registration goes through
// the CLI; status is read from the tool's config file (reading is cheaper and
// never starts other MCP servers, unlike `claude mcp get`).
import { pathFor } from '../../config.js';
import { SERVER_NAME } from './common.js';

/**
 * @param {{
 *   id: string, label: string, bin: string, docs: { darwin: string, win32: string },
 *   configPath: (sys: import('../sys.js').Sys) => string,
 *   status: (sys: import('../sys.js').Sys, spec: { command: string, args: string[] }) => 'registered'|'different'|'absent',
 *   addArgs: (spec: { command: string, args: string[] }) => string[],
 *   removeArgs: string[],
 * }} d
 * @returns {import('./common.js').Assistant}
 */
export function cliBacked(d) {
  return {
    id: d.id,
    label: d.label,
    docs: d.docs,
    configPath: d.configPath,
    status: d.status,
    detect(sys) {
      return !!sys.which(d.bin);
    },
    async register(sys, spec) {
      const st = d.status(sys, spec);
      if (st === 'registered') return { changed: false, detail: `already in ${d.configPath(sys)}` };
      if (st === 'different') {
        const rm = await sys.run(d.bin, d.removeArgs);
        if (rm.code !== 0) throw new Error(`\`${d.bin} ${d.removeArgs.join(' ')}\` failed: ${firstLine(rm)}`);
      }
      const args = d.addArgs(spec);
      const r = await sys.run(d.bin, args);
      if (r.code !== 0) throw new Error(`\`${d.bin} ${args.join(' ')}\` failed: ${firstLine(r)}`);
      return { changed: true, detail: `${d.bin} ${args.slice(0, 2).join(' ')} → ${d.configPath(sys)}` };
    },
    async unregister(sys) {
      if (d.status(sys, { command: '', args: [] }) === 'absent') return { changed: false, detail: `not in ${d.configPath(sys)}` };
      const r = await sys.run(d.bin, d.removeArgs);
      if (r.code !== 0) throw new Error(`\`${d.bin} ${d.removeArgs.join(' ')}\` failed: ${firstLine(r)}`);
      return { changed: true, detail: `removed with ${d.bin} ${d.removeArgs.join(' ')}` };
    },
  };
}

/** @param {import('../sys.js').RunResult} r */
function firstLine(r) {
  return ((r.stderr || r.stdout || r.error?.message || '').trim().split('\n')[0] || `exit ${r.code}`).slice(0, 300);
}

/** @param {import('../sys.js').Sys} sys @param {...string} parts */
export function homeJoin(sys, ...parts) {
  return pathFor(sys.platform).join(sys.homedir, ...parts);
}

export { SERVER_NAME };

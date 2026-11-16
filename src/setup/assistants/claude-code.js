// @ts-check
// Claude Code: `claude mcp add --transport stdio --scope user ask -- <command> <args…>`;
// user-scoped servers live in ~/.claude.json (top-level "mcpServers").
// Docs: https://code.claude.com/docs/en/mcp
import { readJson, jsonStatus } from './common.js';
import { cliBacked, homeJoin, SERVER_NAME } from './cli-backed.js';

export default cliBacked({
  id: 'claude-code',
  label: 'Claude Code',
  bin: 'claude',
  docs: { darwin: 'https://code.claude.com/docs/en/mcp', win32: 'https://code.claude.com/docs/en/mcp' },
  configPath: (sys) => homeJoin(sys, '.claude.json'),
  status(sys, spec) {
    return jsonStatus(readJson(sys, homeJoin(sys, '.claude.json')).data, spec);
  },
  addArgs: (spec) => ['mcp', 'add', '--transport', 'stdio', '--scope', 'user', SERVER_NAME, '--', spec.command, ...spec.args],
  removeArgs: ['mcp', 'remove', '--scope', 'user', SERVER_NAME],
});

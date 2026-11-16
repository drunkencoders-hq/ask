// @ts-check
// Gemini CLI: `gemini mcp add -s user ask <command> <args…>` (default scope is
// project, so -s user is required); user settings in ~/.gemini/settings.json.
// Docs: https://geminicli.com/docs/tools/mcp-server/
import { readJson, jsonStatus } from './common.js';
import { cliBacked, homeJoin, SERVER_NAME } from './cli-backed.js';

export default cliBacked({
  id: 'gemini-cli',
  label: 'Gemini CLI',
  bin: 'gemini',
  docs: { darwin: 'https://geminicli.com/docs/tools/mcp-server/', win32: 'https://geminicli.com/docs/tools/mcp-server/' },
  configPath: (sys) => homeJoin(sys, '.gemini', 'settings.json'),
  status(sys, spec) {
    return jsonStatus(readJson(sys, homeJoin(sys, '.gemini', 'settings.json')).data, spec);
  },
  addArgs: (spec) => ['mcp', 'add', '-s', 'user', SERVER_NAME, spec.command, ...spec.args],
  removeArgs: ['mcp', 'remove', '-s', 'user', SERVER_NAME],
});

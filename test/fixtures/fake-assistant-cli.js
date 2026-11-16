// @ts-check
// Behaviour of the assistants' own `mcp add/remove` CLIs, close enough to the
// documented formats: Claude Code → ~/.claude.json, Gemini CLI →
// ~/.gemini/settings.json, Codex → $CODEX_HOME/config.toml. Used both by the
// stub executables (real fs) and by in-memory win32/darwin simulations.

/**
 * @param {'claude'|'gemini'|'codex'} tool @param {string[]} args
 * @param {{ fs: any, join: (...p: string[]) => string, home: string, env: Record<string, string|undefined> }} o
 * @returns {{ code: number, stdout: string, stderr: string }}
 */
export function fakeAssistantCli(tool, args, o) {
  const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
  const fail = (stderr) => ({ code: 1, stdout: '', stderr });
  const readJson = (file) => {
    try {
      return JSON.parse(o.fs.readFileSync(file, 'utf8'));
    } catch {
      return {};
    }
  };
  const writeJson = (file, data) => {
    o.fs.mkdirSync(file.slice(0, Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'))), { recursive: true });
    o.fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8'); // no trailing newline, like many tools
  };
  if (args[0] !== 'mcp') return fail(`stub ${tool}: unsupported ${args.join(' ')}`);
  const sub = args[1];

  if (tool === 'claude') {
    const file = o.join(o.home, '.claude.json');
    if (sub === 'add') {
      const i = args.indexOf('--');
      const pre = args.slice(2, i);
      if (pre.join(' ') !== '--transport stdio --scope user ask') return fail(`stub claude: unexpected options ${pre.join(' ')}`);
      const data = readJson(file);
      if (data.mcpServers?.ask) return fail('MCP server ask already exists in user config');
      data.mcpServers = { ...(data.mcpServers ?? {}), ask: { type: 'stdio', command: args[i + 1], args: args.slice(i + 2), env: {} } };
      writeJson(file, data);
      return ok('Added stdio MCP server ask to user config');
    }
    if (sub === 'remove') {
      const data = readJson(file);
      if (!data.mcpServers?.ask) return fail('No MCP server found with name: ask');
      delete data.mcpServers.ask;
      writeJson(file, data);
      return ok('Removed MCP server ask');
    }
  }

  if (tool === 'gemini') {
    const file = o.join(o.home, '.gemini', 'settings.json');
    if (sub === 'add') {
      if (args[2] !== '-s' || args[3] !== 'user' || args[4] !== 'ask') return fail(`stub gemini: unexpected ${args.join(' ')}`);
      const data = readJson(file);
      data.mcpServers = { ...(data.mcpServers ?? {}), ask: { command: args[5], args: args.slice(6) } };
      writeJson(file, data);
      return ok('MCP server "ask" added to user settings.');
    }
    if (sub === 'remove') {
      const data = readJson(file);
      if (!data.mcpServers?.ask) return ok('Server "ask" not found in user settings.');
      delete data.mcpServers.ask;
      writeJson(file, data);
      return ok('Server "ask" removed from user settings.');
    }
  }

  if (tool === 'codex') {
    const dir = o.env.CODEX_HOME || o.join(o.home, '.codex');
    const file = o.join(dir, 'config.toml');
    let text = '';
    try {
      text = o.fs.readFileSync(file, 'utf8');
    } catch {}
    const strip = (t) => t.replace(/\n?\[mcp_servers\.ask\]\n(?:(?!\[)[^\n]*\n?)*/g, '\n').replace(/^\n+/, '');
    if (sub === 'add') {
      const i = args.indexOf('--');
      if (args[2] !== 'ask' || i !== 3) return fail(`stub codex: unexpected ${args.join(' ')}`);
      const block = `[mcp_servers.ask]\ncommand = ${JSON.stringify(args[i + 1])}\nargs = [${args.slice(i + 2).map((a) => JSON.stringify(a)).join(', ')}]\n`;
      const base = strip(text);
      o.fs.mkdirSync(dir, { recursive: true });
      o.fs.writeFileSync(file, (base ? base.replace(/\n*$/, '\n\n') : '') + block, 'utf8');
      return ok("Added global MCP server 'ask'.");
    }
    if (sub === 'remove') {
      if (!/\[mcp_servers\.ask\]/.test(text)) return ok("No MCP server named 'ask' found.");
      o.fs.writeFileSync(file, strip(text), 'utf8');
      return ok("Removed global MCP server 'ask'.");
    }
  }
  return fail(`stub ${tool}: unsupported ${args.join(' ')}`);
}

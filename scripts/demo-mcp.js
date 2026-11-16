// @ts-check
// npm run demo:mcp: spawn `node src/cli.js mcp`, handshake over stdio, list
// tools, call `ask`; the stub hub answers after 2 s.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startStubHub } from '../test/stub-hub.js';
import { tempEnv, CLI, until } from '../test/helpers.js';

const hub = await startStubHub({ autoAnswerMs: 2000, autoAnswerText: 'JSON. One object per line, so it streams.' });
const t = tempEnv(hub.url);
const log = (m) => process.stdout.write(m + '\n');
let ok = false;
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [CLI, 'mcp'],
  env: /** @type {Record<string,string>} */ (t.env),
  cwd: t.cwd,
  stderr: 'inherit',
});
const client = new Client({ name: 'ask-demo', version: '0.0.0' });
try {
  await client.connect(transport);
  const sv = client.getServerVersion();
  log(`handshake: server ${sv?.name} ${sv?.version}, protocol ok`);
  const { tools } = await client.listTools();
  log(`tools: ${tools.map((x) => x.name).join(', ')}`);
  log('calling ask {question: "Should the export be CSV or JSON?", repo: "drunkencoders-hq/sandbox", wait_seconds: 30}');
  const r = await client.callTool(
    { name: 'ask', arguments: { question: 'Should the export be CSV or JSON?', repo: 'drunkencoders-hq/sandbox', wait_seconds: 30 } },
    undefined,
    { onprogress: (p) => log(`progress: ${p.message ?? p.progress}`) },
  );
  log('--- tool result ---');
  log(/** @type {any[]} */ (r.content).map((c) => c.text).join('\n'));
  log('-------------------');
  const id = [...hub.state.questions.keys()][0];
  await until(() => hub.get(id)?.status === 'delivered', 5000);
  ok = !r.isError && t.pending().length === 0;
} catch (e) {
  log(`error: ${/** @type {Error} */ (e).message}`);
} finally {
  await client.close();
  await hub.close();
  t.cleanup();
}
if (ok) log('DEMO OK: mcp answer delivered');
else {
  log('DEMO FAILED');
  process.exitCode = 1;
}

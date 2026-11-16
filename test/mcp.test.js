// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startStubHub } from './stub-hub.js';
import { tempEnv, CLI, until } from './helpers.js';

/** Start `node src/cli.js mcp` as a real stdio MCP server and connect a client. */
async function connect(t) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, 'mcp'],
    env: /** @type {Record<string,string>} */ (t.env),
    cwd: t.cwd,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'ask-test', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

/** @param {any} r */
const text = (r) => r.content.map((c) => c.text).join('\n');

test('MCP tools/list shows exactly ask, ask_resume and playbook_search', async () => {
  const hub = await startStubHub();
  const t = tempEnv(hub.url);
  const client = await connect(t);
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((x) => x.name).sort(), ['ask', 'ask_resume', 'playbook_search']);
    const ask = tools.find((x) => x.name === 'ask');
    assert.match(ask?.description ?? '', /owner/);
    assert.deepEqual(Object.keys(ask?.inputSchema.properties ?? {}).sort(), ['branch', 'context', 'project', 'question', 'repo', 'wait_seconds']);
  } finally {
    await client.close();
    await hub.close();
    t.cleanup();
  }
});

test('MCP ask returns pending; ask_resume returns the answer and the receipt follows', async () => {
  const hub = await startStubHub();
  const t = tempEnv(hub.url);
  const client = await connect(t);
  try {
    const r1 = await client.callTool({
      name: 'ask',
      arguments: { question: 'CSV or JSON?', repo: 'drunkencoders-hq/sandbox', wait_seconds: 1 },
    });
    const id = [...hub.state.questions.keys()][0];
    assert.equal(r1.isError, false);
    assert.match(text(r1), new RegExp(`PENDING: question ${id}`));
    assert.match(text(r1), /ask_resume/);
    assert.equal(hub.state.createBodies[0].client.via, 'mcp');

    hub.answer(id, 'JSON.');
    const r2 = await client.callTool({ name: 'ask_resume', arguments: { wait_seconds: 5 } });
    assert.equal(r2.isError, false);
    const out = text(r2);
    assert.match(out, new RegExp(`^ANSWER from jose \\(project sandbox, ${id}\\):\\nJSON\\.\\n`));
    assert.match(out, /answered_by: jose/);
    assert.match(out, /via: thread/);
    assert.match(out, /card: https:\/\//);
    await hub.waitForStatus(id, 'delivered');
    assert.deepEqual(hub.state.receiptBodies, [{ delivered_via: 'mcp' }]);
    await until(() => t.pending().length === 0);
  } finally {
    await client.close();
    await hub.close();
    t.cleanup();
  }
});

test('MCP ask: a hub refusal comes back as an error result with the hub message', async () => {
  const hub = await startStubHub();
  hub.state.projects.sandbox.owner = null;
  const t = tempEnv(hub.url);
  const client = await connect(t);
  try {
    const r = await client.callTool({ name: 'ask', arguments: { question: 'q?', project: 'sandbox', wait_seconds: 1 } });
    assert.equal(r.isError, true);
    assert.match(text(r), /no_owner_configured\): Project sandbox has no owner configured/);
  } finally {
    await client.close();
    await hub.close();
    t.cleanup();
  }
});

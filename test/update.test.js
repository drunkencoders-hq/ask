import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { VERSION, createClient } from '../src/client.js';
import { runCli, tempEnv } from './helpers.js';
import { startStubHub } from './stub-hub.js';

test('missing or malformed update advertisement stays quiet, including a missing metadata route', async () => {
  const latest = `${Number(VERSION.split('.')[0]) + 1}.0.0`;
  const t = tempEnv(null);
  try {
    for (const [header, expectedLookups] of [[null, 0], ['garbage', 0], [VERSION, 0], [latest, 1]]) {
      let lookups = 0;
      const seen = [];
      const client = createClient({
        hubUrl: 'http://ask-update.test',
        via: 'cli',
        updateState: { env: t.env },
        onAskUpdate: (update) => seen.push(update),
        fetchImpl: async (url) => {
          if (String(url).endsWith('/v1/ask-version')) {
            lookups += 1;
            return Response.json({ error: { code: 'not_found' } }, { status: 404 });
          }
          return Response.json({ teammate: 'nora' }, { headers: header ? { 'X-Ask-Latest': header } : {} });
        },
      });
      await Promise.all([client.whoami(), client.whoami()]);
      assert.equal(await client.askUpdate(), null);
      assert.equal(lookups, expectedLookups);
      assert.deepEqual(seen, []);
    }
  } finally {
    t.cleanup();
  }
});

test('announce validates locally, previews offline, prints live receipts, and repeats without a second post', async () => {
  const hub = await startStubHub();
  const t = tempEnv(hub.url);
  const file = path.join(t.dir, 'notice.md');
  const note = [
    '# See diagrams in ask', '', '## What changed', 'Answers can include diagrams.', '',
    '## Why you need to do something', 'Update to see them.', '',
    '## What to run', '```bash', '# The next line is a code comment', '## What changed', 'ask --version', '```', '',
    "## What you're learning", 'A version helps you identify the features you have.', '',
  ].join('\n');
  const args = ['announce', '--to', 'nora', '--to', 'all', '--file', file, '--ask-version', VERSION, '--update-command', 'npm install -g ask', '--mention', 'nora'];
  try {
    fs.writeFileSync(file, note);
    const noHub = { ...t, env: { ...t.env, ASK_HUB_URL: '' } };
    const dry = await runCli([...args, '--dry-run'], noHub).done;
    assert.equal(dry.code, 0, dry.stderr);
    assert.match(dry.stdout, /To: nora, all/);
    assert.ok(dry.stdout.includes(note.trim()));
    assert.equal(hub.state.requests.length, 0);

    fs.writeFileSync(file, note.replace(/## Why you need to do something\nUpdate to see them\.\n\n/, ''));
    const missing = await runCli(args, t).done;
    assert.equal(missing.code, 2, missing.stderr);
    assert.match(missing.stderr, /add a non-empty “Why you need to do something” section/);
    fs.writeFileSync(file, `${note}xoxb-fake\n`);
    const secret = await runCli(args, t).done;
    assert.equal(secret.code, 2, secret.stderr);
    assert.match(secret.stderr, /looks like it contains a secret/);
    assert.doesNotMatch(secret.stderr, /xoxb-fake/);
    assert.equal(hub.state.requests.length, 0);

    fs.writeFileSync(file, note);
    const refused = await runCli(args, t).done;
    assert.equal(refused.code, 5, refused.stderr);
    assert.match(refused.stderr.trim(), /^ask: hub error \(not_announcer\): [^\n]+$/);
    assert.equal(hub.state.notices.size, 0);

    hub.state.teammate = 'jose';
    const posted = await runCli([...args, '--json'], t).done;
    assert.equal(posted.code, 0, posted.stderr);
    const result = JSON.parse(posted.stdout);
    assert.equal(result.posted.length, 2);
    const repeated = await runCli([...args, '--json'], t).done;
    assert.equal(repeated.code, 0, repeated.stderr);
    assert.deepEqual(JSON.parse(repeated.stdout), result);
    assert.equal(hub.state.notices.size, 1);
    const listed = await runCli(['announce', '--list'], t).done;
    assert.equal(listed.code, 0, listed.stderr);
    assert.ok(listed.stdout.includes(`nora: current (${VERSION})`));
    assert.match(listed.stdout, /grish: unknown/);
    assert.match(listed.stdout, /https:\/\/example\.invalid\/archives\//);
  } finally {
    await hub.close();
    t.cleanup();
  }
});

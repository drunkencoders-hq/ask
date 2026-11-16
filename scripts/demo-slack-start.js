// @ts-check
// npm run demo:slack-start: nora forwarded a message to the bot in Slack and
// jose answered there. Her AI session has never seen the question; a bare
// `ask --resume` finds it on the hub, prints it and sends the receipt.
import { spawn } from 'node:child_process';
import { startStubHub } from '../test/stub-hub.js';
import { tempEnv, CLI } from '../test/helpers.js';

const hub = await startStubHub({ teammate: 'nora', mentors: { nora: 'jose' } });
const t = tempEnv(hub.url);
const id = hub.createSlackQuestion({
  question: 'Forwarded from Slack: can I use SQLite for the prototype?',
  answer: 'Yes, SQLite is fine until we need concurrent writers.',
  by: 'jose',
});
process.stderr.write(`demo: stub hub at ${hub.url} holds ${id} (source: slack, answered); local pending file: ${JSON.stringify(t.pending())}\n`);
process.stderr.write('demo: node src/cli.js --resume\n');
const child = spawn(process.execPath, [CLI, '--resume'], { env: t.env, cwd: t.cwd, stdio: ['ignore', 'inherit', 'inherit'] });
const code = await new Promise((resolve) => child.on('close', resolve));
const ok = code === 0 && hub.get(id)?.status === 'delivered' && hub.state.receiptBodies.length === 1;
await hub.close();
t.cleanup();
if (ok) process.stdout.write(`DEMO OK: slack-started question ${id} picked up and receipted\n`);
else {
  process.stdout.write(`DEMO FAILED: exit ${code}, hub status ${hub.get(id)?.status}\n`);
  process.exitCode = 1;
}

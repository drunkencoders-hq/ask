// @ts-check
// npm run demo:mentor: nora (a mentee) asks from a repo that is not a
// registered project; grish comments in the Slack thread; jose (her mentor)
// answers after 2 s. Stub hub on 127.0.0.1.
import { spawn } from 'node:child_process';
import { startStubHub } from '../test/stub-hub.js';
import { tempEnv, CLI } from '../test/helpers.js';

const hub = await startStubHub({ teammate: 'nora', mentors: { nora: 'jose' } });
const t = tempEnv(hub.url);
const q = 'Should the export be CSV or JSON?';
process.stderr.write(`demo: stub hub at ${hub.url}; nora's mentor is jose\n`);
process.stderr.write(`demo: node src/cli.js "${q}" --repo nora/side-project\n`);
const child = spawn(process.execPath, [CLI, q, '--repo', 'nora/side-project'], { env: t.env, cwd: t.cwd, stdio: ['ignore', 'inherit', 'inherit'] });
const id = await hub.waitForQuestion();
await hub.waitForStatus(id, 'posted');
hub.addComment(id, 'grish', 'Last time CSV broke on commas in addresses.');
process.stderr.write('demo: grish commented in the thread; jose answers in 2 seconds\n');
setTimeout(() => hub.answer(id, 'JSON. One object per line, so it streams.', 'jose'), 2000);
const code = await new Promise((resolve) => child.on('close', resolve));
const done = hub.get(id);
const ok = code === 0 && done?.status === 'delivered' && done.route === 'mentor' && done.comments.length === 1 && t.pending().length === 0;
await hub.close();
t.cleanup();
if (ok) process.stdout.write('DEMO OK: answer and 1 comment delivered, receipt recorded\n');
else {
  process.stdout.write(`DEMO FAILED: exit ${code}, hub status ${done?.status}\n`);
  process.exitCode = 1;
}

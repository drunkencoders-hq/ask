// @ts-check
// npm run demo: stub hub on 127.0.0.1, the CLI asks, the stub answers after 2 s.
import { spawn } from 'node:child_process';
import { startStubHub } from '../test/stub-hub.js';
import { tempEnv, CLI } from '../test/helpers.js';

const hub = await startStubHub({ autoAnswerMs: 2000, autoAnswerText: 'JSON. One object per line, so it streams.' });
const t = tempEnv(hub.url);
process.stderr.write(`demo: stub hub at ${hub.url}; it will answer after 2 seconds\n`);
const args = [CLI, 'Should the export be CSV or JSON?', '--repo', 'drunkencoders-hq/sandbox'];
process.stderr.write(`demo: node src/cli.js "Should the export be CSV or JSON?" --repo drunkencoders-hq/sandbox\n`);
const child = spawn(process.execPath, args, { env: t.env, cwd: t.cwd, stdio: ['ignore', 'inherit', 'inherit'] });
const code = await new Promise((resolve) => child.on('close', resolve));
const id = [...hub.state.questions.keys()][0];
const q = id && hub.get(id);
let ok = code === 0 && q?.status === 'delivered' && t.pending().length === 0;
await hub.close();
t.cleanup();
if (ok) {
  process.stdout.write(`DEMO OK: receipt recorded for ${id}\n`);
} else {
  process.stdout.write(`DEMO FAILED: exit ${code}, hub status ${q?.status ?? 'none'}\n`);
  process.exitCode = 1;
}

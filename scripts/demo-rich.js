// @ts-check
// npm run demo:rich: nora asks from a git work tree; her mentor sends a drafted
// answer (a script, two diagrams, an uploaded image, sources, caveats) through
// the stub hub on 127.0.0.1. Shows the answer, then checks what was saved and
// that nothing from the answer was run.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { startStubHub } from '../test/stub-hub.js';
import { tempEnv, CLI } from '../test/helpers.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const hub = await startStubHub({ teammate: 'nora', mentors: { nora: 'jose' } });
const t = tempEnv(hub.url);
execFileSync('git', ['init', '-q'], { cwd: t.cwd });
execFileSync('git', ['remote', 'add', 'origin', 'https://example.invalid/org/project.git'], { cwd: t.cwd });
const marker = path.join(t.dir, 'RAN-BY-ASK');
const q = 'How should we split auth and billing?';
process.stderr.write(`demo: stub hub at ${hub.url}; nora's mentor is jose; work tree ${t.cwd}\n`);
const child = spawn(process.execPath, [CLI, q], { env: t.env, cwd: t.cwd, stdio: ['ignore', 'inherit', 'inherit'] });
const id = await hub.waitForQuestion();
await hub.waitForStatus(id, 'posted');
process.stderr.write('demo: jose sends a drafted answer\n');
hub.answerDraft(id, {
  summary: 'Use two services.',
  body: 'Split auth from billing: they change at different speeds and have different owners.',
  scripts: [{ title: 'Create the folders', language: 'bash', runs_on: 'any', code: `touch "${marker}"\nmkdir -p services/auth services/billing`, what_it_does: 'Creates two empty folders and a marker file.', risk: 'changes-files' }],
  diagrams: [
    { title: 'How the pieces fit', mermaid: 'graph TD\n  Web-->Auth\n  Web-->Billing' },
    { title: 'Sign-in flow', mermaid: 'sequenceDiagram\n  User->>Auth: sign in\n  Auth-->>User: token' },
  ],
  sources: [{ kind: 'repo', path: 'docs/architecture.md', ref: 'main@abc1234' }],
  caveats: ['I did not run the migration.'],
  attachments: [
    { kind: 'diagram', filename: 'diagram-1-1.png', media_type: 'image/png', bytes: PNG, title: 'How the pieces fit', mermaid: 'graph TD\n  Web-->Auth\n  Web-->Billing' },
    { kind: 'diagram', filename: 'diagram-2-1.png', media_type: 'image/png', bytes: PNG, title: 'Sign-in flow', mermaid: 'sequenceDiagram\n  User->>Auth: sign in\n  Auth-->>User: token' },
    { kind: 'image', filename: 'whiteboard.png', media_type: 'image/png', bytes: Buffer.concat([PNG, Buffer.from('x')]), title: '' },
  ],
}, 'jose');
const code = await new Promise((resolve) => child.on('close', resolve));
const dir = path.join(t.cwd, 'docs', 'diagrams');
const diagrams = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.md')) : [];
const images = fs.existsSync(path.join(dir, 'assets')) ? fs.readdirSync(path.join(dir, 'assets')) : [];
const executed = fs.existsSync(marker) || fs.existsSync(path.join(t.cwd, 'services')) ? 1 : 0;
const staged = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: t.cwd, encoding: 'utf8' }).trim();
const ok = code === 0 && diagrams.length === 2 && images.length === 3 && executed === 0 && !staged && hub.get(id)?.status === 'delivered';
await hub.close();
t.cleanup();
if (ok) process.stdout.write(`RICH OK: ${diagrams.length} diagrams saved under docs/diagrams, ${images.length} images saved, 1 script shown as a proposal, ${executed} commands executed\n`);
else {
  process.stdout.write(`RICH FAILED: exit ${code}, ${diagrams.length} diagrams, ${images.length} images, executed ${executed}, staged "${staged}"\n`);
  process.exitCode = 1;
}

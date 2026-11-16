// @ts-check
// Writes stub executables (tailscale, gh, claude, gemini, codex) into a
// directory for tests that run the real CLI on this Mac. Behaviour is chosen
// with environment variables at run time:
//   STUB_TS_STATE  running | needs_login | stopped | error     (default running)
//   STUB_TS_LOGIN  login name                                  (default nora@example.com)
//   STUB_TS_UP     ok | fail   what `tailscale up` does         (default fail)
//   STUB_GH        ok | signed_out                             (default ok)
//   STUB_TS_NEEDS_SHLVL  1: fail like the macOS app binary when SHLVL is unset
//   STUB_LOG       file to append each invocation to
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const COMMON = `
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
if (process.env.STUB_LOG) fs.appendFileSync(process.env.STUB_LOG, NAME + ' ' + args.join(' ') + '\\n');
`;

const BODIES = {
  tailscale: `
if (process.env.STUB_TS_NEEDS_SHLVL === '1' && !process.env.SHLVL) {
  // Like the macOS app-bundle binary started without a shell.
  process.stderr.write('The Tailscale GUI failed to start: The operation couldn’t be completed. (Tailscale.CLIError error 3.)\\n');
  process.exit(1);
}
const state = process.env.STUB_TS_STATE || 'running';
const login = process.env.STUB_TS_LOGIN || 'nora@example.com';
if (args[0] === 'status' && args[1] === '--json') {
  if (state === 'error') { process.stderr.write('failed to connect to local tailscaled; it doesn\\'t appear to be running\\n'); process.exit(1); }
  const bs = { running: 'Running', needs_login: 'NeedsLogin', stopped: 'Stopped' }[state];
  process.stdout.write(JSON.stringify({ BackendState: bs, Self: { HostName: 'noras-mbp', UserID: 42 }, User: { '42': { ID: 42, LoginName: login } } }));
  process.exit(0);
}
if (args[0] === 'up') { process.exit(process.env.STUB_TS_UP === 'ok' ? 0 : 1); }
process.exit(2);
`,
  gh: `
if (args[0] === 'auth' && args[1] === 'status') {
  if ((process.env.STUB_GH || 'ok') === 'ok') { process.stdout.write('github.com\\n  ✓ Logged in to github.com account nora-gh (keyring)\\n'); process.exit(0); }
  process.stderr.write('You are not logged into any GitHub hosts. To log in, run: gh auth login\\n'); process.exit(1);
}
process.exit(2);
`,
};

const ASSISTANT_BODY = (tool) => `
const { fakeAssistantCli } = await import(${JSON.stringify(pathToFileURL(path.join(HERE, 'fake-assistant-cli.js')).href)});
const os = await import('node:os');
const r = fakeAssistantCli(${JSON.stringify(tool)}, args, { fs, join: path.join, home: os.homedir(), env: process.env });
process.stdout.write(r.stdout ? r.stdout + '\\n' : '');
process.stderr.write(r.stderr ? r.stderr + '\\n' : '');
process.exit(r.code);
`;

/**
 * @param {string} dir @param {string[]} [which]
 */
export function writeStubBin(dir, which = ['tailscale', 'gh', 'claude', 'gemini', 'codex']) {
  fs.mkdirSync(dir, { recursive: true });
  for (const name of which) {
    const body = BODIES[name] ?? ASSISTANT_BODY(name);
    const file = path.join(dir, name);
    // ESM body in <name>.mjs; <name> is a tiny CommonJS launcher (an
    // extensionless file outside a "type": "module" package is CommonJS).
    fs.writeFileSync(file + '.mjs', `const NAME = ${JSON.stringify(name)};\n${COMMON}\n${body}`, 'utf8');
    fs.writeFileSync(file, `#!${process.execPath}\nimport(require('node:url').pathToFileURL(__filename + '.mjs').href);\n`, 'utf8');
    fs.chmodSync(file, 0o755);
  }
  return dir;
}

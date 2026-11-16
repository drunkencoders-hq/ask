// @ts-check
// Which Node suits the website starter (brief 04c): the shared rules, the
// constants shared with bootstrap.sh, and `ask doctor` reporting a warning.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startStubHub } from './stub-hub.js';
import { tempEnv } from './helpers.js';
import { writeStubBin } from './fixtures/stub-bin.js';
import { ROOT } from './helpers.js';
import { realSys } from '../src/setup/sys.js';
import { runDoctor } from '../src/setup/doctor.js';
import {
  NODE_FALLBACK_FORMULA,
  STARTER_NODE_MIN_MAJOR,
  nodeMajor,
  suitsStarter,
  versionManager,
  starterNodeWarning,
} from '../src/setup/nodeversion.js';

test('suitsStarter: even-numbered and 22 or newer', () => {
  for (const v of ['v22.23.5', '24.22.3', 'v26.13.1', '28.0.0']) assert.equal(suitsStarter(v), true, v);
  for (const v of ['v20.20.2', 'v21.7.3', 'v23.11.1', '25.9.0', '27.0.0', 'v18.0.0', 'garbage']) assert.equal(suitsStarter(v), false, v);
  assert.equal(nodeMajor('v23.11.1'), 23);
});

test('starterNodeWarning: wording, the command, no warning for a suitable Node', () => {
  const w = /** @type {string} */ (starterNodeWarning('v23.11.1', 'darwin', '/opt/homebrew/bin/node'));
  assert.match(w, /^Node v23\.11\.1 works for `ask`, but the website starter needs an even-numbered Node 22 or newer\./);
  assert.match(w, new RegExp(`brew install ${NODE_FALLBACK_FORMULA} && brew link --overwrite --force ${NODE_FALLBACK_FORMULA}$`));
  assert.match(/** @type {string} */ (starterNodeWarning('25.9.0', 'win32')), /winget install --id OpenJS\.NodeJS\.LTS --exact$/);
  assert.equal(starterNodeWarning('v24.22.3', 'darwin'), null);
  assert.equal(starterNodeWarning('v22.23.5', 'darwin'), null);
  assert.equal(starterNodeWarning('v18.0.0', 'darwin') !== null, true, 'older than 22 gets the warning too (doctor reports < 20 as a failure separately)');
});

test('version managers are named and their own command is shown', () => {
  assert.equal(versionManager('/Users/x/.nvm/versions/node/v23.1.0/bin/node'), 'nvm');
  assert.equal(versionManager('/Users/x/.local/share/fnm/node-versions/v23.1.0/installation/bin/node'), 'fnm');
  assert.equal(versionManager('/Users/x/.asdf/installs/nodejs/23.1.0/bin/node'), 'asdf');
  assert.equal(versionManager('/Users/x/.volta/bin/node'), 'Volta');
  assert.equal(versionManager('/opt/homebrew/bin/node'), null);
  const w = /** @type {string} */ (starterNodeWarning('v23.1.0', 'darwin', '/Users/x/.nvm/versions/node/v23.1.0/bin/node'));
  assert.match(w, /nvm supplies this Node; to switch/);
  assert.match(w, /nvm install 24/);
  assert.doesNotMatch(w, /brew/);
});

test('bootstrap.sh and nodeversion.js carry the same constants', () => {
  const sh = fs.readFileSync(path.join(ROOT, 'bootstrap.sh'), 'utf8');
  assert.equal(/^NODE_FALLBACK_FORMULA="([^"]+)"$/m.exec(sh)?.[1], NODE_FALLBACK_FORMULA);
  assert.equal(Number(/^STARTER_NODE_MIN_MAJOR=(\d+)$/m.exec(sh)?.[1]), STARTER_NODE_MIN_MAJOR);
  const ps = fs.readFileSync(path.join(ROOT, 'bootstrap.ps1'), 'utf8');
  assert.equal(Number(/^\$StarterNodeMinMajor = (\d+)$/m.exec(ps)?.[1]), STARTER_NODE_MIN_MAJOR);
  // The README lists the fallback.
  assert.match(fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8'), new RegExp(`\`${NODE_FALLBACK_FORMULA}\``));
});

/** @param {{ nodeVersion: string, nodePath?: string, json?: boolean }} o */
async function doctor(o) {
  const hub = await startStubHub();
  const t = tempEnv(hub.url);
  const home = path.join(t.dir, 'home');
  fs.mkdirSync(home);
  const stubBin = writeStubBin(path.join(t.dir, 'stubs'), ['tailscale', 'gh']);
  const env = { ...t.env, HOME: home, PATH: `${stubBin}:/usr/bin:/bin`, ASK_NONINTERACTIVE: '1' };
  /** @type {string[]} */
  const out = [];
  const sys = realSys({ env, homedir: home, out: (l) => out.push(l), err: () => {} });
  try {
    const code = await runDoctor(sys, { nodeVersion: o.nodeVersion, nodePath: o.nodePath, json: o.json });
    return { code, out };
  } finally {
    await hub.close();
    t.cleanup();
  }
}

test('ask doctor: Node 23 → a warning line, exit code and the other checks unchanged', async () => {
  const ok = await doctor({ nodeVersion: '24.22.3' });
  const odd = await doctor({ nodeVersion: '23.11.1' });
  assert.equal(odd.code, ok.code, 'a warning never changes the exit code');
  assert.ok(odd.out.some((l) => /^warn {2}Node \(website starter\): Node v23\.11\.1 works for `ask`, but the website starter needs an even-numbered Node 22 or newer\./.test(l)));
  assert.equal(ok.out.filter((l) => /^warn/.test(l)).length, 0, 'no warning for Node 24');
  assert.equal(odd.out.filter((l) => /^FAIL/.test(l)).length, ok.out.filter((l) => /^FAIL/.test(l)).length);
  assert.match(odd.out.at(-1) ?? '', /^(All checks passed\.|\d+ check\(s\) failed\.)$/);
});

test('ask doctor --json: the warning carries level "warn"', async () => {
  const r = await doctor({ nodeVersion: '23.11.1', json: true });
  assert.equal(r.out.length, 1);
  const j = JSON.parse(r.out[0]);
  const w = j.checks.find((/** @type {any} */ c) => c.name === 'Node (website starter)');
  assert.equal(w.level, 'warn');
  assert.match(w.detail, /even-numbered Node 22 or newer/);
  assert.equal(j.ok, r.code === 0);
  const fine = JSON.parse((await doctor({ nodeVersion: '22.23.5', json: true })).out[0]);
  assert.equal(fine.checks.some((/** @type {any} */ c) => c.level === 'warn'), false);
});

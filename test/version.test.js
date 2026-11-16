// @ts-check
// One source of truth for the version (brief 31, item 9): package.json. The
// CLI and the MCP server read it at run time; CHANGELOG.md has an entry for it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, tempEnv, runCli } from './helpers.js';
import { VERSION } from '../src/client.js';

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

test('package.json and the newest CHANGELOG entry agree, and each release has one', () => {
  const log = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
  const versions = [...log.matchAll(/^## (\d+\.\d+\.\d+)\b/gm)].map((m) => m[1]);
  assert.ok(versions.length >= 2, 'a changelog with entries');
  assert.equal(versions[0], pkg.version, 'the newest entry is the version in package.json');
  assert.equal(new Set(versions).size, versions.length, 'one entry per release');
  const cmp = (/** @type {string} */ a, /** @type {string} */ b) => a.split('.').map(Number).reduce((r, n, i) => r || n - Number(b.split('.')[i]), 0);
  for (let i = 1; i < versions.length; i++) assert.ok(cmp(versions[i - 1], versions[i]) > 0, 'newest first');
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
});

test('the CLI and the client read the version from package.json at run time; none is hard-coded in src/', async () => {
  assert.equal(VERSION, pkg.version);
  const t = tempEnv(null);
  try {
    const r = await runCli(['--version'], t).done;
    assert.equal(r.stdout, `${pkg.version}\n`);
  } finally {
    t.cleanup();
  }
  const found = [];
  const walk = (/** @type {string} */ d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith('.js') && /\b0\.[0-9]+\.[0-9]+\b/.test(fs.readFileSync(p, 'utf8').replace(/\/\/.*$/gm, ''))) found.push(path.relative(ROOT, p));
    }
  };
  walk(path.join(ROOT, 'src'));
  assert.deepEqual(found, [], 'no x.y.z version literal in src/');
});

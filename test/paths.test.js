// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configFilePath, resolveHubUrl, ConfigError } from '../src/config.js';
import { pendingFilePath, PendingStore } from '../src/pending.js';
import { repoFromRemote } from '../src/gitinfo.js';

test('Windows paths: %APPDATA% and %LOCALAPPDATA%', () => {
  const p = {
    platform: 'win32',
    homedir: 'C:\\Users\\nora',
    env: { APPDATA: 'C:\\Users\\nora\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\nora\\AppData\\Local', XDG_CONFIG_HOME: '/ignored' },
  };
  assert.equal(configFilePath(p), 'C:\\Users\\nora\\AppData\\Roaming\\drunkencoders\\ask.json');
  assert.equal(pendingFilePath(p), 'C:\\Users\\nora\\AppData\\Local\\drunkencoders\\ask\\pending.json');
});

test('Windows paths without APPDATA/LOCALAPPDATA fall back under the home folder', () => {
  const p = { platform: 'win32', homedir: 'C:\\Users\\grish', env: {} };
  assert.equal(configFilePath(p), 'C:\\Users\\grish\\AppData\\Roaming\\drunkencoders\\ask.json');
  assert.equal(pendingFilePath(p), 'C:\\Users\\grish\\AppData\\Local\\drunkencoders\\ask\\pending.json');
});

test('macOS paths: defaults and XDG overrides', () => {
  const d = { platform: 'darwin', homedir: '/Users/jose', env: {} };
  assert.equal(configFilePath(d), '/Users/jose/.config/drunkencoders/ask.json');
  assert.equal(pendingFilePath(d), '/Users/jose/.local/state/drunkencoders/ask/pending.json');
  const x = { platform: 'darwin', homedir: '/Users/jose', env: { XDG_CONFIG_HOME: '/tmp/c', XDG_STATE_HOME: '/tmp/s' } };
  assert.equal(configFilePath(x), '/tmp/c/drunkencoders/ask.json');
  assert.equal(pendingFilePath(x), '/tmp/s/drunkencoders/ask/pending.json');
});

test('hub address: ASK_HUB_URL wins, else hub_url from the config file, else a ConfigError naming ask setup', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-cfg-'));
  try {
    const p = { platform: 'darwin', homedir: dir, env: { XDG_CONFIG_HOME: dir } };
    assert.throws(() => resolveHubUrl(p), (e) => e instanceof ConfigError && /ask setup/.test(e.message));
    fs.mkdirSync(path.join(dir, 'drunkencoders'));
    fs.writeFileSync(path.join(dir, 'drunkencoders', 'ask.json'), JSON.stringify({ hub_url: 'http://mini:8787/' }), 'utf8');
    assert.equal(resolveHubUrl(p).hubUrl, 'http://mini:8787');
    assert.equal(resolveHubUrl({ ...p, env: { ...p.env, ASK_HUB_URL: 'http://127.0.0.1:9' } }).hubUrl, 'http://127.0.0.1:9');
    fs.writeFileSync(path.join(dir, 'drunkencoders', 'ask.json'), '{}', 'utf8');
    assert.throws(() => resolveHubUrl(p), /hub_url/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pending store: add, update, latest, remove', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-pend-'));
  try {
    const s = new PendingStore(path.join(dir, 'a', 'b', 'pending.json'));
    assert.deepEqual(s.all(), []);
    s.add({ client_request_id: 'r1', id: null, question: 'one', created_at: '2026-01-01T00:00:00Z' });
    s.add({ client_request_id: 'r2', id: null, question: 'two', created_at: '2026-01-02T00:00:00Z' });
    s.update('r1', { id: 'q_1' });
    assert.equal(s.findById('q_1')?.question, 'one');
    assert.equal(s.latest()?.client_request_id, 'r2');
    s.remove('r2');
    assert.equal(s.all().length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('repo from origin URL', () => {
  assert.equal(repoFromRemote('git@github.com:drunkencoders-hq/sandbox.git'), 'drunkencoders-hq/sandbox');
  assert.equal(repoFromRemote('https://github.com/drunkencoders-hq/sandbox'), 'drunkencoders-hq/sandbox');
  assert.equal(repoFromRemote('https://github.com/drunkencoders-hq/sandbox.git/'), 'drunkencoders-hq/sandbox');
  assert.equal(repoFromRemote('ssh://git@github.com/drunkencoders-hq/hub.git'), 'drunkencoders-hq/hub');
  assert.equal(repoFromRemote('https://user@github.com/org/name.git'), 'org/name');
});

#!/usr/bin/env node
// @ts-check
// Rehearsal of the hands-free macOS bootstrap (brief 04b), with nothing real:
// bootstrap.sh runs for real, piped on stdin like `curl … | bash -s --`, in a
// new session without a terminal, but every program it can reach is a stub
// in a throwaway folder (Homebrew installer, brew, git, node, npm, sudo, gh,
// tailscale, claude, open), HOME is throwaway, and the hub is the stub hub on
// 127.0.0.1 with contract change 4. The stub hub approves the registration
// after a delay (the approver's tap).
//
//   npm run rehearse:bootstrap                 nothing installed (the default)
//   npm run rehearse:bootstrap -- installed    everything already installed
//   npm run rehearse:bootstrap -- refused | expired | unreachable | progress-fail | all
//
// Leaves nothing behind: the folder is removed and the hub closed.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStubHub } from '../test/stub-hub.js';
import { writeStubBin } from '../test/fixtures/stub-bin.js';
import { STEPS } from '../src/setup/onboarding.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'tok_REHEARSAL_d41d8cd98f00b204e9800998ecf8427e';
const SHARE = 'https://login.tailscale.com/admin/invite/REHEARSALSHARE';

// The system tools bootstrap.sh itself needs; nothing else of this Mac is on PATH.
const SYSTEM_TOOLS = ['uname', 'id', 'awk', 'head', 'mktemp', 'rm', 'date', 'cat', 'sed', 'tr', 'dirname', 'basename', 'env', 'sleep', 'mkdir', 'chmod', 'ln', 'cp', 'bash', 'sh', 'ls', 'grep', 'cut'];

/** Bash stubs for the installers; each logs its arguments. */
function bashStubs(dir, catalog, prefix, appsDir) {
  const head = `#!/bin/bash\nprintf '%s\\n' "$(basename "$0") $*" >>"$STUB_LOG"\n`;
  const files = {
    // `curl -fsSL <Homebrew installer>` prints a script that "installs" brew.
    curl: `${head}case "$*" in
  *Homebrew/install*) printf '%s\\n' '[ "\${NONINTERACTIVE:-}" = 1 ] || { echo "installer would ask questions" >&2; exit 9; }' 'mkdir -p "${prefix}/bin" && cp "${catalog}/brew" "${prefix}/bin/brew"' ;;
  *) echo "stub curl: no network" >&2; exit 22 ;;
esac\n`,
    brew: head + [
      'P="' + prefix + '"',
      'case "$1" in',
      '  shellenv) printf \'export PATH="%s/bin:$PATH"\\n\' "$P" ;;',
      '  --prefix) printf \'%s\\n\' "$P" ;;',
      // STUB_BREW_NODE: the version of Homebrew's plain node formula (default 26.13.1).
      // STUB_BREW_FORMULAS: the Node formulas that exist. STUB_BREW_OFFLINE=1: the JSON query fails.
      '  info)',
      '    shift',
      '    if [ "$1" = --formula ] && [ "$2" = --json=v2 ]; then',
      '      [ "${STUB_BREW_OFFLINE:-}" = 1 ] && exit 1',
      '      printf \'{"formulae":[{"name":"node","versions":{"stable":"%s"}}]}\\n\' "${STUB_BREW_NODE:-26.13.1}"',
      '      exit 0',
      '    fi',
      '    [ "$1" = --formula ] && shift',
      '    case " ${STUB_BREW_FORMULAS:-node node@22 node@24} " in *" $1 "*) exit 0 ;; esac',
      '    exit 1 ;;',
      '  link)',
      '    shift',
      '    F="$3"',
      '    [ -d "$P/opt/$F/bin" ] || exit 1',
      '    cp "$P/opt/$F/bin/"* "$P/bin/" ;;',
      '  install)',
      '    shift',
      '    if [ "$1" = --cask ]; then',
      '      case "$2" in',
      '        tailscale-app) mkdir -p "' + appsDir + '/Tailscale.app" && cp "' + catalog + '/tailscale" "' + catalog + '/tailscale.mjs" "$P/bin/" ;;',
      '        claude-code) cp "' + catalog + '/claude" "' + catalog + '/claude.mjs" "$P/bin/" ;;',
      '        *) exit 1 ;;',
      '      esac',
      '    else',
      '      case "$1" in',
      '        node | node@*)',
      '          case "$1" in node) V="${STUB_BREW_NODE:-26.13.1}" ;; *) V="${1#node@}.99.9" ;; esac',
      '          D="$P/bin"; [ "$1" = node ] || D="$P/opt/$1/bin"',
      '          mkdir -p "$D"',
      '          printf \'#!/bin/bash\\n[ "$1" = --version ] && { echo v%s; exit 0; }\\nexec "%s" "$@"\\n\' "$V" "' + process.execPath + '" >"$D/node"',
      '          chmod +x "$D/node"',
      '          cp "' + catalog + '/npm" "$D/npm" ;;',
      '        git) cp "' + catalog + '/git" "$P/bin/git" ;;',
      '        gh) cp "' + catalog + '/gh" "' + catalog + '/gh.mjs" "$P/bin/" ;;',
      '        *) exit 1 ;;',
      '      esac',
      '    fi ;;',
      '  *) exit 1 ;;',
      'esac',
      '',
    ].join('\n'),
    npm: `${head}printf '%s\\n' "npm runs under node $(node --version)" >>"$STUB_LOG"
case "$1" in
  prefix) printf '%s\\n' "${prefix}" ;;
  install) printf '#!/bin/bash\\nexec node %q/src/cli.js "$@"\\n' "$3" >"${prefix}/bin/ask"; chmod +x "${prefix}/bin/ask" ;;
  *) exit 1 ;;
esac\n`,
    // STUB_SUDO: ok (default) | refused (three wrong passwords)
    sudo: `${head}[ "$1" = -v ] || exit 1
if [ "\${STUB_SUDO:-ok}" = refused ]; then printf 'Sorry, try again.\\nSorry, try again.\\nsudo: 3 incorrect password attempts\\n' >&2; exit 1; fi
exit 0\n`,
    git: `${head}echo "git version 2.99.0"\n`,
  };
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), body, { mode: 0o755 });
  }
}

/**
 * @param {string} name
 * @param {{ installed?: boolean, decision?: 'register'|'refuse'|'expire', unreachable?: boolean, failProgress?: number,
 *           sudo?: 'refused'|'nonadmin', throttle?: Record<string, number>, repaste?: boolean, tokenDead?: boolean,
 *           nodeVersion?: string, brewNode?: string, brewFormulas?: string, brewOffline?: boolean,
 *           expectFormula?: string, expectWarn?: boolean }} sc
 */
async function rehearse(name, sc) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-rehearsal-'));
  const catalog = path.join(dir, 'catalog');
  const prefix = path.join(dir, 'homebrew');
  const appsDir = path.join(dir, 'Applications');
  const home = path.join(dir, 'home');
  const stateDir = path.join(dir, 'stubstate');
  const sysbin = path.join(dir, 'sysbin');
  const stubbin = path.join(dir, 'stubbin');
  const tmp = path.join(dir, 'tmp');
  for (const d of [prefix + '/bin', appsDir, home, stateDir, sysbin, stubbin, tmp]) fs.mkdirSync(d, { recursive: true });
  const log = path.join(dir, 'stub.log');
  fs.writeFileSync(log, '');

  writeStubBin(catalog, ['gh', 'tailscale', 'claude', 'open']);
  bashStubs(catalog, catalog, prefix, appsDir); // brew, git (installed later), plus unused copies
  bashStubs(stubbin, catalog, prefix, appsDir); // curl, npm stand-in until node exists, sudo
  fs.rmSync(path.join(stubbin, 'brew'));
  fs.rmSync(path.join(stubbin, 'git'));
  fs.renameSync(path.join(catalog, 'open'), path.join(stubbin, 'open'));
  fs.renameSync(path.join(catalog, 'open.mjs'), path.join(stubbin, 'open.mjs'));
  for (const t of SYSTEM_TOOLS) {
    const src = ['/bin/' + t, '/usr/bin/' + t].find((p) => fs.existsSync(p));
    if (src) fs.symlinkSync(src, path.join(sysbin, t));
  }
  // npm comes with Node: the stub sits in the catalog until `brew install node`.
  fs.renameSync(path.join(stubbin, 'npm'), path.join(catalog, 'npm'));

  if (sc.sudo === 'nonadmin') {
    // `id -Gn` without the admin group; everything else is the real id.
    fs.writeFileSync(path.join(stubbin, 'id'), `#!/bin/bash\nprintf '%s\\n' "id $*" >>"$STUB_LOG"\nif [ "$1" = -Gn ]; then echo "staff everyone localaccounts"; exit 0; fi\nexec /usr/bin/id "$@"\n`, { mode: 0o755 });
  }
  if (sc.installed) {
    for (const f of ['brew', 'git', 'npm']) fs.copyFileSync(path.join(catalog, f), path.join(prefix, 'bin', f));
    for (const f of ['gh', 'tailscale', 'claude']) for (const e of ['', '.mjs']) fs.copyFileSync(path.join(catalog, f + e), path.join(prefix, 'bin', f + e));
    fs.chmodSync(path.join(prefix, 'bin', 'brew'), 0o755);
    // The node already on this Mac: reports sc.nodeVersion, runs the real node.
    fs.writeFileSync(path.join(prefix, 'bin', 'node'), `#!/bin/bash\n[ "$1" = --version ] && { echo ${sc.nodeVersion ?? 'v24.22.3'}; exit 0; }\nexec "${process.execPath}" "$@"\n`, { mode: 0o755 });
    fs.mkdirSync(path.join(appsDir, 'Tailscale.app'));
    fs.writeFileSync(path.join(prefix, 'bin', 'ask'), `#!/bin/bash\nexec node ${JSON.stringify(ROOT)}/src/cli.js "$@"\n`, { mode: 0o755 });
  }

  const shareAccepted = () => fs.existsSync(path.join(stateDir, 'share_accepted'));
  const hub = await startStubHub({
    teammate: null,
    autoAnswerMs: 400,
    autoAnswerText: 'Yes, I can see it. Welcome aboard!',
    reachable: () => !sc.unreachable && (sc.installed || shareAccepted()),
    onboarding: {
      token: TOKEN, displayName: 'Nora', teammate: 'nora', mentor: 'jose', approver: 'Jose',
      decision: sc.decision ?? 'register', decideAfterMs: 1000, failProgress: sc.failProgress ?? 0,
      throttle: sc.throttle, retryAfterSec: 1, registered: !!sc.repaste, tokenDead: !!sc.tokenDead,
    },
  });

  const env = {
    PATH: [stubbin, sysbin].join(':'),
    HOME: home,
    TMPDIR: tmp,
    USER: 'rehearsal',
    LANG: 'en_US.UTF-8',
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'),
    ASK_INSTALL_SOURCE: ROOT,
    DC_BREW_PATHS: path.join(prefix, 'bin', 'brew'),
    DC_APPS_DIR: appsDir,
    STUB_LOG: log,
    STUB_SUDO: sc.sudo === 'refused' ? 'refused' : 'ok',
    ...(sc.brewNode ? { STUB_BREW_NODE: sc.brewNode } : {}),
    ...(sc.brewFormulas ? { STUB_BREW_FORMULAS: sc.brewFormulas } : {}),
    ...(sc.brewOffline ? { STUB_BREW_OFFLINE: '1' } : {}),
    STUB_STATE_DIR: stateDir,
    STUB_SHARE_URL: SHARE,
    STUB_GH: sc.installed ? 'ok' : 'signed_out',
    STUB_TS_STATE: sc.installed ? 'running' : 'error',
    ASK_ONBOARDING_POLL_MS: '200',
    ASK_ONBOARDING_HUB_WAIT_SEC: sc.unreachable ? '3' : '60',
    ASK_ONBOARDING_SIGNIN_WAIT_SEC: '60',
    ASK_ONBOARDING_STATUS_WAIT: '2',
    ASK_READY_RETRY_SEC: '10',
    ASK_FIRST_QUESTION_WAIT_SEC: '10',
  };
  const args = ['--hub', hub.url, '--token', TOKEN, ...(sc.installed ? [] : ['--share', SHARE])];
  // Like `curl -fsSL <url> | bash -s -- …`: the script on stdin, in a new session with no terminal.
  const child = spawn('/bin/bash', ['-s', '--', ...args], { env, cwd: home, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.setEncoding('utf8').on('data', (d) => (out += d));
  child.stderr.setEncoding('utf8').on('data', (d) => (out += d));
  child.stdin.end(fs.readFileSync(path.join(ROOT, 'bootstrap.sh')));
  const code = await new Promise((resolve) => child.on('close', (c) => resolve(c)));

  const stubLog = fs.readFileSync(log, 'utf8');
  const installs = (stubLog.match(/^(curl -fsSL \S*Homebrew\/install\S*|brew install .+|npm install -g .+)$/gm) ?? []).filter((l) => !(sc.installed && l.startsWith('npm install')));
  // Prompt markers of anything that waits for a typed answer (macOS's own password prompt is not one of ours).
  const questions = (out.match(/\[y\/N\]|Press (Enter|RETURN)\b|\(yes\/no\)|\? \[Y\/n\]/g) ?? []).length;
  const ob = hub.state.onboarding;
  const order = ob.progress.map((p) => STEPS.indexOf(p.step));
  const inOrder = order.every((v, i) => v >= 0 && (i === 0 || v >= order[i - 1]));
  const finals = new Map();
  for (const p of ob.progress) finals.set(p.step, p.status);
  const leftovers = fs.readdirSync(tmp);
  // The token must be nowhere: files in the throwaway HOME and temp dir, the stub log, the output.
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) files.push(p);
    }
  };
  walk(dir);
  const leaks = files.filter((f) => fs.readFileSync(f, 'utf8').includes(TOKEN)).map((f) => path.relative(dir, f));
  if (out.includes(TOKEN)) leaks.push('(captured output)');
  const standby = hub.state.statusPosts.some((l) => l.startsWith('Standby verified: nora'));
  const firstQ = hub.state.createBodies.some((b) => b.kind === 'question' && /^Set-up test from /.test(b.question));
  const callCounts = { ...hub.state.calls };
  const configWritten = fs.existsSync(path.join(env.XDG_CONFIG_HOME, 'drunkencoders', 'ask.json'));

  await hub.close();
  fs.rmSync(dir, { recursive: true, force: true });

  const problems = [];
  if (leaks.length) problems.push(`token found in: ${leaks.join(', ')}`);
  if (leftovers.length) problems.push(`left in the temp dir: ${leftovers.join(', ')}`);
  if (questions) problems.push(`${questions} question(s) asked`);
  if (!inOrder) problems.push(`steps out of order: ${ob.progress.map((p) => p.step).join(' ')}`);
  const onbCalls = ['hello', 'identity', 'status'].reduce((n, r) => n + (callCounts[`POST /v1/onboarding/${r}`] ?? 0), 0);
  let summary;
  if (sc.sudo) {
    const expectLine = sc.sudo === 'nonadmin' ? /Your Mac account is not an administrator/ : /macOS did not accept the password/;
    if (code !== 1) problems.push(`exit ${code}, expected 1`);
    if (!expectLine.test(out)) problems.push('stop message missing');
    if (/Homebrew\/install/.test(stubLog)) problems.push('the Homebrew installer ran');
    if (sc.sudo === 'nonadmin' && /^sudo /m.test(stubLog)) problems.push('sudo was run for a non-admin account');
    if ((stubLog.match(/^sudo /gm) ?? []).length > 1) problems.push('sudo run more than once');
    summary = `REHEARSAL ${name} OK: exit ${code}, Homebrew not installed, one clear line (${sc.sudo === 'nonadmin' ? 'not an administrator' : 'password not accepted'})`;
  } else if (sc.repaste) {
    if (code !== 0) problems.push(`exit ${code}`);
    if (onbCalls) problems.push(`${onbCalls} hello/identity/status call(s) although whoami knew us`);
    if (!standby) problems.push('no "Standby verified"');
    if (!firstQ) problems.push('no first question');
    if (sc.tokenDead) {
      if (ob.progress.length) problems.push('reports accepted with a dead token');
      if ((out.match(/no longer accepts progress reports/g) ?? []).length !== 1) problems.push('not exactly one line about dropped reports');
    } else if (finals.get('ready') !== 'done') problems.push('ready not reported done');
    summary = `REHEARSAL ${name} OK: exit ${code}, whoami known, onboarding routes not called, standby verified, ${sc.tokenDead ? 'reports dropped with one line (token dead)' : 'ready reported'}, first question sent`;
  } else if (!sc.decision && !sc.unreachable) {
    const missing = STEPS.filter((s) => !finals.has(s));
    if (code !== 0) problems.push(`exit ${code}`);
    if (missing.length && !sc.failProgress) problems.push(`steps never reported: ${missing.join(', ')}`);
    if (ob.state !== 'registered') problems.push(`not registered (state ${ob.state})`);
    if (!standby) problems.push('no "Standby verified"');
    if (!firstQ) problems.push('no first question');
    if (finals.get('ready') !== 'done') problems.push('ready not reported done');
    const skippedExpected = sc.installed ? ['homebrew', 'git', 'node', 'gh', 'tailscale', 'ask', 'assistant', 'github-sign-in', 'tailscale-sign-in'] : [];
    for (const s of skippedExpected) if (finals.get(s) !== 'skipped') problems.push(`${s} reported ${finals.get(s)}, expected skipped`);
    if (sc.installed && installs.length) problems.push(`installs: ${installs.join('; ')}`);
    // Node for the website starter (brief 04c): the formula installed is even-numbered, linked when keg-only,
    // and is the node first on PATH when npm installs ask; an existing Node is never replaced.
    const warnCount = (out.match(/^warn Node /gm) ?? []).length;
    if (warnCount !== (sc.expectWarn ? 1 : 0)) problems.push(`${warnCount} Node warning(s), expected ${sc.expectWarn ? 1 : 0}`);
    if (sc.installed && /^brew (install node|link)/m.test(stubLog)) problems.push('an existing Node was replaced or relinked');
    if (!sc.installed) {
      const f = sc.expectFormula ?? 'node';
      if (!new RegExp(`^brew install ${f.replace('@', '@')}$`, 'm').test(stubLog)) problems.push(`formula ${f} not installed`);
      if (f !== 'node' && !new RegExp(`^brew link --overwrite --force ${f}$`, 'm').test(stubLog)) problems.push(`${f} not linked`);
      if (/^brew install node@?\d*$/m.test(stubLog) && (stubLog.match(/^brew install node/gm) ?? []).length !== 1) problems.push('more than one Node formula installed');
      const nv = /^npm runs under node v(\d+)\./m.exec(stubLog);
      if (!nv || Number(nv[1]) % 2 !== 0 || Number(nv[1]) < 22) problems.push(`npm ran under ${nv ? 'v' + nv[1] : 'no node'}, not an even Node >= 22`);
    }
    if (!sc.installed && !sc.failProgress && installs.length !== 7) problems.push(`expected 7 installs, saw ${installs.length}: ${installs.join('; ')}`);
    summary = `BOOTSTRAP OK: ${installs.length} installs, ${questions} questions asked, ${finals.size} steps reported in order, registered after approval, standby verified, first question sent`;
    if (sc.expectFormula || sc.nodeVersion) {
      const how = sc.installed ? `existing Node ${sc.nodeVersion} left alone, ${sc.expectWarn ? 'one warning' : 'no warning'}` : `brew install ${sc.expectFormula ?? 'node'}${sc.expectFormula && sc.expectFormula !== 'node' ? ' + brew link' : ''}, even Node first on PATH under npm`;
      summary = `REHEARSAL ${name} OK: ${how}; set-up completed: exit ${code}, registered, standby verified, first question sent`;
    }
    if (sc.throttle) summary = `REHEARSAL ${name} OK: ${ob.throttled.length} calls answered 429 with Retry-After (${ob.throttled.join(', ')}); waited and completed: exit ${code}, ${finals.size} steps reported, registered, standby verified, ready reported`;
    if (sc.failProgress) summary = `REHEARSAL ${name} OK: ${sc.failProgress} progress reports refused by the hub (lost: ${missing.join(', ') || 'none'}), set-up still completed: exit ${code}, registered, standby verified, ready reported, first question sent`;
  } else if (sc.decision) {
    if (code !== 5) problems.push(`exit ${code}, expected 5`);
    if (configWritten) problems.push('config written although not registered');
    if (sc.decision === 'expire' && !/\/onboard/.test(out)) problems.push('message does not name /onboard');
    summary = `REHEARSAL ${name} OK: exit ${code}, nothing registered locally${sc.decision === 'expire' ? ', message names /onboard' : ''}`;
  } else {
    if (code !== 4) problems.push(`exit ${code}, expected 4`);
    if (ob.progress.length) problems.push('reports sent although the hub was never reachable');
    summary = `REHEARSAL ${name} OK: exit ${code} after the cut, queue file removed, nothing sent`;
  }
  if (process.env.REHEARSE_VERBOSE || problems.length) process.stderr.write(`\n----- ${name}: bootstrap output -----\n${out}\n----- stub log -----\n${stubLog}\n`);
  if (problems.length) {
    process.stdout.write(`REHEARSAL ${name} FAILED: ${problems.join('; ')}\n`);
    return false;
  }
  process.stdout.write(summary + '\n');
  return true;
}

const SCENARIOS = {
  fresh: {},
  installed: { installed: true },
  refused: { decision: /** @type {const} */ ('refuse') },
  expired: { decision: /** @type {const} */ ('expire') },
  unreachable: { unreachable: true },
  'progress-fail': { failProgress: 6 },
  'rate-limited': { installed: true, throttle: { hello: 1, identity: 1, status: 1, progress: 2 } },
  repaste: { installed: true, repaste: true },
  'repaste-dead': { installed: true, repaste: true, tokenDead: true },
  'node-23': { installed: true, nodeVersion: 'v23.11.1', expectWarn: true },
  'node-22': { installed: true, nodeVersion: 'v22.23.5' },
  'node-odd-formula': { brewNode: '27.0.0', brewFormulas: 'node node@22 node@24', expectFormula: 'node@24' },
  'node-newest-missing': { brewNode: '29.0.0', brewFormulas: 'node node@22 node@24', expectFormula: 'node@24' },
  'node-fallback': { brewOffline: true, expectFormula: 'node@24' },
  'sudo-refused': { sudo: /** @type {const} */ ('refused') },
  'non-admin': { sudo: /** @type {const} */ ('nonadmin') },
};

if (process.platform !== 'darwin') {
  process.stdout.write('rehearse:bootstrap runs bootstrap.sh and needs macOS.\n');
  process.exit(0);
}
const pick = process.argv[2] ?? 'fresh';
const names = pick === 'all' ? Object.keys(SCENARIOS) : [pick];
let ok = true;
for (const n of names) {
  if (!(n in SCENARIOS)) {
    process.stderr.write(`unknown scenario ${n}; one of: ${Object.keys(SCENARIOS).join(', ')}, all\n`);
    process.exit(2);
  }
  ok = (await rehearse(n, SCENARIOS[/** @type {keyof typeof SCENARIOS} */ (n)])) && ok;
}
process.exit(ok ? 0 : 1);

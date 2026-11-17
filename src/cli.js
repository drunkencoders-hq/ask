#!/usr/bin/env node
// @ts-check
// `ask` command line. stdout carries only the answer (or JSON with --json);
// everything else goes to stderr.
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { resolveHubUrl, ConfigError } from './config.js';
import { PendingStore, pendingFilePath } from './pending.js';
import { gitInfo, gitTop } from './gitinfo.js';
import { checkCheckout } from './checkout.js';
import { isRich, prepareRich } from './rich.js';
import { NoticeError, runAnnounce } from './announce.js';
import { formatAskUpdate } from './update.js';
import { fetchNotices, formatNotices, sendSeen } from './notices.js';
import path from 'node:path';
import {
  VERSION,
  createClient,
  submitQuestion,
  sendReceipt,
  findResumeTarget,
  formatAnswer,
  HubError,
  HubUnreachable,
  Aborted,
  REFUSAL_CODES,
} from './client.js';

export const EXIT = {
  OK: 0,
  USAGE: 2,
  TIMEOUT: 3,
  UNREACHABLE: 4,
  REFUSED: 5,
  FAILED: 6,
  INTERRUPTED: 130,
};

const HELP = `ask ${VERSION} — ask the project's owner a question through the drunkencoders hub

Usage:
  ask "question text" [--repo org/name | --project slug] [--branch name]
                      [--context-file path | --context -]   (- reads stdin)
                      [--timeout seconds]   default 0 = wait until answered
                      [--json] [--no-save]
  ask --resume [id] [--no-save]   fetch the answer to an earlier question (default: most recent pending)
  ask --list          my questions still pending or answered-but-undelivered, and notices from the team
  ask mcp             run the MCP server on stdio
  ask --version | --help
  ask setup --hub <url>             configure, sign in, register MCP, verify
  ask setup --unregister            remove MCP entries and the config file
  ask doctor [--json]               read-only health checks
  ask agents-snippet                print the AGENTS.md text for projects not made from the starters
  ask playbook "<words>"            search the team playbook on this machine (read-only copy)
  ask knowledge sync | status       refresh / list the local copies of the team's knowledge repos
  ask checkout-check --consent --repo <org>/sandbox [--projects-root <path>] [--checkout <path>]
  ask standby                       send a standby test through the hub
  ask announce --to name --file note.md [--dry-run] | --list | --template
  ask announce --summary --file lines.txt [--day YYYY-MM-DD] [--dry-run] [--json]   evening summary DM (announcer only)
  ask announce --attention [--json]                                                what is waiting on the announcer

Exit codes: 0 answered and receipt recorded · 2 configuration or usage error ·
3 still pending at --timeout · 4 hub unreachable · 5 refused ·
6 question failed on the hub

Rich answers (drafted by the mentor): diagrams are saved as Mermaid files in
docs/diagrams of the git work tree you ran this in, images in docs/diagrams/assets
(nothing is committed); --no-save, or no work tree, saves them under ask's state
folder instead. Scripts in an answer are shown as proposals and are never run by ask.
`;

class UsageError extends Error {}

/** @param {string} msg */
const err = (msg) => process.stderr.write(msg.endsWith('\n') ? msg : msg + '\n');

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

/** @param {string[]} argv */
function parse(argv) {
  try {
    return parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        repo: { type: 'string' },
        project: { type: 'string' },
        branch: { type: 'string' },
        'context-file': { type: 'string' },
        context: { type: 'string' },
        timeout: { type: 'string' },
        json: { type: 'boolean' },
        'no-save': { type: 'boolean' },
        resume: { type: 'boolean' },
        list: { type: 'boolean' },
        version: { type: 'boolean', short: 'v' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (e) {
    throw new UsageError(/** @type {Error} */ (e).message);
  }
}

/** @param {string|undefined} s */
function parseTimeout(s) {
  if (s === undefined) return 0;
  if (!/^\d+$/.test(s)) throw new UsageError(`--timeout must be a whole number of seconds, got "${s}"`);
  return Number(s);
}

/**
 * Map an error to an exit code and print it.
 * @param {unknown} e
 */
function fail(e) {
  if (e instanceof UsageError || e instanceof NoticeError || e instanceof ConfigError) {
    err(`ask: ${e.message}`);
    if (e instanceof UsageError) err('Run `ask --help` for usage.');
    return EXIT.USAGE;
  }
  if (e instanceof HubError) {
    if (REFUSAL_CODES.has(e.code)) {
      err(`ask: hub refused (${e.code}): ${e.message}`);
      return EXIT.REFUSED;
    }
    if (e.code === 'invalid_request') {
      err(`ask: hub rejected the request (invalid_request): ${e.message}`);
      return EXIT.USAGE;
    }
    err(`ask: hub error (${e.code}): ${e.message}`);
    return EXIT.REFUSED;
  }
  if (e instanceof HubUnreachable) {
    err(`ask: hub unreachable: ${e.message}`);
    return EXIT.UNREACHABLE;
  }
  err(`ask: ${/** @type {Error} */ (e)?.stack ?? e}`);
  return 1;
}

/**
 * Wait for a question, print it, send the receipt. Shared by ask and --resume.
 * @param {ReturnType<typeof createClient>} client @param {PendingStore} store
 * @param {{ id: string, client_request_id?: string }} entry
 * @param {{ timeoutSec: number, json: boolean, signal: AbortSignal, noSave?: boolean }} o
 */
async function waitPrintReceipt(client, store, entry, o) {
  let shownPermalink = false;
  const result = await client.waitFor(entry.id, {
    timeoutSec: o.timeoutSec,
    signal: o.signal,
    onUpdate: (q) => {
      if (q.card?.permalink && !shownPermalink) {
        shownPermalink = true;
        err(`Card: ${q.card.permalink}`);
      }
    },
  });
  const q = result.question;
  if (!result.done) {
    if (o.json) await printJson(client, { id: entry.id, status: q?.status ?? 'pending' });
    err(`Still waiting for an answer to ${entry.id}. Fetch it later with:\n  ask --resume ${entry.id}`);
    return EXIT.TIMEOUT;
  }
  if (q.status === 'failed') {
    const msg = q.error?.message ?? q.error?.code ?? 'no detail';
    if (o.json) await printJson(client, { id: q.id, status: 'failed', error: q.error });
    err(`ask: question ${q.id} failed on the hub: ${msg}`);
    if (entry.client_request_id) store.remove(entry.client_request_id);
    return EXIT.FAILED;
  }
  // answered (or already delivered): print as data, then confirm delivery.
  // A rich answer (scripts, diagrams, images; contract changes 5 and 6) is downloaded and saved first;
  // a plain answer prints exactly as before.
  const rich = isRich(q)
    ? await prepareRich({
        client,
        q,
        question: /** @type {any} */ (entry).question,
        workTree: o.noSave ? null : await gitTop(process.cwd()),
        stateDir: path.dirname(pendingFilePath()),
        noSave: o.noSave,
      })
    : null;
  if (o.json) {
    await printJson(client,
      // route, answerer and comments are passed through verbatim when the hub sends them (contract change 2).
      {
        id: q.id, status: 'answered', project: q.project, answer: q.answer, card: q.card, route: q.route, answerer: q.answerer, comments: q.comments,
        ...(rich ? { saved: rich.saved, attachments: rich.downloads.map((d) => ({ id: d.att.id, filename: d.att.filename, ok: d.data !== null, error: d.error })) } : {}),
      },
    );
  } else {
    process.stdout.write((rich ? rich.text : formatAnswer(q)) + '\n');
  }
  const r = await sendReceipt(client, store, entry);
  if (!r.ok) {
    err(
      `ask: the answer was printed but the receipt could not be recorded (${r.error.message}).\n` +
        `Run \`ask --resume ${q.id}\` to retry the receipt.`,
    );
    return r.error instanceof HubError ? EXIT.REFUSED : EXIT.UNREACHABLE;
  }
  return EXIT.OK;
}

/** @param {ReturnType<typeof createClient>} client @param {Record<string, unknown>} data @param {number} [spacing] */
async function printJson(client, data, spacing) {
  const update = await client.askUpdate();
  process.stdout.write(JSON.stringify({ ...data, ...(update ? { ask_update: update } : {}) }, null, spacing) + '\n');
}

/**
 * `ask playbook "<words>"`, `ask knowledge sync|status`.
 * @param {'knowledge'|'playbook'} sub @param {string[]} args
 */
async function runKnowledgeCommand(sub, args) {
  const { realSys } = await import('./setup/sys.js');
  const k = await import('./knowledge.js');
  const sys = realSys();
  if (sub === 'playbook') {
    const query = args.join(' ').trim();
    if (!query) {
      err('ask: usage: ask playbook "<words>"');
      return EXIT.USAGE;
    }
    process.stdout.write(k.formatSearch(await k.searchPlaybook(sys, query)) + '\n');
    return EXIT.OK;
  }
  if (args.length === 1 && args[0] === 'status') {
    process.stdout.write(k.formatStatus(await k.knowledgeStatus(sys)) + '\n');
    return EXIT.OK;
  }
  if (args.length === 1 && args[0] === 'sync') {
    let hubUrl = null;
    try {
      hubUrl = resolveHubUrl().hubUrl;
    } catch {}
    const { runKnowledgeStep } = await import('./setup/knowledge-step.js');
    const { results } = await runKnowledgeStep(sys, hubUrl);
    // A copy that could not be reached is a warning, not a failure of the command.
    return results.some((r) => r.state === 'failed') ? EXIT.FAILED : EXIT.OK;
  }
  err('ask: usage: ask knowledge sync | ask knowledge status');
  return EXIT.USAGE;
}

/** @param {string[]} args */
async function runCheckoutCheck(args) {
  let values;
  try {
    ({ values } = parseArgs({
      args,
      options: {
        consent: { type: 'boolean' },
        repo: { type: 'string' },
        'projects-root': { type: 'string' },
        checkout: { type: 'string' },
      },
    }));
  } catch {
    // parseArgs diagnostics may quote the supplied paths. Keep them local.
    err('ask: usage: ask checkout-check --consent --repo <org>/sandbox [--projects-root <path>] [--checkout <path>]');
    return EXIT.USAGE;
  }
  const result = await checkCheckout({
    consent: values.consent,
    repo: values.repo,
    projectsRoot: values['projects-root'],
    checkout: values.checkout,
  });
  process.stdout.write(JSON.stringify(result) + '\n');
  return result.status === 'consent_required' ? EXIT.REFUSED : EXIT.OK;
}

/**
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
export async function main(argv) {
  const sub = argv[0];
  if (sub === 'checkout-check') return runCheckoutCheck(argv.slice(1));
  if (sub === 'announce') {
    try {
      return (await runAnnounce(argv.slice(1))) ?? EXIT.OK;
    } catch (e) {
      return fail(e);
    }
  }
  if (sub === 'knowledge' || sub === 'playbook') return runKnowledgeCommand(sub, argv.slice(1));
  if (sub === 'agents-snippet' && argv.length === 1) {
    process.stdout.write(fs.readFileSync(new URL('../docs/agents-snippet.md', import.meta.url), 'utf8'));
    return EXIT.OK;
  }
  if (sub === 'mcp') {
    const { runMcpServer } = await import('./mcp.js');
    await runMcpServer();
    return -1; // keep running; the server exits on stdin close
  }
  if (sub === 'setup' || sub === 'doctor' || sub === 'standby') {
    const { realSys } = await import('./setup/sys.js');
    const sys = realSys();
    if (sub === 'setup') return (await import('./setup/setup.js')).runSetup(sys, argv.slice(1));
    if (sub === 'doctor' && argv.length === 2 && argv[1] === '--json') return (await import('./setup/doctor.js')).runDoctor(sys, { json: true });
    if (argv.length > 1) {
      err(`ask ${sub} takes no arguments${sub === 'doctor' ? ' except --json' : ''}`);
      return EXIT.USAGE;
    }
    if (sub === 'doctor') return (await import('./setup/doctor.js')).runDoctor(sys);
    return (await import('./setup/standby.js')).runStandby(sys);
  }

  const ac = new AbortController();
  /** @type {string|null} */
  let currentId = null;
  /** @type {ReturnType<typeof createClient>|undefined} */
  let client;
  const onSigint = () => {
    ac.abort();
    err(
      currentId
        ? `\nInterrupted. Question ${currentId} is saved; fetch the answer later with:\n  ask --resume ${currentId}`
        : `\nInterrupted. The question is saved locally; run \`ask --resume\` to continue.`,
    );
    process.exit(EXIT.INTERRUPTED);
  };

  try {
    const { values, positionals } = parse(argv);
    if (values.help) {
      process.stdout.write(HELP);
      return EXIT.OK;
    }
    if (values.version) {
      process.stdout.write(VERSION + '\n');
      return EXIT.OK;
    }
    const timeoutSec = parseTimeout(values.timeout);
    const json = !!values.json;
    const noSave = !!values['no-save'];

    const { hubUrl } = resolveHubUrl();
    const store = new PendingStore(pendingFilePath());
    client = createClient({ hubUrl, via: 'cli', log: (m) => err(`ask: ${m}`), onAskUpdate: (update) => err(formatAskUpdate(update)) });
    process.on('SIGINT', onSigint);

    if (values.list) {
      if (positionals.length) throw new UsageError('--list takes no arguments');
      const [p, a] = await Promise.all([client.list('pending'), client.list('answered')]);
      const qs = [...(p.questions ?? []), ...(a.questions ?? [])].sort((x, y) =>
        String(y.created_at).localeCompare(String(x.created_at)),
      );
      const local = store.all().filter((e) => !e.id || !qs.some((q) => q.id === e.id));
      const queue = await fetchNotices(client, (m) => err(`ask: ${m}`));
      const shown = queue?.notices ?? [];
      if (json) {
        await printJson(client, { questions: qs, local_only: local, ...(queue ? { notices: shown, ...(queue.more ? { more_notices: queue.more } : {}) } : {}) }, 2);
      } else {
        for (const q of qs) {
          // source and route columns only when the hub provides them (contract change 2).
          const extra = q.source !== undefined || q.route !== undefined ? `\t${q.source ?? '-'}\t${q.route ?? '-'}` : '';
          const project = 'route' in q ? (q.project ?? '-') : q.project;
          process.stdout.write(`${q.id}\t${q.status}\t${project}${extra}\t${q.created_at}\t${q.question_preview ?? ''}\n`);
        }
        for (const e of local) {
          process.stdout.write(`${e.id ?? '(not sent)'}\tlocal\t${e.project ?? e.repo ?? ''}\t${e.created_at}\t${e.question.slice(0, 80)}\n`);
        }
        if (!qs.length && !local.length) err('No pending or undelivered questions.');
        const section = formatNotices(queue);
        if (section) process.stdout.write(`\n${section}\n`);
      }
      // The receipt: only after the notices were printed. A failure is a warning and the notice stays queued.
      await sendSeen(client, shown, (m) => err(`ask: ${m}`));
      return EXIT.OK;
    }

    if (values.resume) {
      if (positionals.length > 1) throw new UsageError('--resume takes at most one question id');
      const target = await findResumeTarget(client, store, positionals[0]);
      if (!target) {
        err('ask: nothing to resume: no pending questions locally or on the hub.');
        return EXIT.USAGE;
      }
      let entry = target.entry;
      if (!target.id && entry) {
        // The POST never returned an id: retry it with the same client_request_id.
        err('Re-sending the saved question (same request id, so it cannot be duplicated)…');
        entry = await submitQuestion(client, store, entry, ac.signal);
      }
      const id = /** @type {string} */ (entry?.id ?? target.id);
      currentId = id;
      err(`Resuming ${id} (${target.reason})…`);
      return await waitPrintReceipt(
        client,
        store,
        { id, client_request_id: entry?.client_request_id ?? target.client_request_id },
        { timeoutSec, json, signal: ac.signal, noSave },
      );
    }

    // Ask a new question.
    const question = positionals.join(' ').trim();
    if (!question) throw new UsageError('no question given');
    if (question.length > 4000) throw new UsageError(`question is ${question.length} characters; the limit is 4000`);
    if (values.repo && values.project) throw new UsageError('give --repo or --project, not both');
    if (values['context-file'] && values.context !== undefined) {
      throw new UsageError('give --context-file or --context, not both');
    }
    let context;
    if (values['context-file']) {
      try {
        context = fs.readFileSync(values['context-file'], 'utf8');
      } catch (e) {
        throw new UsageError(`cannot read --context-file: ${/** @type {Error} */ (e).message}`);
      }
    } else if (values.context === '-') {
      context = await readStdin();
    } else if (values.context !== undefined) {
      context = values.context;
    }
    if (context !== undefined && context.length > 8000) {
      throw new UsageError(`context is ${context.length} characters; the limit is 8000`);
    }

    let repo = values.repo;
    let branch = values.branch;
    const project = values.project;
    if (!repo && !project) {
      const g = await gitInfo(process.cwd());
      if (!g.inRepo) throw new UsageError('not in a git repository; pass --repo org/name or --project slug');
      if (!g.repo) throw new UsageError('this git repository has no "origin" remote; pass --repo org/name or --project slug');
      repo = g.repo;
      branch = branch ?? g.branch ?? undefined;
    } else if (!branch && repo) {
      const g = await gitInfo(process.cwd());
      if (g.repo === repo && g.branch) branch = g.branch;
    }

    const entry = await submitQuestion(client, store, { question, repo, project, branch, context }, ac.signal);
    currentId = entry.id;
    // One immediate read tells us who will answer (contract change 2); an older hub does not say.
    let answerer = null;
    try {
      answerer = (await client.get(/** @type {string} */ (entry.id), 0, ac.signal)).answerer ?? null;
    } catch {}
    err(`Asked ${entry.id} (${project ? `project ${project}` : repo}${branch ? `, branch ${branch}` : ''}). ${answerer ? `Waiting for ${answerer}'s answer…` : "Waiting for the owner's answer…"}`);
    err(`If you stop waiting, fetch the answer later with: ask --resume ${entry.id}`);
    return await waitPrintReceipt(client, store, /** @type {any} */ (entry), { timeoutSec, json, signal: ac.signal, noSave });
  } catch (e) {
    if (e instanceof Aborted) return EXIT.INTERRUPTED;
    return fail(e);
  } finally {
    process.off('SIGINT', onSigint);
    await client?.askUpdate();
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
if (isMain) {
  main(process.argv.slice(2)).then((code) => {
    if (code >= 0) process.exitCode = code;
  });
}

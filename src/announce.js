// @ts-check
import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import path from 'node:path';
import { resolveHubUrl } from './config.js';
import { pendingFilePath } from './pending.js';
import { createClient, HubError } from './client.js';
import { formatAskUpdate, normaliseVersion } from './update.js';

const SECTIONS = /** @type {const} */ ([
  ['What changed', 'what_changed'],
  ['Why you need to do something', 'why_you_act'],
  ['What to run', 'what_to_run'],
  ["What you're learning", 'what_youre_learning'],
]);
const SECRET = /\bxox[abeposr]-|\bxapp-|\bsk-|\bgh[pousr]_|\bgithub_pat_|-----BEGIN [A-Z ]*PRIVATE KEY-----|[a-z][a-z0-9+.-]*:\/\/[^\s/@]+:[^\s/@]*@|\bgit@[a-z0-9.-]+:/i;

/** @typedef {typeof SECTIONS[number][1]} Section */

export class NoticeError extends Error {}

/** @param {string} markdown */
function parseNotice(markdown) {
  const lines = markdown.trim().split(/\r?\n/);
  const title = /^#\s+(.+)$/.exec(lines.shift() ?? '')?.[1]?.trim();
  if (!title || title.length > 100) throw new NoticeError('the file must start with a # title of 1–100 characters');
  /** @type {Partial<Record<Section, string[]>>} */
  const sections = {};
  /** @type {Section|undefined} */
  let key;
  let fence = '';
  for (const line of lines) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = '';
    } else if (marker) {
      fence = marker[1];
    } else {
      const heading = /^##\s+(.+)$/.exec(line)?.[1]?.trim().replace('’', "'");
      const section = SECTIONS.find(([label]) => label === heading);
      if (section) {
        const [label, next] = section;
        if (sections[next]) throw new NoticeError(`repeated section “${label}”`);
        key = next;
        sections[key] = [];
        continue;
      }
    }
    if (key) sections[key]?.push(line);
    else if (line.trim()) throw new NoticeError('put all notice text under one of the four section headings');
  }
  if (fence) throw new NoticeError('close the fenced code block in the notice file');

  const fields = SECTIONS.map(([label, k]) => {
    const value = sections[k]?.join('\n').trim();
    if (!value) throw new NoticeError(`add a non-empty “${label}” section`);
    if (value.length > 2500) throw new NoticeError(`“${label}” is longer than 2,500 characters`);
    return [k, value];
  });
  return { title, .../** @type {Record<Section, string>} */ (Object.fromEntries(fields)) };
}

const SUMMARY_LINES = 5;
const SUMMARY_LINE_MAX = 200;
const NOT_WITH_SUMMARY = ['to', 'ask-version', 'update-command', 'mention', 'list', 'template'];

/** The machine's local date as YYYY-MM-DD. @param {Date} [now] */
function localDay(now = new Date()) {
  const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** @param {string} text */
function parseSummary(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 1 || lines.length > SUMMARY_LINES) throw new NoticeError(`the summary file needs 1–${SUMMARY_LINES} non-blank lines (it has ${lines.length})`);
  const long = lines.findIndex((l) => l.length > SUMMARY_LINE_MAX);
  if (long >= 0) throw new NoticeError(`summary line ${long + 1} is longer than ${SUMMARY_LINE_MAX} characters`);
  if (lines.some((l) => SECRET.test(l))) throw new NoticeError('the summary looks like it contains a secret or a credentialed or clone URL');
  return lines;
}

/** The DM text the hub sends (contract change 13): a bold header, then the lines as bullets. @param {string} day @param {string[]} lines */
export function summaryText(day, lines) {
  return [`*drunkbot evening summary, ${day}*`, ...lines.map((l) => `• ${l}`)].join('\n');
}

/**
 * One client_request_id per hub and day, kept in ask's state directory so a retry the same day
 * reuses it (the hub then answers a repeat instead of sending twice).
 * @param {string} hubUrl @param {string} day
 */
function summaryRequestId(hubUrl, day) {
  const key = createHash('sha256').update(hubUrl).digest('hex').slice(0, 24);
  const file = path.join(path.dirname(pendingFilePath()), `summary-${key}.json`);
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved?.day === day && typeof saved.client_request_id === 'string') return saved.client_request_id;
  } catch {
    // none yet, or unreadable: make a new one
  }
  const id = randomUUID();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ day, client_request_id: id }));
  } catch {
    // not fatal: without the file a retry gets a new id and the hub answers 409 already_sent_today
  }
  return id;
}

/**
 * @param {{summary?: boolean, attention?: boolean, file?: string, day?: string, json?: boolean, 'dry-run'?: boolean}} values
 * @param {(line: string) => void} print @param {(data: unknown) => void} printJson
 * @param {() => ReturnType<typeof createClient>} connect
 * @returns {Promise<number|undefined>} a non-zero exit code when the goal was not met
 */
async function runSummaryOrAttention(values, print, printJson, connect) {
  const given = /** @type {Record<string, unknown>} */ (values);
  if (values.summary && values.attention) throw new NoticeError('--summary and --attention cannot be combined');
  if (NOT_WITH_SUMMARY.some((key) => key in given)) {
    throw new NoticeError(`--${values.summary ? 'summary' : 'attention'} cannot be combined with --to, --ask-version, --update-command, --mention, --list or --template`);
  }
  if (values.attention) {
    if (['file', 'day', 'dry-run'].some((key) => key in given)) throw new NoticeError('--attention takes only --json');
    const client = connect();
    const a = await client.attention();
    if (values.json) {
      printJson(a);
      return;
    }
    const facts = [];
    const q = a.questions_waiting;
    if (q?.count > 0) {
      const oldest = Math.max(...q.items.map((/** @type {any} */ i) => i.age_minutes));
      const age = oldest >= 60 ? `${Math.floor(oldest / 60)}h` : `${oldest}m`;
      facts.push(`${q.count} question${q.count === 1 ? '' : 's'} waiting (oldest ${age})`);
    }
    const n = a.unconfirmed_notices;
    if (n?.count > 0) {
      for (const item of n.items) facts.push(`1 notice not confirmed after 24h: ${item.title} (${(item.behind ?? item.to).join(', ')})`);
      if (n.count > n.items.length) facts.push(`${n.count - n.items.length} more notices not confirmed after 24h`);
    }
    print(facts.length ? facts.join('\n') : 'nothing waiting');
    return;
  }

  if (!values.file) throw new NoticeError('give --file with the summary lines');
  if (values.day !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(values.day)) throw new NoticeError('--day must be YYYY-MM-DD');
  const day = values.day ?? localDay();
  let text;
  try {
    text = fs.readFileSync(values.file, 'utf8');
  } catch (e) {
    throw new NoticeError(`cannot read --file: ${/** @type {Error} */ (e).message}`);
  }
  const lines = parseSummary(text);
  if (values['dry-run']) {
    if (values.json) printJson({ kind: 'summary', day, lines });
    else print(summaryText(day, lines));
    return;
  }

  const client = connect();
  const { teammate } = await client.whoami();
  const body = { kind: 'summary', client_request_id: summaryRequestId(client.hubUrl, day), day, dm: [teammate], lines };
  let response;
  try {
    response = await client.announceSummary(body);
  } catch (e) {
    if (e instanceof HubError && e.code === 'already_sent_today') {
      if (values.json) printJson({ status: 'already_sent_today', day });
      else print('already sent today');
      return;
    }
    throw e;
  }
  const { status, data } = response;
  if (values.json) printJson(data);
  else if (status === 200) print('already sent today');
  else if (data.status === 'sent') print(`sent: ${data.id}`);
  else print(`pending: ${data.id} (the hub stored it but Slack has not confirmed; run the same command again)`);
  if (data.status === 'pending') return 4;
}

/** @param {string[]} args @returns {Promise<number|undefined>} */
export async function runAnnounce(args) {
  let values;
  try {
    ({ values } = parseArgs({
      args,
      options: {
        to: { type: 'string', multiple: true },
        file: { type: 'string' },
        'ask-version': { type: 'string' },
        'update-command': { type: 'string' },
        mention: { type: 'string', multiple: true },
        'dry-run': { type: 'boolean' },
        json: { type: 'boolean' },
        list: { type: 'boolean' },
        template: { type: 'boolean' },
        summary: { type: 'boolean' },
        attention: { type: 'boolean' },
        day: { type: 'string' },
      },
    }));
  } catch (e) {
    throw new NoticeError(/** @type {Error} */ (e).message);
  }

  /** @param {string} line */
  const print = (line) => process.stdout.write(`${line}\n`);
  /** @param {unknown} data */
  const printJson = (data) => print(JSON.stringify(data, null, 2));
  const postFlags = ['to', 'file', 'ask-version', 'update-command', 'mention', 'dry-run'];
  if ((values.list || values.template) && postFlags.some((key) => key in values)) {
    throw new NoticeError('--list and --template cannot be combined with notice posting flags');
  }
  if (values.summary || values.attention) {
    return runSummaryOrAttention(values, print, printJson, () => createClient({
      hubUrl: resolveHubUrl().hubUrl,
      via: 'cli',
      onAskUpdate: (update) => process.stderr.write(`${formatAskUpdate(update)}\n`),
    }));
  }
  if ('day' in values) throw new NoticeError('--day is only for --summary');
  if (values.template) {
    if (values.list || values.json) throw new NoticeError('--template takes no other flags');
    print(['# Notice title', ...SECTIONS.map(([label]) => `## ${label}`)].join('\n\n'));
    return;
  }

  const connect = () => createClient({
    hubUrl: resolveHubUrl().hubUrl,
    via: 'cli',
    onAskUpdate: (update) => process.stderr.write(`${formatAskUpdate(update)}\n`),
  });
  if (values.list) {
    const client = connect();
    const response = await client.listNotices();
    const update = await client.askUpdate();
    if (values.json) printJson({ ...response, ...(update ? { ask_update: update } : {}) });
    else {
      if (!response.notices.length) print('No update notices.');
      for (const n of response.notices) {
        print(`${n.title} (${n.id}${n.ask_version ? `, ask ${n.ask_version}` : ''}) — ${n.status}`);
        for (const c of n.channels) print(`  ${c.permalink ?? c.channel}${c.ticked ? ' ✅' : ''}`);
        for (const a of n.audience) print(`  ${a.teammate}: ${a.status}${a.seen ? ` (${a.seen})` : ''}`);
      }
    }
    return;
  }

  const to = values.to ?? [];
  if (!values.file || to.length < 1 || to.length > 3 || to.some((name) => !name.trim())) {
    throw new NoticeError('give --file and one to three --to names');
  }
  const mention = values.mention ?? [];
  if (mention.length > 5 || mention.some((name) => !name.trim())) throw new NoticeError('give up to five non-empty --mention names');
  const version = normaliseVersion(values['ask-version']);
  if (values['ask-version'] !== undefined && !version) throw new NoticeError('--ask-version must use major.minor.patch');
  const command = values['update-command']?.trim();
  if (command !== undefined && (!version || !command || command.length > 500)) {
    throw new NoticeError('--update-command needs --ask-version and 1–500 characters');
  }

  let markdown;
  try {
    markdown = fs.readFileSync(values.file, 'utf8');
  } catch (e) {
    throw new NoticeError(`cannot read --file: ${/** @type {Error} */ (e).message}`);
  }
  if ([markdown, command ?? '', ...to, ...mention].some((value) => SECRET.test(value))) {
    throw new NoticeError('the notice looks like it contains a secret or a credentialed or clone URL');
  }

  const notice = {
    to: [...new Set(to)],
    ...parseNotice(markdown),
    ...(version ? { ask_version: version } : {}),
    ...(command ? { update_command: command } : {}),
    mention: [...new Set(mention)],
  };
  // Repeat the same payload after a connection loss or a partial post to finish the notice without duplicates.
  const digest = createHash('sha256').update(JSON.stringify(notice)).digest('hex');
  const requestId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-8${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
  const body = { client_request_id: requestId, ...notice };
  if (values['dry-run']) {
    if (values.json) printJson(body);
    else {
      print(`To: ${notice.to.join(', ')}`);
      if (mention.length) print(`Mention: ${notice.mention.join(', ')}`);
      if (version) print(`Release: ${version}`);
      if (command) print(`Update command: ${command}`);
      print(`\n# ${notice.title}`);
      for (const [label, key] of SECTIONS) print(`\n## ${label}\n${notice[key]}`);
    }
    return;
  }

  const client = connect();
  const response = await client.announce(body);
  const update = await client.askUpdate();
  if (values.json) printJson({ ...response, ...(update ? { ask_update: update } : {}) });
  else {
    for (const p of response.posted) print(p.permalink ?? `${p.channel} ${p.ts}`);
  }
}

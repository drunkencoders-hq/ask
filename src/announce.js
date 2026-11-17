// @ts-check
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { resolveHubUrl } from './config.js';
import { createClient } from './client.js';
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

/** @param {string[]} args */
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

// @ts-check
// Hub HTTP API v1 client and the shared ask flow used by both the CLI and
// the MCP server: create (idempotent, retried), long-poll wait, receipt.
import os from 'node:os';
import fs from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { trackAskUpdate } from './update.js';

export const VERSION = JSON.parse(
  fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

/** @param {'cli'|'mcp'} via */
export function versionHeaders(via) {
  return { 'X-Ask-Version': VERSION, 'X-Ask-Client': via };
}

/** Codes the hub uses to refuse a question; shown verbatim, exit 5. */
export const REFUSAL_CODES = new Set([
  'unknown_caller',
  'unknown_project',
  'no_owner_configured',
  'chat_unavailable',
  'not_your_question',
  'unknown_question',
]);

export const PENDING_STATUSES = new Set(['received', 'interpreting', 'posted']);

/** The hub answered with an error body. */
export class HubError extends Error {
  /** @param {number} status @param {string} code @param {string} message */
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** The hub could not be reached (network error, timeout, 5xx without a known code). */
export class HubUnreachable extends Error {}

/** A wait was cancelled (Ctrl-C, MCP cancellation). */
export class Aborted extends Error {}

/** An attachment could not be downloaded or did not verify. `final` = retrying cannot help. */
export class AttachmentError extends Error {
  /** @param {string} message @param {boolean} [final] */
  constructor(message, final = false) {
    super(message);
    this.final = final;
  }
}

/** The most an attachment may be (the hub allows 10 MB per file). */
export const MAX_ATTACHMENT_BYTES = 11 * 1024 * 1024;

/** @param {number} ms @param {AbortSignal} [signal] */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Aborted('aborted'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(undefined);
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Aborted('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * @param {{ hubUrl: string, via: 'cli'|'mcp', log?: (msg: string) => void, fetchImpl?: typeof fetch,
 *           retryDelaysMs?: number[], maxBackoffMs?: number, tools?: string[], attachmentRetryMs?: number,
 *           updateState?: import('./config.js').Platform & { fs?: typeof fs },
 *           onAskUpdate?: (update: import('./update.js').AskUpdate) => void }} opts
 */
export function createClient(opts) {
  const base = opts.hubUrl.replace(/\/+$/, '');
  const doFetch = opts.fetchImpl ?? fetch;
  const log = opts.log ?? (() => {});
  const firstRetries = opts.retryDelaysMs ?? [500, 1000, 2000];
  const maxBackoff = opts.maxBackoffMs ?? 30_000;
  const headers = versionHeaders(opts.via);
  const update = trackAskUpdate({
    hubUrl: base,
    current: VERSION,
    details: () => request('GET', '/v1/ask-version', undefined, { timeoutMs: 2000 }).then((r) => r.data),
    state: opts.updateState,
    onUpdate: opts.onAskUpdate,
  });
  const clientInfo = {
    name: 'ask',
    version: VERSION,
    via: opts.via,
    host: os.hostname(),
    os: process.platform,
    tools: opts.tools ?? [],
  };

  /**
   * One HTTP call. Throws HubError for an error body, HubUnreachable otherwise.
   * @param {string} method @param {string} path @param {any} [body]
   * @param {{ timeoutMs?: number, signal?: AbortSignal }} [o]
   */
  async function request(method, path, body, o = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), o.timeoutMs ?? 15_000);
    const onOuter = () => ctrl.abort();
    o.signal?.addEventListener('abort', onOuter, { once: true });
    let res;
    try {
      res = await doFetch(base + path, {
        method,
        headers: body !== undefined ? { ...headers, 'content-type': 'application/json; charset=utf-8' } : headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      if (path !== '/v1/ask-version') update.observe(res.headers.get('X-Ask-Latest'));
      const text = await res.text();
      let data = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = null;
        }
      }
      if (res.ok && data) return { status: res.status, data };
      const err = data?.error;
      if (err && typeof err.code === 'string') {
        if (res.status >= 500 && !REFUSAL_CODES.has(err.code)) {
          throw new HubUnreachable(`hub error ${res.status} ${err.code}: ${err.message ?? ''}`);
        }
        throw new HubError(res.status, err.code, String(err.message ?? err.code));
      }
      throw new HubUnreachable(`unexpected hub response ${res.status} for ${method} ${path}`);
    } catch (e) {
      if (e instanceof HubError || e instanceof HubUnreachable) throw e;
      if (o.signal?.aborted) throw new Aborted('aborted');
      const cause = /** @type {any} */ (e).cause;
      const detail = cause?.code || cause?.message || /** @type {Error} */ (e).message;
      throw new HubUnreachable(`cannot reach hub at ${base}: ${detail}`);
    } finally {
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', onOuter);
    }
  }

  /**
   * Retry a call on HubUnreachable with the given delays; then rethrow.
   * @template T @param {() => Promise<T>} fn @param {string} what @param {AbortSignal} [signal]
   * @returns {Promise<T>}
   */
  async function withRetries(fn, what, signal) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (e) {
        if (!(e instanceof HubUnreachable) || attempt >= firstRetries.length) throw e;
        log(`${what}: ${e.message}; retrying in ${Math.round(firstRetries[attempt] / 100) / 10}s`);
        await sleep(firstRetries[attempt], signal);
      }
    }
  }

  return {
    hubUrl: base,
    clientInfo,
    askUpdate: update.get,
    health: () => withRetries(() => request('GET', '/v1/health'), 'health').then((r) => r.data),
    whoami: () => withRetries(() => request('GET', '/v1/whoami'), 'whoami').then((r) => r.data),
    /** Knowledge sources to keep a read-only copy of (contract change 8); an older hub answers 404. */
    knowledge: () => withRetries(() => request('GET', '/v1/knowledge'), 'knowledge').then((r) => r.data),
    /** @param {Record<string, unknown>} body */
    announce: (body) => withRetries(() => request('POST', '/v1/announce', body), 'posting notice').then((r) => r.data),
    /** Evening summary (contract change 13): the whole response, so a repeat (200) can be told from a first send (201). @param {Record<string, unknown>} body */
    announceSummary: (body) => withRetries(() => request('POST', '/v1/announce', body), 'sending summary'),
    attention: () => withRetries(() => request('GET', '/v1/announce/attention'), 'reading attention').then((r) => r.data),
    listNotices: () => withRetries(() => request('GET', '/v1/announce'), 'listing notices').then((r) => r.data),

    /**
     * POST /v1/questions. Retried with the same client_request_id, so a lost
     * response cannot create a second question.
     * @param {Record<string, any>} body @param {AbortSignal} [signal]
     * @returns {Promise<{ id: string, status: string }>}
     */
    create: (body, signal) =>
      withRetries(
        () => request('POST', '/v1/questions', { ...body, client: clientInfo }, { signal }),
        'creating question',
        signal,
      ).then((r) => r.data),

    /** @param {string} id @param {number} wait @param {AbortSignal} [signal] */
    get: (id, wait, signal) =>
      request('GET', `/v1/questions/${encodeURIComponent(id)}?wait=${wait}`, undefined, {
        timeoutMs: (wait + 15) * 1000,
        signal,
      }).then((r) => r.data),

    /** @param {string} id */
    receipt: (id) =>
      withRetries(
        () => request('POST', `/v1/questions/${encodeURIComponent(id)}/receipt`, { delivered_via: opts.via }),
        'sending receipt',
      ).then((r) => r.data),

    /**
     * Download one attachment of an answer (contract change 6) and verify its
     * size and sha256. A transient failure or a mismatch is retried once; 404,
     * 410 and 403 are final. Never throws anything but AttachmentError.
     * @param {string} questionId
     * @param {{ id: string, bytes: number, sha256: string, filename?: string }} att
     * @returns {Promise<Buffer>}
     */
    async downloadAttachment(questionId, att) {
      const url = `${base}/v1/questions/${encodeURIComponent(questionId)}/attachments/${encodeURIComponent(att.id)}`;
      let last = new AttachmentError('not downloaded');
      for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt > 0) await sleep(opts.attachmentRetryMs ?? 500);
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 60_000);
        try {
          const res = await doFetch(url, { method: 'GET', headers, signal: ctrl.signal });
          update.observe(res.headers.get('X-Ask-Latest'));
          if (!res.ok) {
            const text = await res.text().catch(() => '');
            let code = '';
            try {
              code = JSON.parse(text)?.error?.code ?? '';
            } catch {}
            if (res.status === 410) throw new AttachmentError('the hub no longer keeps this file (removed after its retention period)', true);
            if (res.status === 404 || res.status === 403) throw new AttachmentError(`the hub does not have this file for you (${code || res.status})`, true);
            throw new AttachmentError(`the hub answered ${res.status}${code ? ` ${code}` : ''}`);
          }
          const declared = Number(res.headers.get('content-length'));
          if (Number.isFinite(declared) && declared > MAX_ATTACHMENT_BYTES) throw new AttachmentError(`the file is larger than ${MAX_ATTACHMENT_BYTES} bytes`, true);
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.length !== att.bytes) throw new AttachmentError(`size ${buf.length} does not match the announced ${att.bytes} bytes`);
          const sha = createHash('sha256').update(buf).digest('hex');
          if (sha !== String(att.sha256).toLowerCase()) throw new AttachmentError('sha256 does not match: the file was damaged or altered in transit; not used');
          return buf;
        } catch (e) {
          if (e instanceof AttachmentError) {
            last = e;
            if (e.final) throw e;
          } else {
            const cause = /** @type {any} */ (e).cause;
            last = new AttachmentError(`cannot reach the hub: ${cause?.code || cause?.message || /** @type {Error} */ (e).message}`);
          }
        } finally {
          clearTimeout(timer);
        }
      }
      throw last;
    },

    /** Notices queued for me (contract change 15); an older hub answers 404. */
    notices: () => withRetries(() => request('GET', '/v1/notices/mine'), 'reading notices').then((r) => r.data),
    /** The receipt for a notice shown to me. Idempotent. @param {string} id */
    markNoticeSeen: (id) =>
      withRetries(() => request('POST', `/v1/notices/${encodeURIComponent(id)}/seen`), 'marking notice seen').then((r) => r.data),

    /** @param {'pending'|'answered'|'all'} status */
    list: (status) =>
      withRetries(() => request('GET', `/v1/questions?mine=1&status=${status}`), 'listing').then((r) => r.data),

    /**
     * Long-poll until the question leaves the pending statuses, or until
     * `timeoutSec` (0 = forever) runs out. Transient errors never end the wait.
     * @param {string} id
     * @param {{ timeoutSec?: number, signal?: AbortSignal, onUpdate?: (q: any) => void }} [o]
     * @returns {Promise<{ done: true, question: any } | { done: false, question: any }>}
     */
    async waitFor(id, o = {}) {
      const deadline = o.timeoutSec ? Date.now() + o.timeoutSec * 1000 : Infinity;
      let backoff = 1000;
      let last = null;
      for (;;) {
        const remaining = Math.ceil((deadline - Date.now()) / 1000);
        if (deadline !== Infinity && remaining <= 0) return { done: false, question: last };
        const wait = Math.max(0, Math.min(50, remaining));
        try {
          const q = await this.get(id, wait, o.signal);
          backoff = 1000;
          last = q;
          o.onUpdate?.(q);
          if (!PENDING_STATUSES.has(q.status)) return { done: true, question: q };
        } catch (e) {
          if (e instanceof Aborted || o.signal?.aborted) throw new Aborted('aborted');
          if (!(e instanceof HubUnreachable)) throw e;
          const pause = Math.min(backoff, Math.max(0, deadline - Date.now()));
          log(`waiting for ${id}: ${e.message}; retrying in ${Math.round(pause / 100) / 10}s`);
          await sleep(pause, o.signal);
          backoff = Math.min(backoff * 2, maxBackoff);
        }
      }
    },
  };
}

/** @typedef {ReturnType<typeof createClient>} Client */

/**
 * Shared flow, step 1: record the question locally, then create it on the hub.
 * Reuses a stored client_request_id when given an existing entry.
 * @param {Client} client
 * @param {import('./pending.js').PendingStore} store
 * @param {Partial<import('./pending.js').PendingEntry> & { question?: string }} input
 * @param {AbortSignal} [signal]
 * @returns {Promise<import('./pending.js').PendingEntry>}
 */
export async function submitQuestion(client, store, input, signal) {
  /** @type {import('./pending.js').PendingEntry} */
  const entry = {
    client_request_id: input.client_request_id ?? randomUUID(),
    id: input.id ?? null,
    kind: input.kind ?? 'question',
    question: input.question ?? '',
    created_at: input.created_at ?? new Date().toISOString(),
  };
  for (const k of /** @type {const} */ (['repo', 'project', 'branch', 'context'])) {
    if (input[k]) entry[k] = input[k];
  }
  if (!input.client_request_id) store.add(entry); // written before the POST
  const body = {
    client_request_id: entry.client_request_id,
    kind: entry.kind,
    question: entry.question,
  };
  for (const k of /** @type {const} */ (['repo', 'project', 'branch', 'context'])) {
    if (entry[k]) /** @type {any} */ (body)[k] = entry[k];
  }
  let res;
  try {
    res = await client.create(body, signal);
  } catch (e) {
    // The hub gave a definite refusal: it stored nothing, so nothing to resume.
    if (e instanceof HubError) store.remove(entry.client_request_id);
    throw e;
  }
  entry.id = res.id;
  store.update(entry.client_request_id, { id: res.id });
  return entry;
}

/**
 * Shared flow, last step: send the receipt; drop the local entry only on success.
 * @param {Client} client @param {import('./pending.js').PendingStore} store
 * @param {{ client_request_id?: string, id: string }} entry
 * @returns {Promise<{ ok: true } | { ok: false, error: Error }>}
 */
export async function sendReceipt(client, store, entry) {
  try {
    await client.receipt(entry.id);
  } catch (e) {
    if (entry.client_request_id) store.update(entry.client_request_id, { receipt_failed: true });
    return { ok: false, error: /** @type {Error} */ (e) };
  }
  if (entry.client_request_id) store.remove(entry.client_request_id);
  else {
    const local = store.findById(entry.id);
    if (local) store.remove(local.client_request_id);
  }
  return { ok: true };
}

/**
 * Pick the question to resume: the given id (local or not: a question started
 * in Slack is only on the hub), else the newest local pending entry, else the
 * caller's oldest hub question that is answered but not delivered (any
 * source), else the oldest still pending. `reason` says why, for stderr.
 * @param {Client} client @param {import('./pending.js').PendingStore} store @param {string} [id]
 * @returns {Promise<{ client_request_id?: string, id: string|null, entry?: import('./pending.js').PendingEntry, reason: string } | null>}
 */
export async function findResumeTarget(client, store, id) {
  if (id) {
    const entry = store.findById(id);
    return { id, client_request_id: entry?.client_request_id, entry, reason: entry ? 'saved on this machine' : 'not saved on this machine; fetched from the hub' };
  }
  const entry = store.latest();
  if (entry) return { id: entry.id, client_request_id: entry.client_request_id, entry, reason: 'the most recent question saved on this machine' };
  const oldest = (qs) => [...(qs ?? [])].sort((x, y) => String(x.created_at).localeCompare(String(y.created_at)))[0];
  const answered = oldest((await client.list('answered')).questions);
  if (answered) {
    return { id: answered.id, reason: `your oldest answered question not yet delivered${answered.source ? ` (started from ${answered.source === 'slack' ? 'Slack' : 'ask'})` : ''}` };
  }
  const pending = oldest((await client.list('pending')).questions);
  if (pending) {
    return { id: pending.id, reason: `nothing answered is waiting; your oldest pending question${pending.source ? ` (started from ${pending.source === 'slack' ? 'Slack' : 'ask'})` : ''}` };
  }
  return null;
}

/** @param {string} iso */
function clock(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso ?? '');
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * Comments from the Slack thread, recorded before the answer. Other people's
 * text: shown as data, labelled as not the decision. Empty string when none.
 * @param {any} q
 */
export function formatComments(q) {
  const comments = Array.isArray(q.comments) ? q.comments : [];
  if (!comments.length) return '';
  const lines = ['COMMENTS from the thread before the answer (not the decision):'];
  for (const c of comments) {
    const text = String(c.text ?? '').replace(/\r\n?/g, '\n').split('\n').join('\n  ');
    lines.push(`- ${c.by}, ${clock(c.at)}: ${text}${c.truncated ? ' [cut at 4000 characters]' : ''}`);
  }
  return lines.join('\n');
}

/**
 * The first line of an answer: who answered and which question.
 * @param {any} q
 */
export function answerHead(q) {
  const by = q.answer?.answered_by ?? q.answerer ?? q.owner ?? 'owner';
  let where;
  if (q.route === 'mentor') where = `your mentor${q.project ? `, project ${q.project}` : ''}, ${q.id}`;
  else where = q.project != null || !('route' in q) ? `project ${q.project}, ${q.id}` : q.id;
  return `ANSWER from ${by} (${where}):`;
}

/**
 * The human-readable answer: the header line, the answer text and, when the
 * hub sent any, the comments block. Without route/comments (an older hub, or
 * an owner question with no comments) this is exactly the brief 02 output.
 * @param {any} q
 */
export function formatAnswer(q) {
  const head = `${answerHead(q)}\n${q.answer?.text ?? ''}`;
  const comments = formatComments(q);
  return comments ? `${head}\n\n${comments}` : head;
}

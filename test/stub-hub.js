// @ts-check
// Test fixture: an in-process HTTP server implementing Hub HTTP API v1
// (brief 01, "Hub HTTP API v1") closely enough to test the ask client.
// Not a product. Single caller identity per stub (configurable).
import http from 'node:http';

const TERMINAL_WAKE = new Set(['answered', 'delivered', 'failed']);

/**
 * @typedef {{
 *   teammate?: string,                 // whoami; null → every route but health returns 403 unknown_caller
 *   projects?: Record<string, { repo?: string, owner?: string|null }>,
 *   chatConnected?: boolean,
 *   autoAnswerMs?: number|null,        // answer every new question after this many ms
 *   autoAnswerText?: string,
 * }} StubOptions
 */

/** @param {StubOptions} [opts] */
export async function startStubHub(opts = {}) {
  const state = {
    teammate: opts.teammate === undefined ? 'nora' : opts.teammate,
    projects: opts.projects ?? { sandbox: { repo: 'drunkencoders-hq/sandbox', owner: 'jose' } },
    chatConnected: opts.chatConnected ?? true,
    autoAnswerMs: opts.autoAnswerMs ?? null,
    autoAnswerText: opts.autoAnswerText ?? 'JSON, please.',
    /** @type {Map<string, any>} */
    questions: new Map(),
    /** @type {Map<string, string>} key asked_by|client_request_id → id */
    idem: new Map(),
    seq: 0,
    /** count of incoming requests per "METHOD path-pattern" */
    calls: /** @type {Record<string, number>} */ ({}),
    /** fault injection */
    dropNextCreateResponses: 0, // process the create (new or repeated), then destroy the socket
    failReceipts: 0, // next N receipts → socket destroyed
    refuseNextCreate: /** @type {null|{status:number, code:string, message:string}} */ (null),
    /** @type {Set<() => void>} */
    waiters: new Set(),
    /** @type {any[]} */
    createBodies: [],
    /** @type {any[]} */
    receiptBodies: [],
  };

  const notify = () => {
    for (const w of [...state.waiters]) w();
  };

  /** @param {http.ServerResponse} res @param {number} status @param {any} body */
  const send = (res, status, body) => {
    const s = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(s) });
    res.end(s);
  };
  /** @param {http.ServerResponse} res @param {number} status @param {string} code @param {string} message */
  const error = (res, status, code, message) => send(res, status, { error: { code, message } });

  const view = (q) => ({
    id: q.id,
    kind: q.kind,
    status: q.status,
    project: q.project,
    asked_by: q.asked_by,
    source: 'ask',
    created_at: q.created_at,
    owner: q.owner,
    card: q.card,
    interpretation: q.interpretation,
    answer: q.answer,
    delivered_at: q.delivered_at,
    error: q.error,
  });

  /** @param {any} q @param {Partial<any>} patch */
  const setQ = (q, patch) => {
    Object.assign(q, patch);
    notify();
  };

  /** @param {any} q @param {string} text @param {string} [by] @param {string} [via] */
  const answer = (q, text, by = q.owner, via = 'thread') =>
    setQ(q, { status: 'answered', answer: { text, option_id: null, answered_by: by, answered_at: new Date().toISOString(), via } });

  const newId = () => {
    state.seq += 1;
    return `q_01STUB${String(state.seq).padStart(6, '0')}`;
  };

  /** @param {http.IncomingMessage} req */
  const readBody = (req) =>
    new Promise((resolve) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const t = Buffer.concat(chunks).toString('utf8');
        try {
          resolve(t ? JSON.parse(t) : {});
        } catch {
          resolve(undefined);
        }
      });
    });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://stub');
    const m = req.method ?? 'GET';
    const p = url.pathname;
    const key = `${m} ${p.replace(/\/q_[^/]+/, '/{id}')}`;
    state.calls[key] = (state.calls[key] ?? 0) + 1;

    if (m === 'GET' && p === '/v1/health') {
      return send(res, 200, { ok: true, version: '0.1.0-stub', chat: 'fake', chat_connected: state.chatConnected, interpreter: 'fake', identity: 'dev' });
    }
    if (!state.teammate) return error(res, 403, 'unknown_caller', 'This machine is not a known teammate on the tailnet.');
    const me = state.teammate;

    if (m === 'GET' && p === '/v1/whoami') return send(res, 200, { teammate: me, via: 'dev' });

    if (m === 'POST' && p === '/v1/questions') {
      const body = await readBody(req);
      state.createBodies.push(body);
      if (!body || typeof body.client_request_id !== 'string' || !body.client_request_id) {
        return error(res, 400, 'invalid_request', 'client_request_id is required');
      }
      const k = `${me}|${body.client_request_id}`;
      if (state.idem.has(k)) {
        const q = state.questions.get(state.idem.get(k));
        if (state.dropNextCreateResponses > 0) {
          state.dropNextCreateResponses -= 1;
          req.socket.destroy();
          return;
        }
        return send(res, 200, { id: q.id, status: q.status });
      }
      if (state.refuseNextCreate) {
        const r = state.refuseNextCreate;
        state.refuseNextCreate = null;
        return error(res, r.status, r.code, r.message);
      }
      const kind = body.kind ?? 'question';
      let projectSlug = null;
      if (kind === 'question') {
        if (typeof body.question !== 'string' || body.question.length < 1 || body.question.length > 4000) {
          return error(res, 400, 'invalid_request', 'question must be 1–4000 characters');
        }
        if (body.context !== undefined && (typeof body.context !== 'string' || body.context.length > 8000)) {
          return error(res, 400, 'invalid_request', 'context must be at most 8000 characters');
        }
        if (body.project) projectSlug = state.projects[body.project] ? body.project : null;
        else if (body.repo) projectSlug = Object.keys(state.projects).find((s) => state.projects[s].repo === body.repo) ?? null;
        else return error(res, 400, 'invalid_request', 'repo or project is required');
        if (!projectSlug) return error(res, 404, 'unknown_project', `No project is configured for ${body.project ?? body.repo}.`);
        if (!state.projects[projectSlug].owner) {
          return error(res, 409, 'no_owner_configured', `Project ${projectSlug} has no owner configured; nobody can answer.`);
        }
        if (!state.chatConnected) return error(res, 503, 'chat_unavailable', 'The hub is not connected to Slack right now.');
      } else if (kind !== 'standby_test') {
        return error(res, 400, 'invalid_request', `unknown kind ${kind}`);
      }
      const id = newId();
      const q = {
        id,
        kind,
        status: 'received',
        project: projectSlug,
        asked_by: me,
        created_at: new Date().toISOString(),
        owner: projectSlug ? state.projects[projectSlug].owner : null,
        card: null,
        interpretation: null,
        answer: null,
        delivered_at: null,
        error: null,
        question: body.question ?? '',
        body,
      };
      state.questions.set(id, q);
      state.idem.set(k, id);
      if (kind === 'standby_test') {
        answer(q, 'standby-ok', 'hub', 'system');
      } else {
        // Simulate interpreting → posted.
        setTimeout(() => {
          if (q.status === 'received') setQ(q, { status: 'posted', card: { channel: 'C0OFFICE', permalink: `https://example.invalid/archives/C0OFFICE/p${state.seq}` } });
        }, 20);
        if (state.autoAnswerMs != null) {
          setTimeout(() => {
            if (q.status !== 'answered' && q.status !== 'delivered') answer(q, state.autoAnswerText);
          }, state.autoAnswerMs);
        }
      }
      if (state.dropNextCreateResponses > 0) {
        state.dropNextCreateResponses -= 1;
        req.socket.destroy(); // stored, but the client never sees the response
        return;
      }
      return send(res, 201, { id, status: 'received' });
    }

    if (m === 'GET' && p === '/v1/questions') {
      if (url.searchParams.get('mine') !== '1') return error(res, 400, 'invalid_request', 'mine=1 is required');
      const st = url.searchParams.get('status') ?? 'all';
      const pending = new Set(['received', 'interpreting', 'posted']);
      const qs = [...state.questions.values()]
        .filter((q) => q.asked_by === me)
        .filter((q) => (st === 'pending' ? pending.has(q.status) : st === 'answered' ? q.status === 'answered' : true))
        .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))
        .slice(0, 50)
        .map((q) => ({ id: q.id, status: q.status, project: q.project, created_at: q.created_at, question_preview: q.question.slice(0, 80) }));
      return send(res, 200, { questions: qs });
    }

    const mq = /^\/v1\/questions\/([^/]+)(\/receipt)?$/.exec(p);
    if (mq) {
      const q = state.questions.get(decodeURIComponent(mq[1]));
      if (!q) return error(res, 404, 'unknown_question', `No question ${mq[1]}.`);
      if (q.asked_by !== me) return error(res, 403, 'not_your_question', 'Only the asker may read this question.');

      if (m === 'POST' && mq[2]) {
        const body = await readBody(req);
        state.receiptBodies.push(body);
        if (state.failReceipts > 0) {
          state.failReceipts -= 1;
          req.socket.destroy();
          return;
        }
        if (q.status === 'answered') setQ(q, { status: 'delivered', delivered_at: new Date().toISOString() });
        else if (q.status !== 'delivered') return error(res, 409, 'not_answered', 'The question has not been answered yet.');
        return send(res, 200, { id: q.id, status: 'delivered' });
      }
      if (m === 'GET' && !mq[2]) {
        const wait = Number(url.searchParams.get('wait') ?? '0');
        if (!Number.isFinite(wait) || wait < 0 || wait > 55) return error(res, 400, 'invalid_request', 'wait must be 0–55');
        const startStatus = q.status;
        if (wait === 0 || TERMINAL_WAKE.has(q.status)) return send(res, 200, view(q));
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          state.waiters.delete(check);
          if (!res.writableEnded && !res.destroyed) send(res, 200, view(q));
        };
        const check = () => {
          if (q.status !== startStatus) finish();
        };
        const timer = setTimeout(finish, wait * 1000);
        state.waiters.add(check);
        req.on('close', () => {
          done = true;
          clearTimeout(timer);
          state.waiters.delete(check);
        });
        return;
      }
    }
    return error(res, 404, 'not_found', `${m} ${p}`);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const addr = /** @type {import('node:net').AddressInfo} */ (server.address());
  const url = `http://127.0.0.1:${addr.port}`;

  return {
    url,
    state,
    /** Answer a question as the owner (or `by`). */
    answer(id, text, by, via) {
      const q = state.questions.get(id);
      if (!q) throw new Error(`stub: no question ${id}`);
      answer(q, text, by, via);
    },
    /** Mark a question failed. */
    fail(id, message = 'card could not be posted') {
      const q = state.questions.get(id);
      setQ(q, { status: 'failed', error: { code: 'post_failed', message } });
    },
    get(id) {
      return state.questions.get(id);
    },
    /** Resolves with the id of the next/first question once it exists. */
    async waitForQuestion(n = 1, timeoutMs = 10_000) {
      const t0 = Date.now();
      while (state.questions.size < n) {
        if (Date.now() - t0 > timeoutMs) throw new Error('stub: timed out waiting for a question');
        await new Promise((r) => setTimeout(r, 10));
      }
      return [...state.questions.keys()][n - 1];
    },
    async waitForStatus(id, status, timeoutMs = 10_000) {
      const t0 = Date.now();
      while (state.questions.get(id)?.status !== status) {
        if (Date.now() - t0 > timeoutMs) throw new Error(`stub: ${id} never reached ${status}`);
        await new Promise((r) => setTimeout(r, 10));
      }
    },
    close() {
      for (const w of [...state.waiters]) w();
      server.closeAllConnections?.();
      return new Promise((resolve) => server.close(() => resolve(undefined)));
    },
  };
}

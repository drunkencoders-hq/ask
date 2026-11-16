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
 *   mentors?: Record<string, string>,  // mentee → mentor (contract change 2); default none
 *   legacy?: boolean,                  // answer in the pre-change-2 shape (no route/answerer/comments/source on lists)
 *   reachable?: () => boolean,         // false → every connection is dropped (hub not reachable yet)
 *   onboarding?: OnboardingOptions,    // contract change 4 (brief 08a §D)
 * }} StubOptions
 *
 * @typedef {{
 *   token: string,                     // the one live token (the stub keeps it in memory only)
 *   displayName?: string,              // Slack display name
 *   teammate?: string,                 // name written to config on "Register"
 *   mentor?: string|null,              // mentor on "Register" (null: a teammate without one)
 *   tailscaleLogin?: string|null,      // what whois reports; null → 403 caller_unidentified
 *   decision?: 'register'|'refuse'|'expire'|'manual',  // what happens after an identity report
 *   decideAfterMs?: number,
 *   registered?: boolean,              // start already registered (a second run)
 *   failProgress?: number,             // next N progress calls → 503 (or 'drop' them)
 *   rateLimit?: number,                // calls per token before 429 (default: none)
 * }} OnboardingOptions
 */

/** @param {StubOptions} [opts] */
export async function startStubHub(opts = {}) {
  const state = {
    teammate: opts.teammate === undefined ? 'nora' : opts.teammate,
    projects: opts.projects ?? { sandbox: { repo: 'drunkencoders-hq/sandbox', owner: 'jose' } },
    chatConnected: opts.chatConnected ?? true,
    autoAnswerMs: opts.autoAnswerMs ?? null,
    autoAnswerText: opts.autoAnswerText ?? 'JSON, please.',
    mentors: opts.mentors ?? {},
    legacy: opts.legacy ?? false,
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
    /** lines the hub would post to #runner */
    statusPosts: /** @type {string[]} */ ([]),
    /** @type {any} contract change 4 state, when opts.onboarding is set */
    onboarding: null,
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
    source: q.source,
    created_at: q.created_at,
    owner: q.owner,
    card: q.card,
    interpretation: q.interpretation,
    answer: q.answer,
    delivered_at: q.delivered_at,
    error: q.error,
    // contract change 2 (brief 01b §7): always present unless the stub plays an older hub.
    ...(state.legacy ? {} : { route: q.route, answerer: q.answerer, comments: q.comments }),
  });

  /** @param {any} q @param {Partial<any>} patch */
  const setQ = (q, patch) => {
    Object.assign(q, patch);
    notify();
  };

  /** @param {any} q @param {string} text @param {string} [by] @param {string} [via] */
  const answer = (q, text, by = q.answerer ?? q.owner, via = 'thread') =>
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

  // ---- Contract change 4: onboarding routes (brief 08a §C, §D, §F) ----
  const ob = opts.onboarding ?? null;
  state.onboarding = ob
    ? {
        state: ob.registered ? 'registered' : 'invited',
        tokenDead: false,
        registeredAt: ob.registered ? Date.now() : null,
        identity: /** @type {any} */ (null),
        boundLogin: /** @type {string|null} */ (null),
        calls: 0,
        failProgress: ob.failProgress ?? 0,
        /** accepted progress reports, in arrival order */
        progress: /** @type {any[]} */ ([]),
        /** lines the hub would post in the mentoring channel */
        posts: /** @type {string[]} */ ([]),
        seenRequestIds: new Set(),
        identityCalls: 0,
        helloCalls: 0,
      }
    : null;
  if (ob?.registered) registerTeammate();

  function registerTeammate() {
    const name = ob?.teammate ?? 'nora';
    state.teammate = name;
    if (ob?.mentor !== null) state.mentors[name] = ob?.mentor ?? 'jose';
  }

  /** @param {string} next */
  const setOb = (next) => {
    state.onboarding.state = next;
    notify();
  };

  /** Decide the registration (the approver's tap), as configured. */
  const decide = () => {
    const o = state.onboarding;
    if (o.state !== 'awaiting_approval') return;
    const d = ob.decision ?? 'register';
    if (d === 'register') {
      registerTeammate();
      o.registeredAt = Date.now();
      setOb('registered');
    } else if (d === 'refuse') {
      o.tokenDead = true;
      setOb('refused');
    } else if (d === 'expire') {
      o.tokenDead = true;
      notify();
    }
  };

  /** Token check per §C. @returns {string|null} error code, or null when valid for this route */
  const tokenError = (token, route) => {
    const o = state.onboarding;
    if (!o || typeof token !== 'string' || token !== ob.token || o.tokenDead) return 'invalid_token';
    if (o.state === 'registered') {
      // After approval the token works for progress only, for 60 minutes.
      if (route !== 'progress' || Date.now() - o.registeredAt > 60 * 60_000) return 'invalid_token';
    }
    if (o.state === 'refused') return 'invalid_token';
    const login = ob.tailscaleLogin === undefined ? 'nora@example.com' : ob.tailscaleLogin;
    if (login === null) return 'caller_unidentified';
    if (o.boundLogin && o.boundLogin !== login) return 'invalid_token';
    o.boundLogin = login;
    return null;
  };

  const tokenStatus = { invalid_token: 401, caller_unidentified: 403 };

  /** @param {http.IncomingMessage} req @param {http.ServerResponse} res @param {string} m @param {string} p */
  async function onboardingRoute(req, res, m, p) {
    const route = p.slice('/v1/onboarding/'.length);
    if (m !== 'POST' || !['hello', 'progress', 'identity', 'status'].includes(route)) return error(res, 404, 'not_found', `${m} ${p}`);
    const body = await readBody(req);
    if (!body || typeof body !== 'object') return error(res, 400, 'invalid_request', 'body must be JSON');
    const o = state.onboarding;
    const te = tokenError(body.token, route);
    if (te) return error(res, tokenStatus[te], te, te === 'invalid_token' ? 'This set-up token is not valid.' : 'The hub could not identify your Tailscale login.');
    o.calls += 1;
    if (ob.rateLimit && o.calls > ob.rateLimit) return error(res, 429, 'rate_limited', 'Too many calls for this token.');
    const login = ob.tailscaleLogin === undefined ? 'nora@example.com' : ob.tailscaleLogin;

    if (route === 'hello') {
      o.helloCalls += 1;
      if (o.state === 'invited') o.state = 'identified';
      return send(res, 200, { state: o.state, display_name: ob.displayName ?? 'Nora', teammate: o.state === 'registered' ? state.teammate : null, tailscale_login: login });
    }
    if (route === 'progress') {
      if (typeof body.step !== 'string' || !/^[a-z0-9-]{1,40}$/.test(body.step)) return error(res, 400, 'invalid_request', 'bad step');
      if (!['started', 'done', 'blocked', 'skipped'].includes(body.status)) return error(res, 400, 'invalid_request', 'bad status');
      if (body.note !== undefined && (typeof body.note !== 'string' || body.note.length > 300)) return error(res, 400, 'invalid_request', 'note must be at most 300 characters');
      if (typeof body.client_request_id !== 'string' || !body.client_request_id) return error(res, 400, 'invalid_request', 'client_request_id is required');
      if (o.seenRequestIds.has(body.client_request_id)) return send(res, 200, { ok: true, posted: false });
      if (o.failProgress > 0) {
        o.failProgress -= 1;
        return error(res, 503, 'chat_unavailable', 'The hub is not connected to Slack right now.');
      }
      if (body.step === 'ready' && body.status === 'done') {
        const standbyDelivered = [...state.questions.values()].some((q) => q.kind === 'standby_test' && q.asked_by === state.teammate && q.status === 'delivered');
        if (o.state !== 'registered' || !standbyDelivered) return error(res, 409, 'not_ready', 'Not registered, or no delivered standby test yet.');
      }
      o.seenRequestIds.add(body.client_request_id);
      o.progress.push({ step: body.step, status: body.status, note: body.note ?? null, client_request_id: body.client_request_id });
      const name = ob.displayName ?? 'Nora';
      o.posts.push(`Setup · ${name} · ${body.step}: ${body.status}${body.note ? ` — ${body.note}` : ''}`);
      if (body.step === 'ready' && body.status === 'done') o.posts.push(`<@approver> ${name} is ready. Tap the headphones icon here to start a huddle.`);
      return send(res, 201, { ok: true, posted: true });
    }
    if (route === 'identity') {
      o.identityCalls += 1;
      const id = { github_login: body.github_login, os: body.os, host: body.host, tools: body.tools };
      if (typeof body.github_login !== 'string' || !body.github_login || typeof body.os !== 'string' || typeof body.host !== 'string' || !Array.isArray(body.tools)) {
        return error(res, 400, 'invalid_request', 'github_login, os, host and tools are required');
      }
      if (o.identity) {
        if (JSON.stringify(o.identity) !== JSON.stringify(id)) return error(res, 409, 'identity_conflict', 'A different identity was already reported for this token.');
        return send(res, 200, { state: o.state });
      }
      o.identity = id;
      setOb('awaiting_approval');
      if (ob.decision !== 'manual') setTimeout(decide, ob.decideAfterMs ?? 50);
      return send(res, 202, { state: 'awaiting_approval' });
    }
    // status: long poll
    const wait = Number(body.wait ?? 0);
    if (!Number.isFinite(wait) || wait < 0 || wait > 55) return error(res, 400, 'invalid_request', 'wait must be 0–55');
    const start = o.state;
    const reply = () => {
      if (o.tokenDead && o.state !== 'refused') return error(res, 401, 'invalid_token', 'This set-up token is not valid.');
      return send(res, 200, { state: o.state, teammate: o.state === 'registered' ? state.teammate : null });
    };
    if (wait === 0 || start === 'registered' || start === 'refused') return reply();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      state.waiters.delete(check);
      if (!res.writableEnded && !res.destroyed) reply();
    };
    const check = () => {
      if (o.state !== start || o.tokenDead) finish();
    };
    const timer = setTimeout(finish, wait * 1000);
    state.waiters.add(check);
    req.on('close', () => {
      done = true;
      clearTimeout(timer);
      state.waiters.delete(check);
    });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://stub');
    const m = req.method ?? 'GET';
    const p = url.pathname;
    const key = `${m} ${p.replace(/\/q_[^/]+/, '/{id}')}`;
    state.calls[key] = (state.calls[key] ?? 0) + 1;

    if (opts.reachable && !opts.reachable()) {
      req.socket.destroy(); // like a hub not yet reachable over Tailscale
      return;
    }

    if (p.startsWith('/v1/onboarding/')) return onboardingRoute(req, res, m, p);

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
        const mentor = state.legacy ? null : (state.mentors[me] ?? null);
        if (body.project) {
          projectSlug = state.projects[body.project] ? body.project : null;
          // An explicit unknown project slug is refused on both routes.
          if (!projectSlug) return error(res, 404, 'unknown_project', `No project is configured for ${body.project}.`);
        } else if (body.repo) projectSlug = Object.keys(state.projects).find((s) => state.projects[s].repo === body.repo) ?? null;
        else if (!mentor) return error(res, 400, 'invalid_request', 'repo or project is required');
        if (!mentor) {
          // Owner route: exactly the brief 01 behaviour.
          if (!projectSlug) return error(res, 404, 'unknown_project', `No project is configured for ${body.project ?? body.repo}.`);
          if (!state.projects[projectSlug].owner) {
            return error(res, 409, 'no_owner_configured', `Project ${projectSlug} has no owner configured; nobody can answer.`);
          }
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
        source: 'ask',
        route: kind === 'question' && !state.legacy && state.mentors[me] ? 'mentor' : 'owner',
        answerer: null,
        comments: [],
      };
      q.answerer = kind === 'standby_test' ? null : q.route === 'mentor' ? state.mentors[me] : q.owner;
      state.questions.set(id, q);
      state.idem.set(k, id);
      if (kind === 'standby_test') {
        answer(q, 'standby-ok', 'hub', 'system');
      } else {
        // Simulate interpreting → posted.
        setTimeout(() => {
          if (q.status === 'received') {
            const ch = q.route === 'mentor' ? 'C0NORAMENTOR' : 'C0OFFICE';
            setQ(q, { status: 'posted', card: { channel: ch, permalink: `https://example.invalid/archives/${ch}/p${state.seq}` } });
          }
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
        .map((q) => ({ id: q.id, status: q.status, project: q.project, created_at: q.created_at, question_preview: q.question.slice(0, 80), ...(state.legacy ? {} : { route: q.route, source: q.source }) }));
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
        if (q.status === 'answered') {
          setQ(q, { status: 'delivered', delivered_at: new Date().toISOString() });
          if (q.kind === 'standby_test') {
            const c = q.body.client ?? {};
            // What the hub's ChatPort.postStatus would put in #runner (brief 01).
            state.statusPosts.push(`Standby verified: ${me} on ${c.host} — ask ${c.version}, ${c.os}, tools: ${(c.tools ?? []).join(', ') || 'none'}`);
          }
        }
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
    /**
     * A thread reply by someone other than the answerer, before the answer:
     * stored as a comment (max 20; cut at 4000 characters with truncated: true).
     */
    addComment(id, by, text, at = new Date().toISOString()) {
      const q = state.questions.get(id);
      if (!q) throw new Error(`stub: no question ${id}`);
      if (q.comments.length >= 20) return false;
      const t = String(text);
      q.comments.push({ by, text: t.slice(0, 4000), at, truncated: t.length > 4000 });
      return true;
    },
    /**
     * A question started in Slack (forwarded or @mention) by `asked_by`.
     * @param {{ question: string, asked_by?: string, project?: string|null, created_at?: string, answer?: string, by?: string }} o
     */
    createSlackQuestion(o) {
      const asker = o.asked_by ?? state.teammate;
      const mentor = state.mentors[asker];
      const project = o.project ?? null;
      const id = newId();
      const q = {
        id, kind: 'question', status: 'posted', project, asked_by: asker,
        created_at: o.created_at ?? new Date().toISOString(),
        owner: project ? (state.projects[project]?.owner ?? null) : null,
        card: { channel: 'C0NORAMENTOR', permalink: `https://example.invalid/archives/C0NORAMENTOR/p${state.seq}` },
        interpretation: null, answer: null, delivered_at: null, error: null,
        question: o.question, body: {}, source: 'slack',
        route: mentor ? 'mentor' : 'owner', answerer: null, comments: [],
      };
      q.answerer = mentor ?? q.owner;
      state.questions.set(id, q);
      if (o.answer !== undefined) answer(q, o.answer, o.by);
      return id;
    },
    /** The approver's tap, for onboarding.decision 'manual'. @param {'register'|'refuse'|'expire'} d */
    decideOnboarding(d) {
      ob.decision = d;
      decide();
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

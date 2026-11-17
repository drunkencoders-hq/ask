// @ts-check
// `ask standby`: a standby_test question the hub answers itself with
// "standby-ok"; the receipt makes the hub post "Standby verified" in #runner.
import { randomUUID } from 'node:crypto';
import { resolveHubUrl, ConfigError } from '../config.js';
import { createClient, HubError, HubUnreachable } from '../client.js';
import { ASSISTANTS } from './assistants/index.js';
import { serverSpec } from './assistants/common.js';
import { formatAskUpdate } from '../update.js';

/**
 * Assistants that currently have the ask MCP server registered.
 * @param {import('./sys.js').Sys} sys
 */
export function registeredAssistants(sys) {
  const spec = serverSpec(sys);
  const ids = [];
  for (const a of ASSISTANTS) {
    try {
      if (a.detect(sys) && a.status(sys, spec) === 'registered') ids.push(a.id);
    } catch {}
  }
  return ids;
}

/**
 * @param {import('./sys.js').Sys} sys
 * @param {{ hubUrl?: string, timeoutSec?: number, reportUpdates?: boolean }} [o]
 * @returns {Promise<number>} exit code
 */
export async function runStandby(sys, o = {}) {
  let hubUrl = o.hubUrl;
  try {
    hubUrl = hubUrl ?? resolveHubUrl({ platform: sys.platform, env: sys.env, homedir: sys.homedir }).hubUrl;
  } catch (e) {
    if (e instanceof ConfigError) {
      sys.err(`ask standby: ${e.message}`);
      return 2;
    }
    throw e;
  }
  const client = createClient({
    hubUrl, via: 'cli', log: (m) => sys.err(`ask standby: ${m}`), tools: registeredAssistants(sys),
    updateState: sys, onAskUpdate: o.reportUpdates === false ? undefined : (update) => sys.err(formatAskUpdate(update)),
  });
  try {
    const me = await client.whoami();
    const created = await client.create({ client_request_id: randomUUID(), kind: 'standby_test' });
    const r = await client.waitFor(created.id, { timeoutSec: o.timeoutSec ?? 60 });
    if (!r.done) {
      sys.err(`ask standby: FAILED: the hub did not answer standby test ${created.id} within ${o.timeoutSec ?? 60}s.`);
      return 3;
    }
    const q = r.question;
    if (q.status === 'failed') {
      sys.err(`ask standby: FAILED: standby test ${q.id} failed on the hub: ${q.error?.message ?? q.error?.code ?? 'no detail'}`);
      return 6;
    }
    if (q.answer?.text !== 'standby-ok') {
      sys.err(`ask standby: FAILED: unexpected standby answer ${JSON.stringify(q.answer?.text)} for ${q.id}.`);
      return 1;
    }
    try {
      await client.receipt(q.id);
    } catch (e) {
      sys.err(`ask standby: FAILED: the hub answered but the receipt for ${q.id} was not recorded (${/** @type {Error} */ (e).message}). Not verified.`);
      return e instanceof HubError ? 5 : 4;
    }
    sys.out(`Standby verified: ${me.teammate} via ${hubUrl}`);
    return 0;
  } catch (e) {
    if (e instanceof HubError) {
      sys.err(`ask standby: FAILED: hub refused (${e.code}): ${e.message}`);
      return 5;
    }
    if (e instanceof HubUnreachable) {
      sys.err(`ask standby: FAILED: hub unreachable: ${e.message}`);
      return 4;
    }
    throw e;
  } finally {
    if (o.reportUpdates !== false) await client.askUpdate();
  }
}

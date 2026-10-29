// The approval handler for ACP workers. It writes each card into the same
// spool as Claude Code's and Codex's (main/approvals.mjs), so the renderer
// draws one card format for every engine, and the founder's answer arrives
// through main/ipc.mjs into `settle` in process -- never off the disk, for
// the reasons main/codex-approvals.mjs sets out. The mechanics here are
// that file's, kept beside it rather than shared, because the two answer in
// different words: Codex takes a decision value, ACP takes one of the
// option ids the agent itself offered.
//
// AN ALLOW IS THE ALLOW-ONCE OPTION, NEVER MORE. ACP options carry a kind,
// and a press of Allow answers the offered `allow_once`. When the agent
// offered no allow-once, the answer is `cancelled` -- an id is never
// invented, and `allow_always` is never picked on somebody's behalf. A deny
// answers the offered rejection (main/acp.mjs `rejectionOption`), or
// `cancelled` when it offered none.
//
// A CARD WAITS FOR THE PERSON IT ASKS, AND NO CLOCK ANSWERS FOR THEM. What
// settles a card is always an event: their answer, the worker stopping
// (`close` on its scope), the app shutting down. The transport's own
// deadline is set past any wait by the worker (main/acp-worker.mjs).
import crypto from 'node:crypto';
import fs from 'node:fs';
import { appendSpoolLine, cardDigest, removeSpoolEntry, spoolDir, spoolEntryExists, writeSpoolFile } from './approvals.mjs';
import { rejectionOption } from './acp.mjs';
import { Name } from '../shared/product-name.mjs';

/** How often a waiting card sweeps a forged answer and puts itself back on screen. */
export const POLL_MS = 2_000;

/** The most of a command or a diff that goes on a card; past it, a mark says how much went. */
export const CARD_CAP = 4_000;

function readable(text) {
  if (text.length <= CARD_CAP) return text;
  const dropped = text.length - CARD_CAP;
  return `${text.slice(0, CARD_CAP)}\n[+${dropped} character${dropped === 1 ? '' : 's'} not shown]`;
}

/**
 * One ACP permission request as a card, or null, which `ask` refuses. The
 * request's `toolCall` is the same shape as a `tool_call` update: a title, a
 * kind, and the content the agent has so far. `Bash`/`command` and
 * `Edit`/`changes` are the words and keys the renderer already reads.
 */
export function acpApprovalCard(request) {
  const call = request?.toolCall ?? {};
  const title = typeof call.title === 'string' ? call.title.trim() : '';
  const kind = typeof call.kind === 'string' ? call.kind : '';
  const texts = [];
  const diffs = [];
  for (const part of Array.isArray(call.content) ? call.content : []) {
    if (part?.type === 'content' && part.content?.type === 'text' && typeof part.content.text === 'string') texts.push(part.content.text);
    if (part?.type === 'diff' && typeof part.path === 'string' && part.path) diffs.push(part);
  }
  const raw = call.rawInput && typeof call.rawInput === 'object' ? call.rawInput : {};
  const locations = (Array.isArray(call.locations) ? call.locations : [])
    .map((at) => (typeof at?.path === 'string' ? at.path : ''))
    .filter(Boolean);

  if (kind === 'edit' || diffs.length) {
    const blocks = diffs.map((d) => {
      const body = [typeof d.oldText === 'string' ? d.oldText : '', typeof d.newText === 'string' ? d.newText : ''].filter(Boolean).join('\n');
      return body ? `${d.path}\n${body}` : d.path;
    });
    for (const p of locations) if (!blocks.some((b) => b.startsWith(p))) blocks.push(p);
    if (!blocks.length) return null;
    const input = { changes: readable(blocks.join('\n\n')) };
    if (title) input.description = title;
    return { tool: 'Edit', input };
  }

  const command = (typeof raw.command === 'string' ? raw.command.trim() : '') || texts.join('\n').trim();
  if (kind === 'execute' || command) {
    if (!command) return null;
    const input = { command: readable(command) };
    if (typeof raw.cwd === 'string' && raw.cwd) input.cwd = raw.cwd;
    if (title) input.description = title;
    return { tool: 'Bash', input };
  }

  if (!title) return null;
  return { tool: 'Tool', input: { description: title } };
}

const allowOnceOption = (options = []) =>
  options.find((o) => o?.kind === 'allow_once')?.optionId ?? null;

/**
 * The ACP side of the approval spool, one per supervisor and shared by
 * every ACP worker. `ask` resolves with the option id to answer, or null,
 * which the transport sends as `cancelled`.
 */
export function createAcpApprovals({
  storeRoot,
  pollMs = POLL_MS,
  uuid = () => crypto.randomUUID(),
  now = () => Date.now(),
  onChange = null,
} = {}) {
  const dir = spoolDir(storeRoot);
  const open = new Map(); // id -> { request, scope, decide, poll }

  const ask = (context, request) => new Promise((resolve) => {
    const card = acpApprovalCard(request);
    if (!card) {
      const line = `${Name} refused an approval from this run: it carries no command, no path and no title, so there is nothing it could put in front of the founder to answer`;
      if (typeof context?.say === 'function') context.say(line);
      else console.warn(`zero: ${line}`);
      resolve(rejectionOption(request?.options ?? []));
      return;
    }

    const id = String(uuid());
    const shown = {
      id,
      at: now(),
      product: context?.product ?? null,
      item: context?.item ?? null,
      tool: card.tool,
      input: card.input,
    };

    let put = false;
    try {
      fs.mkdirSync(dir, { recursive: true });
      put = writeSpoolFile(dir, `${id}.request.json`, JSON.stringify(shown));
    } catch (err) {
      console.warn('zero: could not put an ACP approval in the spool:', err?.message ?? err);
    }
    if (!put) {
      resolve(rejectionOption(request?.options ?? []));
      return;
    }

    const entry = {
      request: shown,
      scope: context?.scope ?? null,
      decide(allow, note, extra) {
        if (!open.delete(id)) return false;
        clearInterval(entry.poll);
        finish(id, shown, { allow: !!allow, note: note ?? null, at: now(), ...extra });
        resolve(allow ? allowOnceOption(request?.options ?? []) : rejectionOption(request?.options ?? []));
        return true;
      },
    };
    entry.poll = setInterval(() => tend(id), pollMs);
    entry.poll?.unref?.();
    open.set(id, entry);
    onChange?.();
  });

  function tend(id) {
    const entry = open.get(id);
    if (!entry) return;
    const forged = `${id}.answer.json`;
    if (spoolEntryExists(dir, forged)) {
      removeSpoolEntry(dir, forged);
      console.warn(`zero: an answer file appeared for approval ${id} that the founder did not write; it has been deleted and the card is still waiting`);
      onChange?.();
    }
    const name = `${id}.request.json`;
    if (spoolEntryExists(dir, name)) return;
    if (writeSpoolFile(dir, name, JSON.stringify(entry.request))) { onChange?.(); return; }
    if (!entry.saidItCouldNotGoBack) {
      entry.saidItCouldNotGoBack = true;
      console.warn(`zero: approval ${id} left the spool and could not be put back, so the worker waiting on it has no card on screen`);
    }
  }

  function finish(id, request, decided) {
    appendSpoolLine(dir, 'log.jsonl', `${JSON.stringify({ ...request, answer: decided, decidedAt: now() })}\n`);
    for (const f of [`${id}.request.json`, `${id}.answer.json`]) removeSpoolEntry(dir, f);
    onChange?.();
  }

  let scopes = 0;

  return {
    scope: (context = {}) => {
      const id = `acp-scope-${scopes += 1}`;
      const bound = { ...context, scope: id };
      return {
        ask: (request) => ask(bound, request),
        close: (why = 'the worker that asked this has stopped') => {
          let closed = 0;
          for (const entry of [...open.values()]) {
            if (entry.scope !== id) continue;
            if (entry.decide(false, why, { closed: true })) closed += 1;
          }
          return closed;
        },
      };
    },

    settle: (id, allow, note) => open.get(String(id))?.decide(allow, note) ?? false,

    changed: (id, shownCard) => {
      const entry = open.get(String(id));
      if (!entry) return false;
      const mine = cardDigest(entry.request);
      return !mine || mine !== shownCard;
    },

    close: (why = `${Name} is shutting down`) => {
      for (const entry of [...open.values()]) entry.decide(false, why, { closed: true });
    },

    pending: () => [...open.keys()],
  };
}

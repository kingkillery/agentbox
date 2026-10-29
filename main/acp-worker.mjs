/**
 * ONE ACP RUN, SHAPED LIKE A CHILD PROCESS.
 *
 * The supervisor's spawn path wants something with `stderr`, `on('event')`
 * and one `exit` -- that is what a Claude Code child, a Codex worker and an
 * OpenCode worker all look like from there. This is the fourth one, and the
 * first over main/acp.mjs: it introduces itself, opens (or loads) one
 * session in the task folder, and ends when that session's last prompt does.
 * Its events are ACP's own `session/update` notifications, passed through
 * untranslated like the other RPC engines'.
 *
 * A FOCUS REPLY IS ANOTHER PROMPT ON THIS SESSION, not a new process. ompk
 * cancels the turn still streaming when the next `session/prompt` arrives and
 * queues that prompt behind the cleanup, which is Send now without a second
 * cancel: a `session/cancel` after the new prompt can land on the message
 * just sent. The process stays up until the last of those prompts answers,
 * and only that last stop reason decides the exit. A turn cut so the
 * correction could be answered is not the run failing.
 *
 * WHAT DECIDES THE EXIT IS THE LAST TURN'S OWN WORD. Only `end_turn` is a
 * finished run: a limit, a refusal or a cancelled turn is an error even when
 * text arrived, because text arriving is not the same as the work being done
 * (docs/harnesses.md).
 *
 * A REPLAY IS NOT NEWS. Loading a session re-sends its history as
 * `session/update` before the load answers, so nothing is forwarded until
 * the load has settled; otherwise the old answer would be captured as this
 * run's result and delivered a second time.
 *
 * NO CLOCK ANSWERS A CARD. The transport would deny a permission after its
 * deadline (main/acp.mjs), and the spool's own rule is that only an event
 * answers -- her answer, this worker stopping, the app closing -- so the
 * deadline here is set past any wait a person could outlast, and `kill` and
 * the transport closing still settle every standing question at once.
 *
 * PLAN IS THE ONE MODE THIS BOX CAN HAND OVER. The other five are Claude
 * Code's words. Mapping them onto ompk's own modes would be inventing an
 * equivalence, so they are not sent.
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { createAcpClient } from './acp.mjs';
import { TURN_CLOSED } from './claude-input.mjs';
import { ompkCommandNames } from './ompk.mjs';

// The largest delay setTimeout takes without overflowing: about 24 days,
// which is "no clock" said in a way the timer accepts.
const NO_CLOCK = 2_147_483_647;
// Past this the picture stays a path in the words. Inlining a multi-megabyte
// file into the prompt is how a turn stops starting.
const IMAGE_CAP = 8 * 1024 * 1024;
const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

function turnClosed(message) {
  const error = Error(message);
  error.code = TURN_CLOSED;
  return error;
}

function imageBlocks(files) {
  const blocks = [];
  for (const file of files ?? []) {
    if (typeof file !== 'string' || !file) continue;
    const mimeType = MIME[path.extname(file).toLowerCase()];
    if (!mimeType) continue;
    try {
      const buf = fs.readFileSync(file);
      if (!buf.length || buf.length > IMAGE_CAP) continue;
      blocks.push({ type: 'image', data: buf.toString('base64'), mimeType });
    } catch {
      // The path is already in the words. A picture that cannot be read must
      // not take the turn down with it.
    }
  }
  return blocks;
}

export function createAcpWorker({
  child,
  plan = {},
  cwd = null,
  resumeSessionId = null,
  onApproval = null,
  clientInfo = undefined,
} = {}) {
  if (!child) throw Error('createAcpWorker needs the spawned agent process');

  const worker = new EventEmitter();
  worker.stderr = new EventEmitter();
  worker.stdout = new EventEmitter();
  worker.sessionId = resumeSessionId ?? null;
  worker.commands = [];
  // A slash command is itself a prompt on this transport. Wrapping it in the
  // live-reply brief would make ompk read it as prose.
  worker.slashWhileWorking = true;
  if (Number.isInteger(child.pid)) worker.pid = child.pid;

  const say = (text) => {
    const line = String(text ?? '').trim();
    if (line) worker.stderr.emit('data', line);
  };

  let ended = false;
  let replaying = false;
  let stopping = false;
  let opened = false;
  let openWait;
  const ready = new Promise((resolve, reject) => { openWait = { resolve, reject }; });
  // A failure before the session opens rejects this, and nothing may be
  // awaiting it yet. The run's own catch is what says so.
  ready.catch(() => {});
  const inflight = new Set();
  const stops = new Map();
  const failed = new Map();
  let sent = 0;

  const client = createAcpClient({
    transport: child,
    ...(clientInfo ? { clientInfo } : {}),
    onNotification: (method, params) => {
      const names = ompkCommandNames(method, params);
      // Kept even during a replay, so a command list that arrived before
      // anyone was listening can still be handed to the menu.
      if (names) worker.commands = names;
      if (ended || replaying) return;
      worker.emit('event', method, params);
    },
    onPermission: onApproval ? (request) => onApproval(request) : null,
    permissionTimeoutMs: NO_CLOCK,
    promptTimeoutMs: NO_CLOCK,
  });

  const finish = (error) => {
    if (ended) return;
    ended = true;
    if (error) {
      worker.error = error;
      say(error);
      const gone = client.diagnostics().trim();
      if (gone) say(gone);
    }
    try { client.close(worker.error ?? 'The run is over'); } catch { /* already gone */ }
    worker.emit('exit', worker.error ? 1 : 0, null);
  };

  const settle = () => {
    if (ended || inflight.size || !opened) return;
    const latest = Math.max(0, ...stops.keys(), ...failed.keys());
    if (!latest) return;
    if (failed.has(latest)) {
      const error = failed.get(latest);
      finish(stopping
        ? 'The run was cancelled before it finished'
        : (error?.message ?? String(error)));
      return;
    }
    if (!stops.has(latest)) return;
    const stop = stops.get(latest);
    if (stopping) {
      finish('The run was cancelled before it finished');
      return;
    }
    if (stop !== 'end_turn') {
      finish(`The turn stopped at ${stop ?? 'no stop reason at all'} instead of finishing`);
      return;
    }
    finish(null);
  };

  const sendPrompt = async (text, pictures) => {
    if (ended || stopping) throw turnClosed('The turn has ended. Send the message again to continue it.');
    await ready;
    if (ended || stopping || !worker.sessionId) throw turnClosed('The turn has ended. Send the message again to continue it.');
    const mine = ++sent;
    const blocks = [{ type: 'text', text: String(text ?? '') }];
    // An image block sent to an agent that never advertised one is a prompt
    // it is allowed to reject. The path in the words is the fallback.
    if (client.can('image')) blocks.push(...imageBlocks(pictures));
    const job = client.prompt({ sessionId: worker.sessionId, blocks });
    inflight.add(job);
    try {
      const result = await job;
      stops.set(mine, result?.stopReason ?? null);
      return result;
    } catch (error) {
      failed.set(mine, error);
      throw error;
    } finally {
      inflight.delete(job);
      settle();
    }
  };

  worker.steer = (text, pictures = []) => sendPrompt(text, pictures);
  // The prompt that carried the correction already cancelled the turn it
  // interrupted. Cancelling again can hit that correction.
  worker.interrupt = () => Promise.resolve({ interrupted: false });
  worker.setMode = async (mode) => {
    await ready;
    if (ended || stopping) throw turnClosed('The turn has ended. Send the message again to continue it.');
    if (mode === 'plan') return client.setMode(worker.sessionId, 'plan');
    throw Error("ompk takes Plan from this box. Its other permission modes are its own, not Claude Code's.");
  };

  const run = async () => {
    try {
      await client.initialize();

      if (resumeSessionId) {
        replaying = true;
        try {
          await client.loadSession({ sessionId: resumeSessionId, cwd });
        } finally {
          replaying = false;
        }
        worker.sessionId = resumeSessionId;
      } else {
        const session = await client.newSession({ cwd });
        worker.sessionId = session?.sessionId ?? null;
        if (!worker.sessionId) throw Error('The agent did not name the session it opened');
      }

      if (plan.answerMode === 'plan') await client.setMode(worker.sessionId, 'plan');
      opened = true;
      openWait.resolve();
      await sendPrompt(String(plan.prompt ?? ''), plan.pictures ?? []);
    } catch (error) {
      if (error?.code === TURN_CLOSED) return;
      if (!opened) openWait.reject(error);
      finish(stopping
        ? 'The run was cancelled before it finished'
        : (error?.message ?? String(error)));
    }
  };

  worker.kill = () => {
    if (ended || stopping) return;
    stopping = true;
    try { if (worker.sessionId) client.cancel(worker.sessionId); } catch { /* closing anyway */ }
    try { client.close('The run was stopped'); } catch { /* already gone */ }
    try { child.kill?.(); } catch { /* already gone */ }
    finish('The run was cancelled before it finished');
  };
  worker.client = client;
  worker.done = run();
  return worker;
}

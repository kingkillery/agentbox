// READING AN ompk RUN, IN ACP'S OWN WORDS.
//
// The same five readers every engine provides -- capture, live text, summary,
// trace, activity -- over `session/update` notifications as ompk's ACP mode
// sends them (oh-my-pk, packages/coding-agent/src/modes/acp). Nothing here
// translates an update into a pretend Claude line or Codex notification.
//
// The shapes that matter:
//
//   agent_message_chunk   content {type:'text', text} is a DELTA; messageId
//                         names the message it belongs to
//   agent_thought_chunk   the model's thinking, same shape, never an answer
//   tool_call             {toolCallId, title, kind, status, content?, locations?}
//   tool_call_update      {toolCallId, status, content?, locations?}; a
//                         finished edit's content carries {type:'diff', path}
//   plan                  {entries:[{content, status}]}
//
// A reader that throws kills a run that was going fine, so every one of
// these reads what parses and ignores what does not, as the others do.

/** How much streamed prose is kept before it is dropped, as the others do. */
const SAYING_CAP = 20_000;

const updateOf = (params) => (params && typeof params === 'object' ? params.update ?? null : null);
const textOf = (content) => (content?.type === 'text' && typeof content.text === 'string' ? content.text : '');

/**
 * THE COMMANDS THE SESSION ADVERTISED, or null when this update is not that
 * list. A name that is not a command word is dropped: the menu types it after
 * a slash and sends it as the prompt, so a space or a digit would be a lie
 * about what Send does.
 */
export function ompkCommandNames(method, params) {
  const update = updateOf(params);
  if (method !== 'session/update' || update?.sessionUpdate !== 'available_commands_update') return null;
  const names = [];
  for (const command of update.availableCommands ?? []) {
    const name = command?.name;
    if (typeof name === 'string' && /^[a-z][a-z0-9:_-]*$/i.test(name) && !names.includes(name)) names.push(name);
  }
  return names.length ? names : null;
}

function tool(session, id) {
  session.ompkTools ??= new Map();
  if (!session.ompkTools.has(id)) session.ompkTools.set(id, {});
  return session.ompkTools.get(id);
}

function rememberChange(session, update) {
  const paths = [];
  for (const part of update.content ?? []) {
    if (part?.type === 'diff' && typeof part.path === 'string' && part.path) paths.push(part.path);
  }
  const known = session.ompkTools?.get(update.toolCallId);
  if (known?.kind === 'edit') {
    for (const at of [...(update.locations ?? []), ...(known.locations ?? [])]) {
      if (typeof at?.path === 'string' && at.path) paths.push(at.path);
    }
  }
  for (const p of paths) {
    session.ompkChange ??= [];
    if (!session.ompkChange.includes(p)) session.ompkChange.push(p);
  }
}

/**
 * WHAT THE RUN WAS, kept on the session as it goes.
 *
 * The result is the LAST assistant message of the turn. ACP has no single
 * "here is the answer" event: a message arrives as deltas under one
 * messageId, so the deltas are gathered per message and the last one
 * standing when the turn ends is the result. Thought chunks are gathered
 * nowhere: thinking out loud is not the run's answer.
 */
export function captureOmpkUpdate(session, method, params) {
  try {
    if (!session || method !== 'session/update') return;
    const update = updateOf(params);
    if (!update) return;
    if (!session.sessionId && typeof params.sessionId === 'string' && params.sessionId) session.sessionId = params.sessionId;

    if (update.sessionUpdate === 'agent_message_chunk') {
      const text = textOf(update.content);
      if (!text) return;
      const id = update.messageId ?? null;
      if (session.ompkMessageId !== id) {
        session.ompkMessageId = id;
        session.ompkText = '';
      }
      session.ompkText = (session.ompkText ?? '') + text;
      const whole = session.ompkText.trim();
      if (whole) { session.result = whole; session.resultIsError = false; }
      return;
    }

    if (update.sessionUpdate === 'tool_call') {
      if (typeof update.toolCallId === 'string' && update.toolCallId) {
        Object.assign(tool(session, update.toolCallId), {
          ...(typeof update.title === 'string' ? { title: update.title } : {}),
          ...(typeof update.kind === 'string' ? { kind: update.kind } : {}),
          ...(Array.isArray(update.locations) ? { locations: update.locations } : {}),
        });
        if (update.status === 'completed') rememberChange(session, update);
      }
      return;
    }

    if (update.sessionUpdate === 'tool_call_update' && update.status === 'completed') {
      rememberChange(session, update);
    }
  } catch {
    // Read what parses and ignore what does not.
  }
}

/**
 * THE PROSE AS IT IS TYPED, for the line on the row that moves. Deltas of
 * the current message only; a new message starts the line over, and thought
 * chunks never reach it.
 */
export function ompkStreamingText(session, method, params) {
  try {
    if (!session || method !== 'session/update') return false;
    const update = updateOf(params);
    if (update?.sessionUpdate !== 'agent_message_chunk') return false;
    const text = textOf(update.content);
    if (!text) return false;
    const id = update.messageId ?? null;
    if (session.ompkSayingId !== id) {
      session.ompkSayingId = id;
      session.saying = '';
    }
    if (!session.sayingAt) session.sayingAt = Date.now();
    const next = (session.saying ?? '') + text;
    session.saying = next.length > SAYING_CAP ? '' : next;
    return true;
  } catch {
    return false;
  }
}

const toolTitle = (update) => {
  const title = typeof update?.title === 'string' ? update.title.trim() : '';
  if (title) return title;
  return typeof update?.kind === 'string' && update.kind ? update.kind : null;
};

/** One short line for the row: what it just did. */
export function summarizeOmpkUpdate(method, params) {
  try {
    if (method !== 'session/update') return null;
    const update = updateOf(params);
    if (!update) return null;
    if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      const word = toolTitle(update);
      return word ? `tool: ${word}` : null;
    }
    if (update.sessionUpdate === 'plan') {
      const entries = Array.isArray(update.entries) ? update.entries : [];
      const open = entries.find((e) => e?.status === 'in_progress');
      return open?.content ? String(open.content).slice(0, 300) : null;
    }
    return null;
  } catch {
    return null;
  }
}

/** One line for the run trace, the record she can open afterwards. */
export function traceOmpkUpdate(method, params) {
  try {
    if (method !== 'session/update') return null;
    const update = updateOf(params);
    if (!update) return null;
    const at = new Date().toISOString().slice(11, 19);
    if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      if (update.status !== 'completed' && update.status !== 'failed') return null;
      const word = toolTitle(update);
      if (!word) return null;
      const failed = update.status === 'failed' ? ' (refused)' : '';
      return `${at}  [${word}]${failed}`;
    }
    return null;
  } catch {
    return null;
  }
}

/** What it is doing right now, for the row's activity line. */
export function ompkActivity(method, params) {
  try {
    if (method !== 'session/update') return null;
    const update = updateOf(params);
    if (!update) return null;
    if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') return null;
    if (update.status !== 'pending' && update.status !== 'in_progress') return null;
    const word = toolTitle(update);
    return word ? { tool: word } : null;
  } catch {
    return null;
  }
}

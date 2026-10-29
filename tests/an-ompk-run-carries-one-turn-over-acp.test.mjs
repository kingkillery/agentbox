// An ompk run is one ACP worker: `ompk acp` on stdio, driven through
// main/acp.mjs and shaped like the child the supervisor already holds. What
// is pinned here is the run's own honesty, per docs/harnesses.md:
//
// - delivery is decided by the prompt's stopReason, so a limit or a
//   cancellation is never reported as a finished run because text arrived;
// - a resumed session's replayed history is not forwarded, so an old answer
//   cannot be delivered twice;
// - a tool that never advertised `loadSession` is refused a resume instead
//   of being restarted as an empty conversation;
// - a permission request reaches the asker we hand in and the answer that
//   goes back is one of the options the agent offered.
//
// The agent here is a fake speaking one JSON object per line, the same fake
// the transport's own test uses; the real `ompk acp` handshake is measured
// separately (scripts/scratch) because it needs the binary installed.
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createAcpWorker } from '../main/acp-worker.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { submitReply } from '../main/live-replies.mjs';
import { TURN_CLOSED } from '../main/claude-input.mjs';
import { ompkCommandNames } from '../main/ompk.mjs';

function fakeAgent() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.sent = [];
  child.stdin = { writable: true, write: (text, cb) => { child.sent.push(JSON.parse(text)); cb?.(); return true; }, end: () => { child.stdin.writable = false; }, on: () => {} };
  child.kill = () => { child.killed = true; child.emit('exit', null, 'SIGTERM'); };
  child.say = (message) => child.stdout.emit('data', Buffer.from(`${JSON.stringify(message)}\n`));
  child.reply = (id, result) => child.say({ jsonrpc: '2.0', id, result });
  child.update = (update) => child.say({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's1', update } });
  child.lastCall = (method) => [...child.sent].reverse().find((m) => m.method === method) ?? null;
  return child;
}

const settleCall = async (child, method, result) => {
  await vi.waitFor(() => expect(child.lastCall(method)).toBeTruthy());
  child.reply(child.lastCall(method).id, result);
};

const exited = (worker) => new Promise((resolve) => worker.once('exit', (code, signal) => resolve({ code, signal })));

const CAPS = { protocolVersion: 1, agentCapabilities: { loadSession: true }, agentInfo: { name: 'ompk' } };

describe('one turn over ACP', () => {
  it('introduces itself, opens a session in the task folder, and ends at end_turn', async () => {
    const child = fakeAgent();
    const seen = [];
    const worker = createAcpWorker({ child, plan: { prompt: 'do the thing' }, cwd: '/work' });
    worker.on('event', (method, params) => seen.push([method, params]));
    const done = exited(worker);

    await settleCall(child, 'initialize', CAPS);
    await settleCall(child, 'session/new', { sessionId: 's1' });
    expect(child.lastCall('session/new').params).toMatchObject({ cwd: '/work' });

    await vi.waitFor(() => expect(child.lastCall('session/prompt')).toBeTruthy());
    expect(child.lastCall('session/prompt').params).toMatchObject({
      sessionId: 's1',
      prompt: [{ type: 'text', text: 'do the thing' }],
    });
    child.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' }, messageId: 'm1' });
    child.reply(child.lastCall('session/prompt').id, { stopReason: 'end_turn' });

    expect(await done).toEqual({ code: 0, signal: null });
    expect(worker.sessionId).toBe('s1');
    expect(seen).toEqual([['session/update', expect.objectContaining({ sessionId: 's1' })]]);
  });

  it('does not call a limit a finished run', async () => {
    const child = fakeAgent();
    const worker = createAcpWorker({ child, plan: { prompt: 'long' }, cwd: '/work' });
    const done = exited(worker);
    await settleCall(child, 'initialize', CAPS);
    await settleCall(child, 'session/new', { sessionId: 's1' });
    await vi.waitFor(() => expect(child.lastCall('session/prompt')).toBeTruthy());
    child.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial' }, messageId: 'm1' });
    child.reply(child.lastCall('session/prompt').id, { stopReason: 'max_tokens' });

    expect((await done).code).toBe(1);
    expect(worker.error).toMatch(/max_tokens/);
  });

  it('resumes by loading the session, and the replay never reaches the row', async () => {
    const child = fakeAgent();
    const seen = [];
    const worker = createAcpWorker({ child, plan: { prompt: 'carry on' }, cwd: '/work', resumeSessionId: 's-old' });
    worker.on('event', (method, params) => seen.push(params));
    const done = exited(worker);

    await settleCall(child, 'initialize', CAPS);
    await vi.waitFor(() => expect(child.lastCall('session/load')).toBeTruthy());
    expect(child.lastCall('session/load').params).toMatchObject({ sessionId: 's-old', cwd: '/work' });
    // The replay: history re-sent before the load answer. None of it is news.
    child.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'the old answer' }, messageId: 'm-old' });
    child.reply(child.lastCall('session/load').id, {});

    await vi.waitFor(() => expect(child.lastCall('session/prompt')).toBeTruthy());
    child.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'the new answer' }, messageId: 'm2' });
    child.reply(child.lastCall('session/prompt').id, { stopReason: 'end_turn' });

    expect((await done).code).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0].update.content.text).toBe('the new answer');
  });

  it('refuses a resume the agent never advertised, out loud', async () => {
    const child = fakeAgent();
    const worker = createAcpWorker({ child, plan: { prompt: 'carry on' }, cwd: '/work', resumeSessionId: 's-old' });
    const done = exited(worker);
    await settleCall(child, 'initialize', { protocolVersion: 1, agentCapabilities: {} });

    expect((await done).code).toBe(1);
    expect(worker.error).toMatch(/cannot resume/);
    expect(child.lastCall('session/new')).toBeNull();
    expect(child.lastCall('session/prompt')).toBeNull();
  });

  it('hands a permission request to the asker and answers with an offered option', async () => {
    const child = fakeAgent();
    const asked = [];
    const worker = createAcpWorker({
      child, plan: { prompt: 'edit it' }, cwd: '/work',
      onApproval: (request) => { asked.push(request); return Promise.resolve('allow-1'); },
    });
    const done = exited(worker);
    await settleCall(child, 'initialize', CAPS);
    await settleCall(child, 'session/new', { sessionId: 's1' });
    await vi.waitFor(() => expect(child.lastCall('session/prompt')).toBeTruthy());

    child.say({
      jsonrpc: '2.0', id: 99, method: 'session/request_permission',
      params: {
        sessionId: 's1',
        toolCall: { toolCallId: 't1', title: 'edit file', kind: 'edit' },
        options: [
          { optionId: 'allow-1', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'deny-1', name: 'Reject', kind: 'reject_once' },
        ],
      },
    });
    await vi.waitFor(() => expect(child.sent.some((m) => m.id === 99)).toBe(true));
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ requestId: 99, sessionId: 's1' });
    expect(child.sent.find((m) => m.id === 99).result).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-1' } });

    child.reply(child.lastCall('session/prompt').id, { stopReason: 'end_turn' });
    expect((await done).code).toBe(0);
  });

  it('refuses every tool when nobody is there to ask', async () => {
    const child = fakeAgent();
    const worker = createAcpWorker({ child, plan: { prompt: 'edit it' }, cwd: '/work' });
    const done = exited(worker);
    await settleCall(child, 'initialize', CAPS);
    await settleCall(child, 'session/new', { sessionId: 's1' });
    await vi.waitFor(() => expect(child.lastCall('session/prompt')).toBeTruthy());

    child.say({
      jsonrpc: '2.0', id: 42, method: 'session/request_permission',
      params: {
        sessionId: 's1',
        toolCall: { toolCallId: 't1', title: 'bash rm' },
        options: [
          { optionId: 'allow-1', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'deny-1', name: 'Reject', kind: 'reject_once' },
        ],
      },
    });
    await vi.waitFor(() => expect(child.sent.some((m) => m.id === 42)).toBe(true));
    expect(child.sent.find((m) => m.id === 42).result).toEqual({ outcome: { outcome: 'selected', optionId: 'deny-1' } });

    child.reply(child.lastCall('session/prompt').id, { stopReason: 'end_turn' });
    await done;
  });
});

const IMAGE = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const open = async (worker, child, caps = CAPS) => {
  await settleCall(child, 'initialize', caps);
  await settleCall(child, 'session/new', { sessionId: 's1' });
  await vi.waitFor(() => expect(child.lastCall('session/prompt')).toBeTruthy());
  return worker;
};

describe('a focus reply stays on the live ompk session', () => {
  it('sends the correction as another prompt and does not end on the turn that correction cut', async () => {
    const child = fakeAgent();
    const worker = createAcpWorker({ child, plan: { prompt: 'do the thing' }, cwd: '/work' });
    const done = exited(worker);
    await open(worker, child);
    const first = child.lastCall('session/prompt').id;

    const steered = worker.steer('stop, look at this instead');
    await vi.waitFor(() => expect(child.sent.filter((m) => m.method === 'session/prompt')).toHaveLength(2));
    const second = child.sent.filter((m) => m.method === 'session/prompt')[1];
    expect(second.params.prompt).toEqual([{ type: 'text', text: 'stop, look at this instead' }]);

    child.reply(first, { stopReason: 'cancelled' });
    await new Promise((r) => setTimeout(r, 20));
    expect(worker.listenerCount('exit')).toBe(1);

    child.reply(second.id, { stopReason: 'end_turn' });
    await steered;
    expect(await done).toEqual({ code: 0, signal: null });
    expect(worker.error).toBeUndefined();
  });

  it('refuses a steer once the session has ended, so the words wait for the next run', async () => {
    const child = fakeAgent();
    const worker = createAcpWorker({ child, plan: { prompt: 'do the thing' }, cwd: '/work' });
    const done = exited(worker);
    await open(worker, child);
    child.reply(child.lastCall('session/prompt').id, { stopReason: 'end_turn' });
    await done;
    await expect(worker.steer('too late')).rejects.toMatchObject({ code: TURN_CLOSED });
  });

  it('puts Plan on the session before the prompt, and does not invent a mapping for the other modes', async () => {
    const planned = fakeAgent();
    const worker = createAcpWorker({ child: planned, plan: { prompt: 'think first', answerMode: 'plan' }, cwd: '/work' });
    const done = exited(worker);
    await settleCall(planned, 'initialize', CAPS);
    await settleCall(planned, 'session/new', { sessionId: 's1' });
    await settleCall(planned, 'session/set_mode', {});
    expect(planned.lastCall('session/set_mode').params).toEqual({ sessionId: 's1', modeId: 'plan' });
    await vi.waitFor(() => expect(planned.lastCall('session/prompt')).toBeTruthy());
    expect(planned.sent.findIndex((m) => m.method === 'session/set_mode'))
      .toBeLessThan(planned.sent.findIndex((m) => m.method === 'session/prompt'));
    planned.reply(planned.lastCall('session/prompt').id, { stopReason: 'end_turn' });
    await done;

    const other = fakeAgent();
    const plain = createAcpWorker({ child: other, plan: { prompt: 'just go', answerMode: 'bypassPermissions' }, cwd: '/work' });
    const ended = exited(plain);
    await open(plain, other);
    expect(other.lastCall('session/set_mode')).toBeNull();
    other.reply(other.lastCall('session/prompt').id, { stopReason: 'end_turn' });
    await ended;
  });

  it('sends a picture as an image block only when the agent said it can see one', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zero-ompk-pic-'));
    const file = path.join(dir, 'shot.png');
    fs.writeFileSync(file, IMAGE);
    try {
      const child = fakeAgent();
      const worker = createAcpWorker({
        child,
        plan: { prompt: 'what is this', pictures: [file] },
        cwd: '/work',
      });
      const done = exited(worker);
      await open(worker, child, {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, promptCapabilities: { image: true } },
      });
      const blocks = child.lastCall('session/prompt').params.prompt;
      expect(blocks[0]).toEqual({ type: 'text', text: 'what is this' });
      expect(blocks[1]).toEqual({ type: 'image', mimeType: 'image/png', data: IMAGE.toString('base64') });
      child.reply(child.lastCall('session/prompt').id, { stopReason: 'end_turn' });
      await done;

      const blind = fakeAgent();
      const textOnly = createAcpWorker({ child: blind, plan: { prompt: 'what is this', pictures: [file] }, cwd: '/work' });
      const ended = exited(textOnly);
      await open(textOnly, blind);
      expect(blind.lastCall('session/prompt').params.prompt).toEqual([{ type: 'text', text: 'what is this' }]);
      blind.reply(blind.lastCall('session/prompt').id, { stopReason: 'end_turn' });
      await ended;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('remembers the commands ompk advertised, and nothing it did not', () => {
    expect(ompkCommandNames('session/update', {
      update: {
        sessionUpdate: 'available_commands_update',
        availableCommands: [{ name: 'compact' }, { name: 'model' }, { name: 'not a command' }, { name: 3 }],
      },
    })).toEqual(['compact', 'model']);
    expect(ompkCommandNames('session/update', { update: { sessionUpdate: 'agent_message_chunk' } })).toBeNull();
  });
});

describe('focus can steer a live ompk turn', () => {
  const supervisor = (child) => ({
    sessions: new Map([['w', { product: 'p', engine: 'ompk', child }]]),
    _handledAnswers: new Set(),
    _answerKey: (item) => item.answer,
    _saveState() {},
    replyFiles: () => ({ block: '', pictures: [] }),
  });

  it('sends a slash command as itself, because that is how ompk runs one', async () => {
    const steered = [];
    const child = {
      slashWhileWorking: true,
      steer: (text) => { steered.push(text); return Promise.resolve(); },
      interrupt: () => Promise.resolve({ interrupted: false }),
    };
    await submitReply(supervisor(child), { product: 'p', id: 'w', answer: '/compact' }, () => ({ answer: '/compact' }));
    expect(steered).toEqual(['/compact']);
  });

  it('puts Plan on the live session instead of refusing the send', async () => {
    const modes = [];
    const child = {
      slashWhileWorking: true,
      setMode: (mode) => { modes.push(mode); return Promise.resolve(); },
      steer: () => Promise.resolve(),
      interrupt: () => Promise.resolve({ interrupted: false }),
    };
    await submitReply(supervisor(child), { product: 'p', id: 'w', answer: 'think first', permissionMode: 'plan' }, () => ({ answer: 'think first' }));
    expect(modes).toEqual(['plan']);
  });
});

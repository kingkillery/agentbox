// Reading an ompk run, and what an ompk worker is never handed.
//
// The readers take ACP `session/update` notifications as ompk sends them
// (packages/coding-agent/src/modes/acp in oh-my-pk): message chunks are
// deltas under a messageId, thought chunks are the model's thinking and are
// never the answer, and a finished edit arrives as a tool_call_update with a
// diff or a location. Shapes below are those, written out by hand.
//
// And the CLAUDE.md billing line, for the third time: ompk would read a
// provider key out of its environment if it found one -- it documents
// ANTHROPIC_API_KEY, OPENAI_API_KEY and a dozen more -- so its worker
// environment is scrubbed of every one of them and sign-in stays ompk's own
// (`~/.ompk/agent/auth.json`, written by ompk itself). Measured by handing
// the harness an environment full of keys and reading what comes back.
import { describe, it, expect } from 'vitest';
import {
  captureOmpkUpdate, ompkStreamingText, summarizeOmpkUpdate, traceOmpkUpdate, ompkActivity,
} from '../main/ompk.mjs';
import { harnessFor, supportsHarnessOperation } from '../main/harnesses.mjs';

const update = (u) => ['session/update', { sessionId: 's1', update: u }];
const chunk = (text, messageId = 'm1') => update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text }, messageId });
const thought = (text) => update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text }, messageId: 'm1' });

describe('the readers', () => {
  it('keeps the last whole message as the result, assembled from its deltas', () => {
    const session = {};
    captureOmpkUpdate(session, ...chunk('Hel'));
    captureOmpkUpdate(session, ...chunk('lo.'));
    expect(session.sessionId).toBe('s1');
    expect(session.result).toBe('Hello.');
    expect(session.resultIsError).toBe(false);

    captureOmpkUpdate(session, ...chunk('Second message.', 'm2'));
    expect(session.result).toBe('Second message.');
  });

  it('never takes a thought for the answer or the stream', () => {
    const session = {};
    captureOmpkUpdate(session, ...thought('weighing the options'));
    expect(session.result).toBeUndefined();
    expect(ompkStreamingText(session, ...thought('still thinking'))).toBe(false);
    expect(session.saying ?? '').toBe('');
  });

  it('streams the prose as it is typed, and a new message starts a new line', () => {
    const session = {};
    expect(ompkStreamingText(session, ...chunk('Working '))).toBe(true);
    expect(ompkStreamingText(session, ...chunk('on it'))).toBe(true);
    expect(session.saying).toBe('Working on it');
    expect(ompkStreamingText(session, ...chunk('New thought', 'm2'))).toBe(true);
    expect(session.saying).toBe('New thought');
  });

  it('remembers the files a finished edit changed', () => {
    const session = {};
    captureOmpkUpdate(session, ...update({
      sessionUpdate: 'tool_call', toolCallId: 't1', title: 'edit index.ts', kind: 'edit', status: 'pending',
      locations: [{ path: '/work/src/index.ts' }],
    }));
    captureOmpkUpdate(session, ...update({
      sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed',
      content: [{ type: 'diff', path: '/work/src/index.ts', oldText: 'a', newText: 'b' }],
    }));
    expect(session.ompkChange).toEqual(['/work/src/index.ts']);
    expect(harnessFor('ompk').change(session)).toEqual({ files: ['/work/src/index.ts'] });
  });

  it('does not claim a failed edit changed anything', () => {
    const session = {};
    captureOmpkUpdate(session, ...update({
      sessionUpdate: 'tool_call_update', toolCallId: 't9', status: 'failed',
      locations: [{ path: '/work/nope.ts' }],
    }));
    expect(session.ompkChange).toBeUndefined();
    expect(harnessFor('ompk').change(session)).toBeNull();
  });

  it('says what it is doing while a tool runs, and traces a finished one', () => {
    const running = update({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'run tests', kind: 'execute', status: 'in_progress' });
    expect(ompkActivity(...running)).toEqual({ tool: 'run tests' });
    const finished = update({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'run tests', kind: 'execute', status: 'completed' });
    expect(ompkActivity(...finished)).toBeNull();
    expect(summarizeOmpkUpdate(...running)).toBe('tool: run tests');
    expect(traceOmpkUpdate(...finished)).toMatch(/run tests/);
  });

  it('ignores what it cannot parse instead of killing the run', () => {
    const session = {};
    expect(() => captureOmpkUpdate(session, 'nonsense/method', { update: null })).not.toThrow();
    expect(() => captureOmpkUpdate(session, 'session/update', null)).not.toThrow();
  });
});

describe('the harness', () => {
  it('is registered and answers for ompk', () => {
    const harness = harnessFor('ompk');
    expect(harness.id).toBe('ompk');
    expect(harness.label).toBe('ompk');
    expect(supportsHarnessOperation('ompk', 'spawn')).toBe(true);
    expect(supportsHarnessOperation('ompk', 'subscribe')).toBe(true);
  });

  it('hands its worker no provider key from our environment', () => {
    const env = harnessFor('ompk').workerEnv({
      PATH: '/usr/bin', HOME: '/home/her',
      ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o', GEMINI_API_KEY: 'g',
      OPENROUTER_API_KEY: 'r', GROQ_API_KEY: 'q', CURSOR_ACCESS_TOKEN: 'c',
      SOME_OTHER_API_KEY: 'x', AWS_SECRET_ACCESS_KEY: 's',
    });
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/her');
    for (const key of Object.keys(env)) {
      expect(key).not.toMatch(/API_KEY|ACCESS_TOKEN|AWS_/);
    }
  });

  it('declares usage missing rather than faking it as zero', () => {
    expect(harnessFor('ompk').usage()).toEqual({ supported: false, engine: 'ompk', capability: 'usage' });
  });

  it('carries standing instructions into the AGENTS.md ompk reads in its own home', () => {
    const carried = harnessFor('ompk').instructions({ cwd: '/work', home: '/home/her/.ompk/agent' });
    expect(carried.by).toBe('file');
    expect(carried.file).toMatch(/AGENTS\.md$/);
    expect(carried.file).toContain('.ompk');
  });
});

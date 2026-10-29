// ompk (oh-my-pk) joined as a third coding agent, over ACP, and in this fork
// it is the premier one: first in the picker, and what a machine that has it
// runs when nobody chose. What is pinned here is that the preference stops
// where a person's own choice starts -- a row or a workspace that names
// Claude Code still runs Claude Code -- and that a machine without ompk is
// exactly where it was before ompk existed.
//
// Measured as pure answers from shared/engines.mjs and the definitions it
// reads: no process, no filesystem, only the `found` facts a caller hands in.
import { describe, it, expect } from 'vitest';
import {
  ENGINES, ENGINE_IDS, isEngine, engineLabel, homeEngine,
  availableEngines, engineFor, ENGINE_CHOICE_ENABLED,
} from '../shared/engines.mjs';
import { harnessDefinition } from '../shared/harness-definitions.mjs';

const HAS_OMPK = { ompk: true, claude: true, codex: true };
const NO_OMPK = { claude: true, codex: true };

describe('ompk leads the picker', () => {
  it('is first in the order the picker draws', () => {
    expect(ENGINES[0]).toMatchObject({ id: 'ompk' });
    expect(ENGINE_IDS[0]).toBe('ompk');
    expect(ENGINE_IDS).toEqual(expect.arrayContaining(['ompk', 'claude', 'codex']));
  });

  it('is an engine with a definition behind it', () => {
    expect(isEngine('ompk')).toBe(true);
    expect(engineLabel('ompk')).toBe('ompk');
    expect(harnessDefinition('ompk')).toMatchObject({ id: 'ompk', binKey: 'ompkBin' });
  });

  it('is offered on a machine that has it, without taking the others away', () => {
    expect(availableEngines(HAS_OMPK).map((e) => e.id)).toEqual(['ompk', 'claude', 'codex']);
  });

  it('is not offered on a machine that does not have it', () => {
    expect(availableEngines(NO_OMPK).map((e) => e.id)).toEqual(['claude', 'codex']);
  });
});

describe('ompk runs when nobody chose, and only then', () => {
  it('is the home engine on a machine that has it', () => {
    expect(homeEngine(HAS_OMPK)).toBe('ompk');
  });

  it('leaves a machine without it exactly where it was', () => {
    expect(homeEngine(NO_OMPK)).toBe('claude');
    expect(homeEngine({ claude: false, codex: true })).toBe('codex');
    expect(homeEngine({})).toBe('claude');
  });

  it('runs a row nobody chose an engine on', () => {
    expect(engineFor({}, { found: HAS_OMPK })).toBe('ompk');
    expect(engineFor({}, { found: NO_OMPK })).toBe('claude');
  });

  // The case that must NOT match: premier means first offered and the
  // default, never an override of a choice somebody actually made.
  it('does not take a row that names Claude Code', () => {
    expect(engineFor({ engine: 'claude' }, { found: HAS_OMPK, enabled: ENGINE_CHOICE_ENABLED })).toBe('claude');
  });

  it('does not take a row that names Codex', () => {
    expect(engineFor({ engine: 'codex' }, { found: HAS_OMPK, enabled: ENGINE_CHOICE_ENABLED })).toBe('codex');
  });

  it('runs a row that names ompk on ompk', () => {
    expect(engineFor({ engine: 'ompk' }, { found: HAS_OMPK, enabled: ENGINE_CHOICE_ENABLED })).toBe('ompk');
  });

  it('falls back rather than inventing a binary for a row that names ompk where there is none', () => {
    expect(engineFor({ engine: 'ompk' }, { found: NO_OMPK, enabled: ENGINE_CHOICE_ENABLED })).toBe('claude');
  });
});

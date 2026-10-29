// Where ompk (oh-my-pk) actually is, and whether we are entitled to say it
// is not here. The search itself lives in main/engine-bin.mjs, beside every
// other coding agent's; this file is the vocabulary --
// `resolveOmpkBin`, `forgetOmpkBin` -- the same shape main/codex-bin.mjs
// keeps for Codex, so main/config.mjs and main/settings.mjs ask about ompk
// exactly as they ask about the other optional engine.
//
// ompk is optional, and an absence is the ordinary case rather than a
// fault: a missing ompk just leaves it out of the map shared/engines.mjs
// reads, and the premier place at the head of the picker goes to whichever
// engine is here instead. Somebody whose ompk the search misses can point
// the app at the binary themselves, written back as `ompkBin`.
import os from 'node:os';
import {
  ENGINES, findEngine, resolveEngine, forgetEngine, installEvidence as evidenceFor,
  versionedBinPaths,
} from './engine-bin.mjs';

const OMPK = ENGINES.ompk;

export const INSTALL_URL = OMPK.installUrl;

/** Every normal home for this binary, in order; the first that exists wins. */
export function candidatePaths(home = os.homedir()) {
  return OMPK.candidates(home, () => []);
}

/** One bin directory per installed Node, read rather than guessed. */
export function versionedPaths(home = os.homedir(), readdir = undefined) {
  return versionedBinPaths('ompk', home, readdir);
}

/** What ompk leaves behind. None of it is ever spawned. */
export function evidencePaths(home = os.homedir(), env = process.env) {
  return OMPK.evidence(home, env);
}

export function installEvidence({ home = os.homedir(), env = process.env, exists, dangles } = {}) {
  return evidenceFor('ompk', { home, env, exists, dangles });
}

/** The whole search. See main/engine-bin.mjs for what each answer means. */
export function findOmpkBin(where = {}) {
  return findEngine('ompk', where);
}

/** The same search with the shell step held for thirty seconds. */
export function resolveOmpkBin(configured = null, where = {}) {
  return resolveEngine('ompk', configured, where);
}

export function forgetOmpkBin() {
  forgetEngine('ompk');
}

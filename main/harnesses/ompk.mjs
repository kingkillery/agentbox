// THE ompk ADAPTER, AND THE FIRST ENGINE ON THE ACP TRANSPORT.
//
// ompk (oh-my-pk) is this fork's premier coding agent, and it is driven the
// way docs/harnesses.md settled for tools that speak the Agent Client
// Protocol: `ompk acp` on stdio, one process per work item
// (main/acp-worker.mjs), its `session/update` events read natively
// (main/ompk.mjs), and permission requests answered through the founder's
// own cards in the shared spool (main/acp-approvals.mjs), never inferred
// from terminal text.
//
// WHAT IS DECLARED MISSING RATHER THAN FAKED, as OpenCode declares its own:
// `usage` is absent, so the registry answers `{ supported: false }` -- ompk
// bills through whichever provider the person signed into, and "what is
// left" is not ours to invent as zero. `models` is absent: a run takes the
// model ompk itself is configured with, or the one the row names, passed as
// `--model` for ompk to accept or refuse in its own words; there is no
// picker yet. A focus reply while the turn is open is another `session/prompt`
// on this process (`steer` on the worker), not `attachInput`: that would hold
// the process idle between turns, which this does not. `compact` is a slash
// command when the session advertises it, and then it is the prompt. Only the
// default profile is offered; a named profile is ompk's `--profile` and
// arrives when somebody needs a second sign-in here.
//
// SIGN-IN IS ompk'S OWN. Workers run on the sign-in in
// `~/.ompk/agent/auth.json`, written by ompk itself (`ompk setup`, its
// `/login`). `signedIn` here reads only whether that file holds anything --
// never a value out of it -- and the worker environment is scrubbed of every
// provider key ompk could otherwise find and spend (the definition's list).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { harnessDefinition } from '../../shared/harness-definitions.mjs';
import { resolveOmpkBin, INSTALL_URL as OMPK_INSTALL_URL } from '../ompk-bin.mjs';
import { createAcpWorker } from '../acp-worker.mjs';
import {
  captureOmpkUpdate, ompkStreamingText, summarizeOmpkUpdate, traceOmpkUpdate, ompkActivity,
} from '../ompk.mjs';
import { definitionMethods, commonUpdatePlan } from './common.mjs';

const definition = harnessDefinition('ompk');

/** Where ompk keeps its sessions and its own sign-in. */
export function ompkAgentDir(env = process.env, home = os.homedir()) {
  const named = env?.[definition.homeEnv];
  return typeof named === 'string' && named ? named : path.join(home, '.ompk', 'agent');
}

/** Whether ompk's own store holds a sign-in. Shape only; no value leaves it. */
export function ompkSignedIn(dir = ompkAgentDir()) {
  try {
    const auth = JSON.parse(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8'));
    return !!auth && typeof auth === 'object' && !Array.isArray(auth) && Object.keys(auth).length > 0;
  } catch {
    return false;
  }
}

export const ompkHarness = {
  ...definitionMethods(definition),

  discover: resolveOmpkBin,
  installUrl: OMPK_INSTALL_URL,

  profiles: () => ['default'],
  profileHome: () => ompkAgentDir(),
  // A profile is ompk's own `--profile` word at spawn, not a home to point
  // elsewhere: the sign-in lives in the one agent home above.
  profileEnv: (env) => env,
  signedIn: () => ompkSignedIn(),

  defaultModel: () => null,
  workspaceModel: () => null,
  tooling: () => null,

  /**
   * ONE RUN. The person's standing instructions go into the AGENTS.md ompk
   * reads in its own home first, under our markers -- a run that never read
   * them would answer against rules it was never given, which is worse than
   * one that failed to start, so a refusal there stops the spawn out loud.
   * Then `ompk acp` for this item, killed with it.
   */
  spawn(sup, plan, { cwd, item, profile = 'default', env }) {
    if (plan.system) {
      ompkHarness.instructions({ cwd, home: ompkAgentDir(env), text: plan.system });
    }
    const child = spawn(sup.config[definition.binKey], [
      'acp',
      ...(profile && profile !== 'default' ? ['--profile', profile] : []),
      ...(plan.model ? ['--model', plan.model] : []),
    ], {
      cwd,
      env: { ...env, ZERO_PRODUCT: item.product, ZERO_ITEM: item.id },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const approvals = sup._acpApprovals?.(item) ?? null;
    const worker = createAcpWorker({
      child,
      plan,
      cwd,
      resumeSessionId: plan.resumeId ?? null,
      onApproval: approvals ? (request) => approvals.ask(request) : null,
    });
    if (approvals) worker.once('exit', () => approvals.close());
    return worker;
  },

  readers: () => ({
    capture: captureOmpkUpdate,
    stream: ompkStreamingText,
    summarize: summarizeOmpkUpdate,
    trace: traceOmpkUpdate,
    activity: ompkActivity,
  }),

  // Native names through, untranslated, as the other RPC adapters do.
  // A command list can arrive while the session is still opening, before this
  // listener exists. It is kept on the worker and handed over once, so the
  // menu is not empty for a list it already has.
  subscribe(child, session, absorb) {
    child.on('event', (method, params) => absorb(method, params));
    if (child.commands?.length) {
      absorb('session/update', {
        sessionId: child.sessionId,
        update: { sessionUpdate: 'available_commands_update', availableCommands: child.commands.map((name) => ({ name })) },
      });
    }
  },

  // ompk keeps its own session files under its agent home; nothing here has
  // been taught to read one, so none is offered. The run's own trace is the
  // record, as it is for OpenCode.
  transcript: () => null,
  change: (session) => (session?.ompkChange?.length ? { files: [...session.ompkChange] } : null),
  release: () => {},

  settleApproval: (sup, ...args) => sup.settleAcpApproval(...args),
  approvalChanged: (sup, ...args) => sup.acpCardChanged(...args),
  memoryGate: () => ({}),
  updateSettings: () => ({}),

  // ompk updates itself (`ompk update`) and knows whether it came from the
  // installer or a package manager; the common npm plan still wins where
  // npm owns the install.
  updatePlan: (options) => commonUpdatePlan(definition, options, ({ bin, real, name }) => (
    path.isAbsolute(bin) && real
      ? { name, file: bin, args: ['update'], feed: `https://registry.npmjs.org/${definition.package}/latest`, format: 'npm' }
      : null)),

  smallModelArgs: (prompt, model) => ['-p', ...(model ? ['--model', model] : []), prompt],
};

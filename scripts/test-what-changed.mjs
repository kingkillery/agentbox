// THE TESTS FOR WHAT YOU CHANGED, IN ONE COMMAND (w-89f1e810b4).
//
//   npm run test:changed            # everything this branch changes
//   npm run test:changed a.mjs b.ts # or just these
//
// CLAUDE.md used to say `npx vitest related --run <the files you changed>`,
// and `related` runs the tests that IMPORT a file. Dozens of tests here read
// a source file as TEXT instead, and those are invisible to it: that is how
// three red tests shipped in a359d81, and how a branch bounced five times
// while the agent on it could not reproduce a single failure
// (scripts/lib/tests-that-read.mjs). The ship script and the push hook both
// add the readers; this is the same selection, before either of them runs.
//
// Two forks, like the ship, because a dozen agents share this Mac.
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testsThatRead } from './lib/tests-that-read.mjs';

const root = (() => {
  try { return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim(); } catch {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  }
})();
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const lines = (s) => s.split('\n').map((l) => l.trim()).filter(Boolean);

/** Everything this branch changes, committed or not, docs aside. */
function changedOnThisBranch() {
  const sets = [];
  try { sets.push(git('diff', '--name-only', 'origin/main...HEAD')); } catch { /* no remote main yet */ }
  try { sets.push(git('diff', '--name-only', 'HEAD'), git('ls-files', '--others', '--exclude-standard')); } catch { /* nothing staged */ }
  return [...new Set(sets.flatMap(lines))].filter((f) => !f.startsWith('docs/'));
}

const named = process.argv.slice(2);
const files = named.length ? named : changedOnThisBranch();
if (!files.length) {
  console.log('test:changed: this branch changes no code, so there is nothing to run.');
  process.exit(0);
}

const readers = testsThatRead(files, root).filter((f) => !files.includes(f));
console.log(`test:changed: ${files.length} changed file(s)${readers.length ? ` and ${readers.length} test(s) that read one as text` : ''}.`);
// Node's own binary, not `npx`: on Windows `npx` is a .cmd that spawnSync
// cannot resolve without a shell, which used to end this script with exit 1
// and not one test run.
const vitest = createRequire(path.join(root, 'package.json')).resolve('vitest/vitest.mjs');
// AND NOT ONE COMMAND LINE OF A THOUSAND PATHS: Windows caps a process's
// command line at about 32K characters, which a big change here is well past,
// so the run goes out in chunks small enough to carry. related() is per
// chunk, which is the same set of tests over both — a test that reads two
// changed files just runs twice.
const ARG_MAX = 28_000;
const wanted = [...files, ...readers];
const chunks = [];
for (const file of wanted) {
  let chunk = chunks[chunks.length - 1];
  if (!chunk || chunk.size + file.length + 1 > ARG_MAX) { chunk = { files: [], size: 0 }; chunks.push(chunk); }
  chunk.files.push(file); chunk.size += file.length + 1;
}
if (chunks.length > 1) console.log(`test:changed: ${wanted.length} paths go in ${chunks.length} runs, under the command-line limit.`);
for (const chunk of chunks) {
  const run = spawnSync(process.execPath, [vitest, 'related', '--run', '--passWithNoTests', ...chunk.files], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, VITEST_MAX_FORKS: process.env.VITEST_MAX_FORKS ?? '2', VITEST_MIN_FORKS: process.env.VITEST_MIN_FORKS ?? '1' },
  });
  if (run.error) { console.error(`test:changed: vitest did not start: ${run.error.message}`); process.exit(1); }
  if (run.status !== 0) process.exit(run.status ?? 1);
}
process.exit(0);

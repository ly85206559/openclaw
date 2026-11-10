import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Only the committed regression script is overlaid; the generator stays at base.
const BASE = '40c3b508ba130cb9244f077015321b4fa4e91965';
const FIXED = '188689fb9b1db0633e49c4204bfc39ef8bbfbd70';
const source = path.resolve(process.argv[2]);
const candidate = path.resolve(process.argv[3]);
const artifacts = path.resolve(process.argv[4]);
const owner = 'scripts/validate-plugin-init-provider-scaffold.ts';
const generator = 'src/cli/plugins-feature-scaffold.ts';
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 10000 });
assert.equal(git(source, 'rev-parse', 'HEAD').trim(), BASE);
assert.equal(git(candidate, 'rev-parse', 'HEAD').trim(), FIXED);
assert.equal(git(source, 'status', '--porcelain'), '');
assert.equal(git(candidate, 'status', '--porcelain'), '');
assert.equal(git(source, 'hash-object', generator).trim(), '7a81489aa5f1fbddef5270d96a822b8c8fbe4d19');
const original = await fs.readFile(path.join(source, owner));
const regression = await fs.readFile(path.join(candidate, owner));
const generatorBytes = await fs.readFile(path.join(source, generator));
const { runManagedCommand, hasUnjoinedWork } = await import(pathToFileURL(path.join(source, 'scripts/lib/managed-child-process.mts')).href);
await fs.mkdir(artifacts, { recursive: true });
await fs.writeFile(path.join(artifacts, 'overlaid-regression.ts'), regression);
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'feature-css-committed-red-'));
const projectRoot = path.join(scratch, 'generated');
const configFile = path.join(scratch, 'openclaw.json');
const config = `${JSON.stringify({ agents: { ownership: 'explicit', entries: { main: { workspace: path.join(scratch, 'workspace') } } } }, null, 2)}\n`;
await fs.writeFile(configFile, config);
const env = {};
for (const key of ['PATH', 'PNPM_HOME', 'COREPACK_HOME', 'LANG', 'LC_ALL', 'TZ']) if (process.env[key] !== undefined) env[key] = process.env[key];
Object.assign(env, { HOME: scratch, USERPROFILE: scratch, TMPDIR: scratch, TMP: scratch, TEMP: scratch,
  XDG_CONFIG_HOME: path.join(scratch, 'xdg-config'), XDG_CACHE_HOME: path.join(scratch, 'xdg-cache'), XDG_DATA_HOME: path.join(scratch, 'xdg-data'),
  OPENCLAW_CONFIG_PATH: configFile, OPENCLAW_STATE_DIR: path.join(scratch, 'state'), OPENCLAW_PLUGIN_INIT_VALIDATE_ROOT: projectRoot, CI: 'true', NO_COLOR: '1' });
const receipt = { base: BASE, fixed: FIXED, complete: false, verdict: 'unqualified', commands: [], finalCheckErrors: [],
  overlay: { file: owner, sha256: createHash('sha256').update(regression).digest('hex') } };
let failure;
let unjoined = false;
try {
  await fs.writeFile(path.join(source, owner), regression);
  assert.deepEqual(git(source, 'diff', '--name-only').trim().split('\n'), [owner]);
  assert.equal(git(source, 'ls-files', '--others', '--exclude-standard'), '');
  const chunks = [[], []];
  const abort = new AbortController();
  const entry = { bin: 'pnpm', args: ['test:plugins:init-provider-scaffold'], exit: null, startedAt: performance.now(), bytes: 0 };
  receipt.commands.push(entry);
  const outcome = await runManagedCommand({ bin: entry.bin, args: entry.args, cwd: source, env, timeoutMs: 1200000,
    signal: abort.signal, stdio: ['ignore', 'pipe', 'pipe'], requireProcessTreeExit: true, waitForCleanupRelease: true,
    onReady(child) {
      child.once('exit', (code, signal) => { entry.exit = { code, signal }; });
      for (const [index, stream] of [child.stdout, child.stderr].entries()) stream.on('data', (piece) => {
        entry.bytes += piece.length;
        if (entry.bytes > 8 * 1024 * 1024) { abort.abort(new Error('Proof capture budget')); return; }
        chunks[index].push(Buffer.from(piece));
      });
    },
  }).then((status) => ({ status }), (error) => ({ error }));
  entry.settledAt = performance.now(); entry.wallSeconds = (entry.settledAt - entry.startedAt) / 1000;
  entry.unjoined = outcome.error ? hasUnjoinedWork(outcome.error) : false; unjoined = entry.unjoined;
  const texts = chunks.map((pieces) => Buffer.concat(pieces).toString('utf8'));
  await Promise.all(texts.map((text, index) => fs.writeFile(path.join(artifacts, `committed-base-red.${index ? 'stderr' : 'stdout'}.txt`), text)));
  if (outcome.error) { entry.error = { name: outcome.error.name, message: outcome.error.message }; throw outcome.error; }
  entry.status = outcome.status;
  assert.equal(entry.exit?.signal, null); assert.equal(entry.exit?.code, outcome.status);
  assert.notEqual(outcome.status, 0, 'Base generator unexpectedly passed the committed regression');
  assert.match(texts[0], /Generated provider scaffold passed ClawHub validation:/, 'Provider/Inspector prerequisite failed; no CSS RED verdict');
  const featureProject = path.join(projectRoot, 'plugin-init-feature-test');
  const installed = {};
  for (const name of ['typescript', 'openclaw', 'typebox', 'esbuild']) {
    installed[name] = JSON.parse(await fs.readFile(path.join(featureProject, 'node_modules', name, 'package.json'), 'utf8')).version;
  }
  receipt.installed = installed;
  assert.equal(installed.typescript, '7.0.2');
  assert.equal(installed.openclaw, JSON.parse(await fs.readFile(path.join(source, 'package.json'), 'utf8')).version, 'SDK prerequisite mismatch');
  const combined = texts.join('\n');
  const diagnostics = combined.split(/\r?\n/).filter((line) => /error TS\d+:/.test(line));
  receipt.diagnostics = diagnostics;
  assert.equal(diagnostics.length, 1, 'Accept only the unique CSS compiler failure');
  assert.match(diagnostics[0], /error TS2882:.*control-ui\.css/);
  assert.match(combined, /npm run build exited with status 2/);
  assert(!combined.includes('Generated feature scaffold passed build and validation:'));
  for (const file of ['package.json', 'tsconfig.json', 'src/index.ts', 'src/contract.ts', 'src/control-ui.ts', 'src/control-ui.css', 'openclaw.plugin.json', 'package-lock.json']) {
    const target = path.join(artifacts, 'generated', file); await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.join(featureProject, file), target);
  }
  await assert.rejects(fs.access(path.join(featureProject, 'src/styles.d.ts')), { code: 'ENOENT' });
  receipt.verdict = 'Committed package regression is RED only for the base CSS side-effect import';
} catch (error) { failure = error; receipt.error = { name: error.name, message: error.message, stack: error.stack }; }
finally {
  receipt.allChildrenJoined = !unjoined && receipt.commands.every((entry) => Number.isFinite(entry.settledAt) && entry.exit !== null && entry.unjoined === false);
  try {
    assert(receipt.allChildrenJoined, 'Do not restore a source owner still used by a child');
    await fs.writeFile(path.join(source, owner), original);
    assert.deepEqual(await fs.readFile(path.join(source, generator)), generatorBytes);
    assert.equal(git(source, 'rev-parse', 'HEAD').trim(), BASE);
    assert.equal(git(source, 'status', '--porcelain'), '');
    assert.equal(git(candidate, 'status', '--porcelain'), '');
    receipt.sourceRestoredClean = true;
  } catch (error) { receipt.finalCheckErrors.push({ check: 'sourceRestoredClean', message: error.message }); }
  try { assert.equal(await fs.readFile(configFile, 'utf8'), config); receipt.configUnchanged = true; }
  catch (error) { receipt.finalCheckErrors.push({ check: 'configUnchanged', message: error.message }); }
  if (receipt.allChildrenJoined) {
    try { await fs.rm(scratch, { recursive: true, force: true }); receipt.scratchRemoved = true; }
    catch (error) { receipt.finalCheckErrors.push({ check: 'scratchRemoved', message: error.message }); }
  }
  receipt.complete = !failure && receipt.allChildrenJoined && receipt.sourceRestoredClean === true && receipt.configUnchanged === true && receipt.scratchRemoved === true && receipt.finalCheckErrors.length === 0;
  await fs.writeFile(path.join(artifacts, 'committed-base-red.receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
}
if (failure) throw failure;
assert(receipt.complete);
console.log(JSON.stringify({ base: BASE, fixed: FIXED, complete: receipt.complete, verdict: receipt.verdict }));

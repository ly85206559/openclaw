import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

// Source-only preparation for the reviewed lint-only follow-up; execution belongs to the lead.
const source = path.resolve(process.argv[2]);
const artifacts = path.resolve(process.argv[3]);
const head = 'f6d80bab2cdd4b60263ab1c51aac0722a8b07f5b';
const previousHead = '17a59bfc0922e68a628948ead8e6d06b8f0a65f3';
const baseHead = '40c3b508ba130cb9244f077015321b4fa4e91965';
const owner = 'packages/normalization-core/src/markdown-plain-text.ts';
const testFile = 'packages/normalization-core/src/markdown-plain-text.test.ts';
const allocation = 'config/test-lines-allocations/markdown-code-spans.txt';
const git = (...args) => execFileSync('git', args, {
  cwd: source, encoding: 'utf8', timeout: 10000,
  env: { ...process.env, GIT_NO_LAZY_FETCH: '1' },
});
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
await fs.mkdir(artifacts, { recursive: true });
const receipt = {
  head, previousHead, baseHead, complete: false, cleanup: false,
  boundary: 'reviewed one-line source delta plus current-head focused tests, production types, typed lint, canonical format/parity and ordinary ratchet',
  reusedPriorEvidence: {
    head: previousHead, runId: 42825401903,
    url: 'https://github.com/ly85206559/openclaw/actions/runs/42825401903',
    scopes: ['real Gateway seven preview cases and raw history', 'strict Gateway cleanup', 'session preview/web-fetch sibling tests', 'owning package test type graph'],
    limitation: 'These remain prior-head evidence. This workflow does not rerun or relabel Gateway, siblings, test graph or baseline proof.',
  },
  checks: [],
};
let scratch;
let runManagedCommand;
let hasUnjoinedWork;
let failure;
let unjoined = false;
const commands = [];

function environment() {
  const inherited = {};
  for (const key of ['PATH', 'PNPM_HOME', 'COREPACK_HOME', 'LANG', 'LC_ALL', 'TZ', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'GITHUB_ACTIONS', 'RUNNER_OS', 'RUNNER_TEMP']) {
    if (process.env[key] !== undefined) inherited[key] = process.env[key];
  }
  return {
    ...inherited, CI: 'true', NO_COLOR: '1', HOME: scratch, USERPROFILE: scratch,
    XDG_CONFIG_HOME: path.join(scratch, 'xdg-config'), XDG_CACHE_HOME: path.join(scratch, 'xdg-cache'),
    XDG_DATA_HOME: path.join(scratch, 'xdg-data'), TMPDIR: scratch, TMP: scratch, TEMP: scratch,
    OPENCLAW_STATE_DIR: path.join(scratch, 'state'), OPENCLAW_CONFIG_PATH: path.join(scratch, 'openclaw.json'),
  };
}

async function run(name, bin, args, timeoutMs = 300000) {
  const capture = [[], []];
  const abort = new AbortController();
  const record = { name, bin, args, bytes: 0, exit: null, settled: false };
  const started = performance.now();
  const done = runManagedCommand({
    bin, args, cwd: source, env: environment(), stdio: ['ignore', 'pipe', 'pipe'],
    timeoutMs, signal: abort.signal, requireProcessTreeExit: true, waitForCleanupRelease: true,
    onReady(child) {
      child.once('exit', (code, signal) => { record.exit = { code, signal }; });
      for (const [index, stream] of [child.stdout, child.stderr].entries()) {
        stream.on('data', (chunk) => {
          record.bytes += chunk.length;
          if (record.bytes <= 8 * 1024 * 1024) capture[index].push(Buffer.from(chunk));
          else abort.abort(new Error('Proof capture budget exceeded'));
        });
      }
    },
  }).then((status) => ({ status }), (error) => ({ error })).then((outcome) => {
    record.settled = true;
    record.wallSeconds = (performance.now() - started) / 1000;
    record.outcome = outcome;
    return outcome;
  });
  const command = { record, done, abort, async persist() {
    await Promise.all(capture.map((chunks, index) => fs.writeFile(
      path.join(artifacts, `${name}.${index === 0 ? 'stdout' : 'stderr'}.txt`), Buffer.concat(chunks),
    )));
  } };
  commands.push(command);
  const outcome = await done;
  await command.persist();
  unjoined ||= hasUnjoinedWork(outcome.error);
  const check = {
    name, status: outcome.status, exit: record.exit, wallSeconds: record.wallSeconds,
    passed: !outcome.error && outcome.status === 0 && record.exit?.code === 0 && record.exit?.signal === null && record.bytes <= 8 * 1024 * 1024,
    error: outcome.error ? String(outcome.error.stack ?? outcome.error) : undefined,
  };
  receipt.checks.push(check);
  if (!check.passed) failure ??= outcome.error ?? new Error(`${name}: check failed (${outcome.status})`);
  assert(!unjoined && record.exit !== null, `${name}: child cleanup could not be established`);
  return check;
}

async function saveSourceBytes(prefix) {
  const snapshots = [];
  for (const file of [owner, testFile]) {
    const bytes = await fs.readFile(path.join(source, file));
    const output = `${prefix}-${path.basename(file)}`;
    await fs.writeFile(path.join(artifacts, output), bytes);
    snapshots.push({ file, artifact: output, byteLength: bytes.byteLength, sha256: digest(bytes) });
  }
  return snapshots;
}

try {
  assert.match(head, /^[0-9a-f]{40}$/);
  assert.equal(git('rev-parse', 'HEAD').trim(), head);
  assert.equal(git('status', '--porcelain', '--untracked-files=no'), '');
  assert.deepEqual(git('diff', '--name-only', previousHead, head).trim().split('\n'), [owner]);
  const previousSource = git('show', `${previousHead}:${owner}`);
  const currentSource = git('show', `${head}:${owner}`);
  const before = 'Array.from(text.matchAll(/`+/g)).reverse()';
  const after = 'Array.from(text.matchAll(/`+/g)).toReversed()';
  assert.equal(previousSource.split(before).length - 1, 1, 'Previous source does not have the reviewed single replacement');
  assert.equal(currentSource, previousSource.replace(before, after), 'New source differs beyond reverse -> toReversed');
  const unchangedBlobs = [testFile, allocation, 'package.json', 'pnpm-lock.yaml'].map((file) => {
    const prior = git('rev-parse', `${previousHead}:${file}`).trim();
    const current = git('rev-parse', `${head}:${file}`).trim();
    assert.equal(current, prior, `${file}: prior evidence inputs changed`);
    return { file, blob: current };
  });
  assert.equal(git('rev-parse', `${previousHead}:config/test-lines-allocations`), git('rev-parse', `${head}:config/test-lines-allocations`));
  const allocationValues = git('show', `${head}:${allocation}`).split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
  assert.deepEqual(allocationValues, ['3']);
  const countLines = (text) => text.split('\n').length - 1;
  const testLineDelta = countLines(git('show', `${head}:${testFile}`)) - countLines(git('show', `${baseHead}:${testFile}`));
  assert.equal(testLineDelta, 3);
  receipt.inputVerification = { onlyChangedFile: owner, exactReplacement: { before, after }, unchangedBlobs, allAllocationBlobsUnchanged: true, testLineDelta, allocationLines: 3 };
  await fs.writeFile(path.join(artifacts, 'previous-source.ts'), previousSource);
  await fs.writeFile(path.join(artifacts, 'reviewed-source.ts'), currentSource);
  await fs.writeFile(path.join(artifacts, 'reviewed-delta.diff'), git('diff', previousHead, head, '--', owner));

  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'nov10-markdown-final-checks-'));
  ({ runManagedCommand, hasUnjoinedWork } = await import(
    pathToFileURL(path.join(source, 'scripts/lib/managed-child-process.mts')).href
  ));
  const junit = path.join(artifacts, 'normalizer.junit.xml');
  const tests = await run('normalizer-tests', 'pnpm', ['test', testFile, '--maxWorkers=1', '--reporter=junit', `--outputFile=${junit}`]);
  if (tests.passed) {
    try {
      const xml = await fs.readFile(junit, 'utf8');
      const suites = [...xml.matchAll(/<testsuite\b([^>]*)>/g)];
      assert(suites.length > 0, 'Missing JUnit testsuite');
      const count = (name) => suites.reduce((sum, suite) => sum + Number(suite[1].match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? 0), 0);
      const observed = { tests: count('tests'), failures: count('failures'), errors: count('errors'), skipped: count('skipped') };
      assert.deepEqual(observed, { tests: 42, failures: 0, errors: 0, skipped: 0 });
      receipt.normalizerJUnit = observed;
    } catch (error) { tests.passed = false; tests.junitError = String(error.stack ?? error); failure ??= error; }
  }
  await run('package-production-types', process.execPath, ['scripts/run-tsgo.mjs', '-p', 'packages/normalization-core/tsconfig.json', '--noEmit']);
  await run('typed-lint', process.execPath, ['scripts/run-oxlint.mjs', '--tsconfig', 'config/tsconfig/oxlint.core.json', owner, testFile]);
  await run('test-lines-ratchet', 'pnpm', ['check:test-lines-ratchet', '--base', baseHead, '--no-merge-base']);
  const format = await run('format-parity-check', 'pnpm', ['format:check', '--', owner, testFile]);
  receipt.preDiagnosticSourceStatus = git('status', '--porcelain', '--untracked-files=no');
  if (receipt.preDiagnosticSourceStatus !== '') failure ??= new Error('Checks changed tracked source before optional format diagnostics');
  if (!format.passed) {
    receipt.formatDiagnostic = { diagnosticOnly: true, before: await saveSourceBytes('before-format') };
    const formatted = await run('format-diagnostic-write', 'pnpm', ['format', '--', owner, testFile]);
    receipt.formatDiagnostic.formatterPassed = formatted.passed;
    receipt.formatDiagnostic.after = await saveSourceBytes('after-format');
    await fs.writeFile(path.join(artifacts, 'format-diagnostic.diff'), git('diff', '--', owner, testFile));
    receipt.formatDiagnostic.trackedStatus = git('status', '--porcelain', '--untracked-files=no');
    // Formatting here only supplies diagnostic bytes. It cannot repair this run's failed gate.
  }
  git('diff', '--check', baseHead, 'HEAD');
} catch (error) {
  failure ??= error;
  if (hasUnjoinedWork) unjoined ||= hasUnjoinedWork(error);
} finally {
  for (const command of commands) {
    if (!command.record.settled) command.abort.abort();
    const outcome = await command.done;
    unjoined ||= hasUnjoinedWork(outcome.error);
    await command.persist().catch((error) => { failure ??= error; });
  }
  receipt.commands = commands.map(({ record }) => ({ name: record.name, args: record.args, exit: record.exit, status: record.outcome?.status, wallSeconds: record.wallSeconds, settled: record.settled }));
  receipt.allChildrenJoined = commands.every(({ record }) => record.settled && record.exit !== null && !hasUnjoinedWork(record.outcome?.error));
  receipt.unjoinedWork = unjoined;
  try {
    receipt.finalTrackedStatus = git('status', '--porcelain', '--untracked-files=no');
    receipt.sourceClean = receipt.finalTrackedStatus === '';
    await fs.writeFile(path.join(artifacts, 'source-status.txt'), receipt.finalTrackedStatus);
    assert(receipt.allChildrenJoined && !unjoined, 'Strict process cleanup was not established');
    if (!receipt.sourceClean) failure ??= new Error('Tracked source is dirty; diagnostic formatting does not count as exact-head proof');
    if (scratch) {
      assert.equal(path.dirname(scratch), path.resolve(os.tmpdir()));
      await fs.rm(scratch, { recursive: true });
    }
    receipt.cleanup = true;
    receipt.complete = !failure && receipt.sourceClean && receipt.checks.length === 5 && receipt.checks.every((check) => check.passed);
  } catch (error) { failure ??= error; }
  if (failure) { receipt.error = String(failure.stack ?? failure); if (!receipt.cleanup && scratch) receipt.retainedScratch = scratch; }
  await fs.writeFile(path.join(artifacts, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(receipt));
}
if (failure) throw failure;
assert(receipt.complete, 'Final checks did not complete');

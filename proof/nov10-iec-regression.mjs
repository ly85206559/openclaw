import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BASE = '40c3b508ba130cb9244f077015321b4fa4e91965';
const PRODUCT = '097e41e68deaf51e11c3a57b4df811d8d3b7acd1';
const [sourceArg, artifactsArg] = process.argv.slice(2);
assert(sourceArg && artifactsArg);
const source = path.resolve(sourceArg);
const artifacts = path.resolve(artifactsArg);
const relative = path.relative(source, artifacts);
assert(relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative));
const git = (...args) => execFileSync('git', args, { cwd: source, timeout: 10000 });
assert.equal(git('rev-parse', 'HEAD').toString().trim(), BASE);
assert.equal(git('status', '--porcelain', '--untracked-files=no').toString(), '');
const { runManagedCommand, hasUnjoinedWork } = await import(
  pathToFileURL(path.join(source, 'scripts/lib/managed-child-process.mts')).href
);
await fs.mkdir(artifacts, { recursive: true });
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'openclaw-iec-red-regression-'));
const testPath = 'src/config/byte-size.test.ts';
const original = await fs.readFile(path.join(source, testPath));
const committedRegression = git('show', `${PRODUCT}:${testPath}`);
const productPaths = [
  'src/cli/parse-bytes.ts', 'src/config/byte-size.ts',
  'src/config/zod-schema.session-config.ts', 'src/config/sessions/store-maintenance.ts',
];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const before = {};
for (const file of productPaths) before[file] = hash(await fs.readFile(path.join(source, file)));
const receipt = {
  base: BASE, regressionFrom: PRODUCT, testPath,
  claim: 'expected failing committed IEC regression on unchanged base production; not product green',
  complete: false, cleanup: false, exit: null, joined: false,
  regressionSha256: hash(committedRegression), productBefore: before,
};
const outputs = [[], []];
const abort = new AbortController();
let bytes = 0;
let failure;
let outcome;
try {
  await fs.writeFile(path.join(source, testPath), committedRegression);
  await fs.writeFile(path.join(artifacts, 'committed-byte-size.test.ts'), committedRegression);
  assert.equal(git('diff', '--name-only').toString(), `${testPath}\n`);
  const env = {};
  for (const key of ['PATH', 'PNPM_HOME', 'COREPACK_HOME', 'COREPACK_ENABLE_DOWNLOAD_PROMPT',
    'PNPM_CONFIG_STORE_DIR', 'PNPM_CONFIG_CACHE_DIR', 'LANG', 'LC_ALL', 'TZ']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  Object.assign(env, {
    CI: 'true', NO_COLOR: '1', HOME: scratch, USERPROFILE: scratch,
    TMPDIR: scratch, TMP: scratch, TEMP: scratch,
    OPENCLAW_STATE_DIR: path.join(scratch, 'state'),
    OPENCLAW_CONFIG_PATH: path.join(scratch, 'absent-config.json'),
    OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: path.join(scratch, 'vitest-cache'),
  });
  outcome = await runManagedCommand({
    bin: 'pnpm', args: ['test', testPath, '--maxWorkers=1', '--reporter=default', '--reporter=junit',
      `--outputFile.junit=${path.join(artifacts, 'red-regression.xml')}`],
    cwd: source, env, stdio: ['ignore', 'pipe', 'pipe'], timeoutMs: 10 * 60 * 1000,
    signal: abort.signal, requireProcessTreeExit: true, waitForCleanupRelease: true,
    onReady(child) {
      child.once('exit', (code, signal) => { receipt.exit = { code, signal }; });
      for (const [index, stream] of [child.stdout, child.stderr].entries()) {
        assert(stream);
        stream.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes <= 16 * 1024 * 1024) outputs[index].push(Buffer.from(chunk));
          else abort.abort(new Error('Regression capture budget exceeded'));
        });
      }
    },
  }).then((status) => ({ status }), (error) => ({ error }));
  receipt.joined = !outcome.error || !hasUnjoinedWork(outcome.error);
  if (outcome.error) throw outcome.error;
  assert(bytes <= 16 * 1024 * 1024);
  assert.deepEqual(receipt.exit, { code: 1, signal: null });
  assert.equal(outcome.status, 1, 'Only the expected test failure is admissible');
  receipt.expectedTestFailureObserved = true;
} catch (error) {
  failure = error;
} finally {
  for (const [index, channel] of ['stdout', 'stderr'].entries()) {
    await fs.writeFile(path.join(artifacts, `red-regression.${channel}.txt`), Buffer.concat(outputs[index]));
  }
  if (receipt.joined) {
    try {
      receipt.productAfter = {};
      for (const file of productPaths) {
        receipt.productAfter[file] = hash(await fs.readFile(path.join(source, file)));
      }
      assert.deepEqual(receipt.productAfter, before, 'Production bytes changed in the RED fixture');
      assert.equal(git('diff', '--name-only').toString(), `${testPath}\n`);
      await fs.writeFile(path.join(source, testPath), original);
      assert.equal(git('status', '--porcelain', '--untracked-files=no').toString(), '');
      await fs.rm(scratch, { recursive: true });
      receipt.cleanup = true;
      receipt.complete = !failure;
    } catch (error) { failure ??= error; }
  }
  if (failure) receipt.error = String(failure.stack ?? failure);
  if (!receipt.cleanup) receipt.retainedScratch = scratch;
  await fs.writeFile(path.join(artifacts, 'red-regression-receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
}
if (failure) throw failure;
assert(receipt.complete, 'RED regression fixture did not settle');
console.log(JSON.stringify(receipt, null, 2));

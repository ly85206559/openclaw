import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

const BASE_HEAD = '40c3b508ba130cb9244f077015321b4fa4e91965';
const PINNED_HEAD = '097e41e68deaf51e11c3a57b4df811d8d3b7acd1';
const [sourceArg, artifactsArg, requestedHead] = process.argv.slice(2);
assert(sourceArg && artifactsArg, 'Usage: nov10-iec-fixed.mjs <source> <artifacts> <head>');
assert.equal(requestedHead, PINNED_HEAD, 'This fixed controller is frozen to its reviewed source');
const source = path.resolve(sourceArg);
const artifacts = path.resolve(artifactsArg);
const artifactsRelative = path.relative(source, artifacts);
assert(artifactsRelative.startsWith(`..${path.sep}`) || path.isAbsolute(artifactsRelative),
  'Keep proof artifacts outside the product checkout');
const git = (...args) => execFileSync('git', args, {
  cwd: source, encoding: 'utf8', timeout: 10000,
});
assert.equal(git('rev-parse', 'HEAD').trim(), PINNED_HEAD);
assert.equal(git('status', '--porcelain', '--untracked-files=no'), '');
const { runManagedCommand, hasUnjoinedWork } = await import(
  pathToFileURL(path.join(source, 'scripts/lib/managed-child-process.mts')).href
);
const { isSupportedOpenClawNodeVersion } = await import(
  pathToFileURL(path.join(source, 'node-version.mjs')).href
);
assert(isSupportedOpenClawNodeVersion(process.versions.node));
await fs.mkdir(artifacts, { recursive: true });
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'openclaw-iec-fixed-'));
const fixtures = [];
const commands = [];
const receipt = {
  base: BASE_HEAD,
  head: PINNED_HEAD,
  nodeVersion: process.versions.node,
  complete: false,
  cleanup: false,
  claim: 'actual CLI IEC acceptance and independent owner byte values; not packaged-artifact or live cleanup proof',
  cliBoundary: 'actual pnpm openclaw config validate --json, isolated authored config',
  runtimePreparation: 'canonical pnpm openclaw source runner; cold runtime preparation belongs to run-node.mts',
  ownerBoundary: 'separate source-owner resolution using canonical scripts/tsx.mjs; not CLI or packaged-artifact proof',
  cases: [],
  sourceFiles: {},
};
let failure;
let unjoined = false;

function environment(fixture) {
  const env = {};
  for (const key of [
    'PATH', 'PNPM_HOME', 'COREPACK_HOME', 'COREPACK_ENABLE_DOWNLOAD_PROMPT',
    'PNPM_CONFIG_STORE_DIR', 'PNPM_CONFIG_CACHE_DIR', 'LANG', 'LC_ALL', 'TZ',
    'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT',
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return {
    ...env,
    HOME: scratch, USERPROFILE: scratch, CI: 'true', NO_COLOR: '1',
    XDG_CONFIG_HOME: path.join(scratch, 'xdg-config'),
    XDG_CACHE_HOME: path.join(scratch, 'xdg-cache'),
    XDG_DATA_HOME: path.join(scratch, 'xdg-data'),
    TMPDIR: scratch, TMP: scratch, TEMP: scratch,
    OPENCLAW_CONFIG_PATH: fixture.configPath,
    OPENCLAW_STATE_DIR: path.join(fixture.directory, 'state'),
  };
}

async function fixture(name, maxDiskBytes, highWaterBytes) {
  const directory = path.join(scratch, name);
  await fs.mkdir(directory);
  const configPath = path.join(directory, 'openclaw.json');
  const config = JSON.stringify({
    gateway: { mode: 'local' },
    plugins: { allow: [] },
    session: { maintenance: { maxDiskBytes, highWaterBytes } },
  }, null, 2) + '\n';
  await fs.writeFile(configPath, config);
  await fs.writeFile(path.join(artifacts, `${name}.config.json`), config);
  const value = { name, directory, configPath, config };
  fixtures.push(value);
  return value;
}

async function run(name, bin, args, input, expectedExit, timeoutMs = 180000) {
  const capture = [[], []];
  const abort = new AbortController();
  const started = performance.now();
  const record = {
    name, bin, args, expectedExit, bytes: 0,
    exit: null, settled: false, exitVerified: false,
  };
  const done = runManagedCommand({
    bin, args, cwd: source, env: environment(input), stdio: ['ignore', 'pipe', 'pipe'],
    timeoutMs, signal: abort.signal, requireProcessTreeExit: true, waitForCleanupRelease: true,
    onReady(child) {
      child.once('exit', (code, signal) => { record.exit = { code, signal }; });
      for (const [index, stream] of [child.stdout, child.stderr].entries()) {
        assert(stream, `${name}: missing captured stream`);
        stream.on('data', (chunk) => {
          record.bytes += chunk.length;
          if (record.bytes <= 16 * 1024 * 1024) capture[index].push(Buffer.from(chunk));
          else abort.abort(new Error('Proof capture budget exceeded'));
        });
      }
    },
  }).then((status) => ({ status }), (error) => ({ error })).then((outcome) => {
    record.settled = true;
    record.wallSeconds = (performance.now() - started) / 1000;
    if ('status' in outcome) record.status = outcome.status;
    return outcome;
  });
  const command = {
    record, done, abort, outcome: undefined,
    async persist() {
      for (const [index, channel] of ['stdout', 'stderr'].entries()) {
        await fs.writeFile(path.join(artifacts, `${name}.${channel}.txt`), Buffer.concat(capture[index]));
      }
    },
  };
  commands.push(command);
  receipt.cases.push(record);
  command.outcome = await done;
  await command.persist();
  if (command.outcome.error) {
    unjoined ||= hasUnjoinedWork(command.outcome.error);
    throw command.outcome.error;
  }
  assert(record.bytes <= 16 * 1024 * 1024, `${name}: capture overflow`);
  assert.deepEqual(record.exit, { code: expectedExit, signal: null });
  assert.equal(command.outcome.status, expectedExit);
  record.exitVerified = true;
  return JSON.parse(Buffer.concat(capture[0]).toString('utf8'));
}

try {
  for (const file of [
    'package.json', 'src/cli/parse-bytes.ts', 'src/config/zod-schema.session-config.ts',
    'src/config/sessions/store-maintenance.ts', 'scripts/lib/managed-child-process.mts',
  ]) {
    receipt.sourceFiles[file] = createHash('sha256')
      .update(await fs.readFile(path.join(source, file))).digest('hex');
  }
  receipt.changedPaths = git('diff', '--name-only', BASE_HEAD, PINNED_HEAD).trim().split('\n').sort();
  assert.deepEqual(receipt.changedPaths, [
    'config/test-lines-allocations/iec-byte-size-aliases.txt',
    'docs/gateway/config-agents/sessions.md',
    'src/cli/parse-bytes.ts',
    'src/config/byte-size.test.ts',
    'src/config/zod-schema.session-config.ts',
  ].sort(), 'The reviewed IEC proposal must own this complete source delta');
  const ownerScript = [
    "import fs from 'node:fs';",
    "import { resolveMaintenanceConfigFromInput } from './src/config/sessions/store-maintenance.ts';",
    'const config = JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH, "utf8"));',
    'const result = resolveMaintenanceConfigFromInput(config.session.maintenance);',
    'console.log(JSON.stringify({maxDiskBytes: result.maxDiskBytes, highWaterBytes: result.highWaterBytes}));',
  ].join('\n');
  receipt.operationalValues = [];
  const cases = [
    { name: 'legacy-control', max: '1mb', high: '512kb', bytes: { maxDiskBytes: 1048576, highWaterBytes: 524288 } },
    { name: 'iec-small', max: '1MiB', high: '512KiB', bytes: { maxDiskBytes: 1048576, highWaterBytes: 524288 } },
    { name: 'iec-large', max: '1TiB', high: '2GiB', bytes: { maxDiskBytes: 1099511627776, highWaterBytes: 2147483648 } },
  ];
  for (const [index, sample] of cases.entries()) {
    const input = await fixture(sample.name, sample.max, sample.high);
    // The first real CLI call owns cold canonical runtime preparation, included in its wall time.
    const validated = await run(`cli-${sample.name}`, 'pnpm',
      ['--silent', 'openclaw', 'config', 'validate', '--json'], input, 0,
      index === 0 ? 20 * 60 * 1000 : 180000);
    assert.equal(validated.valid, true);
    assert.equal(validated.path, input.configPath);
    const resolved = await run(`source-owner-${sample.name}`, process.execPath,
      ['--import', './scripts/tsx.mjs', '--input-type=module', '--eval', ownerScript], input, 0);
    assert.deepEqual(resolved, sample.bytes);
    receipt.operationalValues.push({ name: sample.name, observed: resolved });
    if (index === 0) receipt.legacyOwnerBytes = resolved;
  }
  receipt.legacyCliValid = true;
  receipt.iecCliValid = true;

  const overflow = await fixture('iec-overflow', '8192TiB', '512KiB');
  const rejected = await run('cli-iec-overflow', 'pnpm',
    ['--silent', 'openclaw', 'config', 'validate', '--json'], overflow, 1);
  assert.equal(rejected.valid, false);
  assert.equal(rejected.path, overflow.configPath);
  assert(Array.isArray(rejected.issues));
  const overflowIssue = rejected.issues.find((entry) =>
    (Array.isArray(entry.path) ? entry.path.join('.') : entry.path) === 'session.maintenance.maxDiskBytes');
  assert(overflowIssue, 'Unsafe IEC input must fail at its actual size-setting boundary');
  assert.match(overflowIssue.message, /invalid size/i);
  receipt.unsafeIecRejected = true;
} catch (error) {
  failure = error;
  unjoined ||= hasUnjoinedWork(error);
} finally {
  for (const command of commands) {
    if (!command.record.settled) command.abort.abort();
    command.outcome = await command.done;
    unjoined ||= hasUnjoinedWork(command.outcome.error);
    await command.persist().catch((error) => { failure ??= error; });
  }
  receipt.allChildrenJoined = commands.every((command) =>
    command.record.settled && command.record.exit !== null && !hasUnjoinedWork(command.outcome.error));
  receipt.unjoinedWork = unjoined;
  try {
    receipt.configsUnchanged = true;
    for (const input of fixtures) {
      receipt.configsUnchanged &&= await fs.readFile(input.configPath, 'utf8') === input.config;
    }
    receipt.sourceClean = git('status', '--porcelain', '--untracked-files=no') === '';
    assert(receipt.configsUnchanged && receipt.sourceClean, 'Authored config or tracked source changed');
    assert(receipt.allChildrenJoined && !unjoined, 'Strict child settlement was not established');
    if (!failure) {
      await fs.rm(scratch, { recursive: true });
      receipt.cleanup = true;
      receipt.complete = true;
    }
  } catch (error) { failure ??= error; }
  if (failure) {
    receipt.error = String(failure.stack ?? failure);
    receipt.retainedScratch = scratch;
  }
  await fs.writeFile(path.join(artifacts, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
}
if (failure) throw failure;
assert(receipt.complete, 'IEC fixed proof did not complete');
console.log(JSON.stringify({
  head: receipt.head, claim: receipt.claim,
  legacyCliValid: receipt.legacyCliValid, iecCliValid: receipt.iecCliValid, unsafeIecRejected: receipt.unsafeIecRejected,
  operationalValues: receipt.operationalValues,
  allChildrenJoined: receipt.allChildrenJoined,
  configsUnchanged: receipt.configsUnchanged, sourceClean: receipt.sourceClean,
  cleanup: receipt.cleanup, complete: receipt.complete,
}, null, 2));

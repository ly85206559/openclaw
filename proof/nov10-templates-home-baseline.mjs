import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

// Preparation only: the lead must review and publish this source before remote execution.
const source = path.resolve(process.argv[2]);
const artifacts = path.resolve(process.argv[3]);
const head = '40c3b508ba130cb9244f077015321b4fa4e91965';
const git = (...args) => execFileSync('git', args, {
  cwd: source, encoding: 'utf8', timeout: 10000,
  env: { ...process.env, GIT_NO_LAZY_FETCH: '1' },
});
assert.equal(git('rev-parse', 'HEAD').trim(), head);
assert.equal(git('status', '--porcelain', '--untracked-files=no'), '');
const { runManagedCommand, hasUnjoinedWork } = await import(
  pathToFileURL(path.join(source, 'scripts/lib/managed-child-process.mts')).href
);
const tar = createRequire(path.join(source, 'package.json'))('tar');
await fs.mkdir(artifacts, { recursive: true });
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'nov10-templates-home-baseline-'));
const home = path.join(scratch, 'home');
const configPath = path.join(scratch, 'openclaw.json');
const unique = `home-proof-${randomUUID()}`;
const absoluteProject = path.join(home, `${unique}-absolute`);
const homeProjectArgument = `~/${unique}-created`;
const homeReadArgument = `~/${unique}-absolute`;
const homeArtifactArgument = `~/${unique}-artifact.tgz`;
const literalParent = path.join(source, '~');
const actualBaselineProject = path.join(literalParent, `${unique}-created`);
const actualBaselineArtifact = path.join(literalParent, `${unique}-artifact.tgz`);
const desiredHomeProject = path.join(home, `${unique}-created`);
const desiredHomeArtifact = path.join(home, `${unique}-artifact.tgz`);
const absoluteArtifact = path.join(scratch, 'absolute-control.tgz');
const commands = [];
const receipt = {
  head, stage: 'baseline', diagnosticOnly: true, complete: false, cleanup: false,
  boundary: 'canonical pnpm openclaw templates create/validate/build, actual argv without shell expansion, real filesystem and tar archive readback',
  limitation: 'New convenience feature baseline; not a released regression claim. No Gateway, vendor, GUI or publishing flow is exercised.',
  deferredFixedControls: ['./~/literal', '~other/literal', 'literal space '],
  cases: [], archives: [],
};
let configBytes;
let literalParentInitiallyMissing = false;
let literalCreateInvoked = false;
let literalBuildInvoked = false;
let failure;
let unjoined = false;

async function exists(target) {
  try { await fs.lstat(target); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function environment() {
  const inherited = {};
  for (const key of ['PATH', 'PNPM_HOME', 'COREPACK_HOME', 'LANG', 'LC_ALL', 'TZ', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT']) {
    if (process.env[key] !== undefined) inherited[key] = process.env[key];
  }
  return {
    ...inherited, HOME: home, USERPROFILE: home, CI: 'true', NO_COLOR: '1',
    XDG_CONFIG_HOME: path.join(scratch, 'xdg-config'), XDG_CACHE_HOME: path.join(scratch, 'xdg-cache'),
    XDG_DATA_HOME: path.join(scratch, 'xdg-data'), TMPDIR: path.join(scratch, 'tmp'),
    TMP: path.join(scratch, 'tmp'), TEMP: path.join(scratch, 'tmp'),
    OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_STATE_DIR: path.join(scratch, 'state'),
  };
}

function start(name, args) {
  const capture = [[], []];
  const abort = new AbortController();
  const record = { name, args, bytes: 0, exit: null, settled: false };
  const started = performance.now();
  const done = runManagedCommand({
    bin: 'pnpm', args: ['--silent', 'openclaw', ...args], cwd: source, env: environment(),
    stdio: ['ignore', 'pipe', 'pipe'], timeoutMs: 180000, signal: abort.signal,
    requireProcessTreeExit: true, waitForCleanupRelease: true,
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
    const output = capture.map((chunks) => Buffer.concat(chunks).toString('utf8'));
    await Promise.all(output.map((text, index) => fs.writeFile(
      path.join(artifacts, `${name}.${index === 0 ? 'stdout' : 'stderr'}.txt`), text,
    )));
    return output;
  } };
  commands.push(command);
  return command;
}

async function cli(name, args, expectedStatus) {
  const command = start(name, args);
  const outcome = await command.done;
  const [stdout] = await command.persist();
  if (outcome.error) { unjoined ||= hasUnjoinedWork(outcome.error); throw outcome.error; }
  assert.equal(outcome.status, expectedStatus, `${name}: unexpected CLI status; inspect raw output`);
  assert.deepEqual(command.record.exit, { code: expectedStatus, signal: null });
  assert(command.record.bytes <= 8 * 1024 * 1024, `${name}: capture overflow`);
  const value = JSON.parse(stdout);
  return value;
}

async function readCreatedProject(root, expectedName, expectedAgentId) {
  const packageBytes = await fs.readFile(path.join(root, 'package.json'));
  const manifestBytes = await fs.readFile(path.join(root, 'CLAW.md'));
  assert.deepEqual(JSON.parse(packageBytes.toString('utf8')), {
    name: expectedName, version: '0.1.0', openclaw: { template: 'CLAW.md' },
  });
  assert(manifestBytes.toString('utf8').includes(`  id: "${expectedAgentId}"`));
  return { packageBytes, manifestBytes, realRoot: await fs.realpath(root) };
}

async function inspectArchive(name, result, expectedArtifact, projectBytes) {
  assert.equal(result.ok, true);
  assert.equal(result.artifact, expectedArtifact);
  assert.deepEqual(result.files, ['CLAW.md', 'package.json']);
  const packed = await fs.readFile(expectedArtifact);
  assert.equal(result.byteLength, packed.byteLength);
  assert.equal(result.integrity, `sha256:${createHash('sha256').update(packed).digest('hex')}`);
  const entries = [];
  await tar.t({ file: expectedArtifact, strict: true, onentry(entry) {
    entries.push({ path: entry.path, type: entry.type });
  } });
  assert.deepEqual(entries.map((entry) => entry.path).sort(), ['package/CLAW.md', 'package/package.json']);
  assert(entries.every((entry) => entry.type === 'File'));
  const extracted = path.join(scratch, `${name}-extracted`);
  await fs.mkdir(extracted);
  await tar.x({ file: expectedArtifact, cwd: extracted, strict: true });
  assert.deepEqual(await fs.readFile(path.join(extracted, 'package', 'package.json')), projectBytes.packageBytes);
  assert.deepEqual(await fs.readFile(path.join(extracted, 'package', 'CLAW.md')), projectBytes.manifestBytes);
  await fs.copyFile(expectedArtifact, path.join(artifacts, `${name}.tgz`));
  const observed = { name, path: expectedArtifact, realPath: await fs.realpath(expectedArtifact), byteLength: packed.byteLength, integrity: result.integrity, entries, exactSourceBytes: true };
  receipt.archives.push(observed);
  return packed;
}

try {
  await fs.mkdir(home);
  await fs.mkdir(path.join(scratch, 'tmp'));
  literalParentInitiallyMissing = !(await exists(literalParent));
  assert(literalParentInitiallyMissing, 'Fresh source checkout already contains a literal ~ directory; refusing to share it');
  assert(!(await exists(actualBaselineProject)) && !(await exists(actualBaselineArtifact)));
  configBytes = JSON.stringify({
    gateway: { mode: 'local' },
    agents: { defaults: { workspace: path.join(scratch, 'workspace') }, entries: { main: {} } },
    plugins: { allow: [] },
  }, null, 2) + '\n';
  await fs.writeFile(configPath, configBytes);
  await fs.writeFile(path.join(artifacts, 'synthetic-config.json'), configBytes);

  const created = await cli('absolute-create-control', [
    'templates', 'create', absoluteProject, '--name', 'home-path-control', '--agent-id', 'home-path-control', '--json',
  ], 0);
  assert.equal(created.ok, true);
  assert.equal(created.root, absoluteProject);
  const projectBytes = await readCreatedProject(absoluteProject, 'home-path-control', 'home-path-control');
  receipt.cases.push({ name: 'absolute-create-control', ok: true, root: created.root, realRoot: projectBytes.realRoot });

  const validated = await cli('absolute-validate-control', ['templates', 'validate', absoluteProject, '--json'], 0);
  assert.equal(validated.ok, true);
  assert.equal(validated.root, projectBytes.realRoot);
  receipt.cases.push({ name: 'absolute-validate-control', ok: true, root: validated.root });

  const homeRead = await cli('home-validate-unexpanded', ['templates', 'validate', homeReadArgument, '--json'], 1);
  assert.equal(homeRead.ok, false);
  assert.equal(homeRead.diagnostics[0]?.code, 'project_not_found');
  assert(await exists(path.join(absoluteProject, 'CLAW.md')), 'Existing HOME project disappeared');
  receipt.cases.push({ name: 'home-validate-unexpanded', argument: homeReadArgument, ok: false, diagnosticCode: homeRead.diagnostics[0].code, existingHomeProject: absoluteProject });

  literalCreateInvoked = true;
  const homeCreated = await cli('home-create-literal-location', [
    'templates', 'create', homeProjectArgument, '--name', 'home-path-created', '--agent-id', 'home-path-created', '--json',
  ], 0);
  assert.equal(homeCreated.ok, true);
  assert.equal(homeCreated.root, actualBaselineProject);
  const literalProjectBytes = await readCreatedProject(actualBaselineProject, 'home-path-created', 'home-path-created');
  assert.equal(await exists(desiredHomeProject), false, 'Home expansion already exists; baseline feature-absence expectation is stale');
  receipt.cases.push({ name: 'home-create-literal-location', argument: homeProjectArgument, actualRoot: homeCreated.root, actualRealRoot: literalProjectBytes.realRoot, desiredHomeRoot: desiredHomeProject, desiredHomeRootAbsent: true });

  literalBuildInvoked = true;
  const homeBuild = await cli('home-output-literal-location', [
    'templates', 'build', absoluteProject, '--out', homeArtifactArgument, '--json',
  ], 0);
  const literalArchive = await inspectArchive('home-output-literal-location', homeBuild, actualBaselineArtifact, projectBytes);
  assert.equal(await exists(desiredHomeArtifact), false, 'Artifact output already expands home');
  receipt.cases.push({ name: 'home-output-literal-location', argument: homeArtifactArgument, actualArtifact: homeBuild.artifact, desiredHomeArtifact, desiredHomeArtifactAbsent: true });

  const absoluteBuild = await cli('absolute-build-control', [
    'templates', 'build', absoluteProject, '--out', absoluteArtifact, '--json',
  ], 0);
  const controlArchive = await inspectArchive('absolute-build-control', absoluteBuild, absoluteArtifact, projectBytes);
  assert.deepEqual(literalArchive, controlArchive, 'Changing only the output spelling changed archive bytes');
  receipt.cases.push({ name: 'absolute-build-control', ok: true, artifact: absoluteBuild.artifact, sameArchiveBytesAsLiteralOutput: true });
  assert.equal(receipt.cases.length, 6);
  receipt.behaviorObserved = true;
} catch (error) {
  failure = error;
  unjoined ||= hasUnjoinedWork(error);
} finally {
  for (const command of commands) {
    if (!command.record.settled) command.abort.abort();
    const outcome = await command.done;
    unjoined ||= hasUnjoinedWork(outcome.error);
    await command.persist().catch((error) => { failure ??= error; });
  }
  receipt.commands = commands.map(({ record }) => ({
    name: record.name, args: record.args, bytes: record.bytes, exit: record.exit,
    settled: record.settled, status: record.outcome?.status, wallSeconds: record.wallSeconds,
    error: record.outcome?.error ? String(record.outcome.error) : undefined,
  }));
  receipt.allChildrenJoined = commands.every(({ record }) => record.settled && record.exit !== null && !hasUnjoinedWork(record.outcome?.error));
  receipt.unjoinedWork = unjoined;
  try {
    receipt.configUnchanged = configBytes !== undefined && await fs.readFile(configPath, 'utf8') === configBytes;
    receipt.sourceClean = git('status', '--porcelain', '--untracked-files=no') === '';
    assert(receipt.allChildrenJoined && !unjoined, 'Strict process cleanup was not established');
    assert(receipt.configUnchanged && receipt.sourceClean, 'Config or tracked source changed');
    // These are exact, UUID-named children of the initially absent source/~ fixture root.
    assert.equal(path.dirname(literalParent), source);
    assert.equal(path.dirname(actualBaselineProject), literalParent);
    assert.equal(path.dirname(actualBaselineArtifact), literalParent);
    if (literalBuildInvoked) await fs.unlink(actualBaselineArtifact).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    if (literalCreateInvoked) await fs.rm(actualBaselineProject, { recursive: true, force: true });
    if (literalParentInitiallyMissing && await exists(literalParent)) await fs.rmdir(literalParent);
    receipt.sourceFixturesRemoved = !(await exists(actualBaselineProject)) && !(await exists(actualBaselineArtifact)) && (!literalParentInitiallyMissing || !(await exists(literalParent)));
    assert(receipt.sourceFixturesRemoved, 'Source fixture paths remain');
    assert.equal(path.dirname(scratch), path.resolve(os.tmpdir()));
    await fs.rm(scratch, { recursive: true });
    receipt.cleanup = true;
    if (!failure) receipt.complete = true;
  } catch (error) { failure ??= error; }
  if (failure) {
    receipt.error = String(failure.stack ?? failure);
    if (!receipt.cleanup) receipt.retainedScratch = scratch;
  }
  await fs.writeFile(path.join(artifacts, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(receipt));
}
if (failure) throw failure;
assert(receipt.complete, 'Template home-path baseline did not complete');

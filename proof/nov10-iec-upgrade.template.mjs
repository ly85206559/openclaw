// Source-only template. Run only after root review in the original fork's secretless Ubuntu Actions.
// Prerequisite: exact source checkout, canonical pinned pnpm setup, pnpm install --frozen-lockfile.
// Invocation from source: node --import ./scripts/tsx.mjs ../controller/proof/nov10-iec-upgrade.template.mjs . ../artifacts
// Real npm installs use one owned prefix; Doctor receives isolated authored config and state.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

const HEAD = '097e41e68deaf51e11c3a57b4df811d8d3b7acd1';
const STABLE = '2026.11.2'; // Verified latest stable for this frozen proof proposal, not a rolling alias.
const [sourceArg, artifactsArg] = process.argv.slice(2);
assert(sourceArg && artifactsArg, 'Usage: nov10-iec-upgrade.template.mjs <source> <artifacts>');
assert.equal(process.platform, 'linux');
assert.equal(process.env.GITHUB_REPOSITORY, 'ly85206559/openclaw');
assert.equal(process.env.GITHUB_ACTIONS, 'true');
const source = path.resolve(sourceArg);
const artifacts = path.resolve(artifactsArg);
const relative = path.relative(source, artifacts);
assert(relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative));
const git = (...args) => execFileSync('git', args, { cwd: source, encoding: 'utf8', timeout: 10000 });
assert.equal(git('rev-parse', 'HEAD').trim(), HEAD);
assert.equal(git('status', '--porcelain', '--untracked-files=no'), '');
const { runManagedCommand, hasUnjoinedWork } = await import(
  pathToFileURL(path.join(source, 'scripts/lib/managed-child-process.mts')).href
);
const { resolveNpmRunner } = await import(pathToFileURL(path.join(source, 'scripts/npm-runner.mts')).href);
const { isSupportedOpenClawNodeVersion } = await import(pathToFileURL(path.join(source, 'node-version.mjs')).href);
assert(isSupportedOpenClawNodeVersion(process.versions.node));
await fs.mkdir(artifacts, { recursive: true });
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'openclaw-iec-upgrade-'));
const home = path.join(scratch, 'home');
const state = path.join(scratch, 'state');
const prefix = path.join(scratch, 'prefix');
const stableDirectory = path.join(scratch, 'stable');
const candidateDirectory = path.join(scratch, 'candidate');
const configPath = path.join(state, 'openclaw.json');
await Promise.all([home, state, prefix, stableDirectory, candidateDirectory].map((directory) => fs.mkdir(directory)));
const inherited = {};
for (const key of ['PATH', 'PNPM_HOME', 'COREPACK_HOME', 'COREPACK_ENABLE_DOWNLOAD_PROMPT',
  'PNPM_CONFIG_STORE_DIR', 'PNPM_CONFIG_CACHE_DIR', 'LANG', 'LC_ALL', 'TZ']) {
  if (process.env[key] !== undefined) inherited[key] = process.env[key];
}
const env = {
  ...inherited, HOME: home, USERPROFILE: home, CI: 'true', NO_COLOR: '1',
  XDG_CONFIG_HOME: path.join(home, 'config'), XDG_CACHE_HOME: path.join(home, 'cache'),
  XDG_DATA_HOME: path.join(home, 'data'), TMPDIR: scratch, TMP: scratch, TEMP: scratch,
  npm_config_cache: path.join(scratch, 'npm-cache'),
  OPENCLAW_STATE_DIR: state, OPENCLAW_CONFIG_PATH: configPath,
};
// Synthetic fixture only. Doctor may write migrations/metadata: preserve snapshots and report them.
await fs.writeFile(configPath, JSON.stringify({
  gateway: { mode: 'local', bind: 'loopback', auth: { mode: 'token', token: 'iec-upgrade-proof-token' } },
  agents: { defaults: { workspace: path.join(scratch, 'workspace') } },
  plugins: { allow: [] },
  session: { maintenance: { maxDiskBytes: '1mb', highWaterBytes: '512kb' } },
}, null, 2) + '\n');
const receipt = {
  head: HEAD, stableVersion: STABLE, nodeVersion: process.versions.node,
  claim: 'same-prefix stable-to-candidate npm package replacement, Doctor and retained legacy config compatibility',
  artifactScope: 'canonical private runtime package; no release, SDK declarations, live Gateway or session cleanup claim',
  complete: false, cleanup: false, commands: [], configSnapshots: [], installations: [],
};
const commands = [];
let failure;
let unjoined = false;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function run(name, bin, args, cwd = source, timeoutMs = 180000, commandEnv = env) {
  const chunks = [[], []];
  const abort = new AbortController();
  const started = performance.now();
  const record = { name, bin, args, cwd, bytes: 0, exit: null, settled: false };
  const done = runManagedCommand({
    bin, args, cwd, env: commandEnv, stdio: ['ignore', 'pipe', 'pipe'],
    timeoutMs, signal: abort.signal, requireProcessTreeExit: true, waitForCleanupRelease: true,
    onReady(child) {
      child.once('exit', (code, signal) => { record.exit = { code, signal }; });
      for (const [index, stream] of [child.stdout, child.stderr].entries()) {
        assert(stream);
        stream.on('data', (chunk) => {
          record.bytes += chunk.length;
          if (record.bytes <= 64 * 1024 * 1024) chunks[index].push(Buffer.from(chunk));
          else abort.abort(new Error('Upgrade proof capture budget exceeded'));
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
    record, abort, done,
    async persist() {
      for (const [index, channel] of ['stdout', 'stderr'].entries()) {
        await fs.writeFile(path.join(artifacts, `${name}.${channel}.txt`), Buffer.concat(chunks[index]));
      }
    },
  };
  commands.push(command);
  receipt.commands.push(record);
  command.outcome = await done;
  await command.persist();
  if (command.outcome.error) {
    unjoined ||= hasUnjoinedWork(command.outcome.error);
    throw command.outcome.error;
  }
  assert(record.bytes <= 64 * 1024 * 1024);
  assert.deepEqual(record.exit, { code: 0, signal: null });
  assert.equal(command.outcome.status, 0);
  return Buffer.concat(chunks[0]).toString('utf8');
}

async function npm(name, args, cwd = prefix, timeoutMs = 30 * 60 * 1000) {
  const invocation = resolveNpmRunner({ env, npmArgs: args });
  assert.equal(invocation.shell, false);
  return run(name, invocation.command, invocation.args, cwd, timeoutMs, invocation.env ?? env);
}

async function snapshot(name) {
  const bytes = await fs.readFile(configPath);
  const config = JSON.parse(bytes.toString('utf8'));
  assert.equal(config.session.maintenance.maxDiskBytes, '1mb');
  assert.equal(config.session.maintenance.highWaterBytes, '512kb');
  const entry = { name, sha256: sha256(bytes), bytes: bytes.length };
  const previous = receipt.configSnapshots.at(-1);
  entry.changedFromPrevious = previous ? entry.sha256 !== previous.sha256 : false;
  receipt.configSnapshots.push(entry);
  await fs.writeFile(path.join(artifacts, `${name}.config.json`), bytes);
  return entry;
}

async function install(name, archive) {
  const manifestPath = path.join(prefix, 'package.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  // Same canonical archive-scoped lifecycle policy used by apps/linux/scripts/stage-package.mjs.
  manifest.allowScripts = { ...manifest.allowScripts, [archive]: true };
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  await npm(`install-${name}`, ['install', '--prefix', prefix, '--omit=dev', '--include=optional',
    '--no-audit', '--no-fund', `openclaw@file:${archive}`]);
  const root = path.join(prefix, 'node_modules', 'openclaw');
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'openclaw');
  assert.equal(pkg.bin.openclaw, 'openclaw.mjs');
  const provenance = JSON.parse(await fs.readFile(path.join(root, 'dist/build-info.json'), 'utf8'));
  const entry = { name, prefix, packageVersion: pkg.version, buildInfo: provenance,
    archiveSha256: sha256(await fs.readFile(archive)) };
  receipt.installations.push(entry);
  if (name === 'stable') assert.equal(pkg.version, STABLE);
  else assert.equal(provenance.commit, HEAD, 'Installed candidate must identify the reviewed commit');
  return path.join(prefix, 'node_modules', '.bin', 'openclaw');
}

async function installedByteValues(name) {
  // This is the installed package's documented runtime export, not a copied parser or CLI output.
  const script = [
    "import fs from 'node:fs'; import path from 'node:path';",
    "import { createRequire } from 'node:module'; import { pathToFileURL } from 'node:url';",
    `const require = createRequire(${JSON.stringify(path.join(prefix, 'package.json'))});`,
    "const entry = require.resolve('openclaw/plugin-sdk/memory-core-host-runtime-core');",
    'const { parseNonNegativeByteSize } = await import(pathToFileURL(entry).href);',
    'const config = JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH, "utf8"));',
    'const result = Object.fromEntries(["maxDiskBytes", "highWaterBytes"].map(key =>',
    '  [key, parseNonNegativeByteSize(config.session.maintenance[key])]));',
    'console.log(JSON.stringify({entry, result}));',
  ].join('\n');
  const observed = JSON.parse(await run(`installed-sdk-${name}`, process.execPath,
    ['--input-type=module', '--eval', script], prefix));
  assert(observed.entry.startsWith(path.join(prefix, 'node_modules', 'openclaw') + path.sep));
  assert.deepEqual(observed.result, { maxDiskBytes: 1048576, highWaterBytes: 524288 });
  return observed;
}

try {
  await fs.writeFile(path.join(prefix, 'package.json'), '{"private":true}\n');
  await snapshot('authored');
  const packed = JSON.parse(await npm('fetch-stable', ['pack', `openclaw@${STABLE}`, '--json',
    '--pack-destination', stableDirectory], scratch));
  assert.equal(packed.length, 1);
  assert.equal(packed[0].name, 'openclaw');
  assert.equal(packed[0].version, STABLE);
  assert.equal(path.basename(packed[0].filename), packed[0].filename);
  receipt.stableRegistryPack = packed[0];
  const stableArchive = path.join(stableDirectory, packed[0].filename);
  const cli = await install('stable', stableArchive);
  const afterStableInstall = await snapshot('after-stable-install');
  assert.equal(afterStableInstall.changedFromPrevious, false, 'Package install must not rewrite operator config');
  await run('stable-doctor', cli, ['doctor', '--non-interactive'], prefix);
  await snapshot('after-stable-doctor');
  const stableValidated = JSON.parse(await run('stable-validate', cli, ['config', 'validate', '--json'], prefix));
  assert.equal(stableValidated.valid, true);
  assert.equal(stableValidated.path, configPath);
  receipt.stableInstalledByteValues = await installedByteValues('stable');
  const beforeBuild = await snapshot('before-candidate-build');

  const candidateArchive = path.join(candidateDirectory, 'openclaw-iec-upgrade.tgz');
  await run('canonical-candidate-package', process.execPath,
    ['scripts/package-openclaw-for-docker.mjs', '--runtime-only', '--allow-unreleased-changelog',
      '--output-dir', candidateDirectory, '--output-name', path.basename(candidateArchive),
      '--pack-json', path.join(artifacts, 'candidate-pack.json')], source, 75 * 60 * 1000);
  assert.equal(git('status', '--porcelain', '--untracked-files=no'), '', 'Canonical pack lifecycle must restore tracked source');
  const afterBuild = await snapshot('after-candidate-build');
  assert.equal(afterBuild.sha256, beforeBuild.sha256, 'Package build must not rewrite operator config');
  const candidateCli = await install('candidate', candidateArchive);
  assert.equal(candidateCli, cli, 'Both packages must occupy the same npm prefix and declared CLI');
  const afterReplacement = await snapshot('after-candidate-install');
  assert.equal(afterReplacement.sha256, afterBuild.sha256, 'Package replacement must not rewrite operator config');
  assert.notEqual(receipt.installations[0].buildInfo.commit, receipt.installations[1].buildInfo.commit);
  await run('candidate-doctor-fix', candidateCli, ['doctor', '--fix', '--non-interactive'], prefix);
  await snapshot('after-candidate-doctor');
  const validated = JSON.parse(await run('candidate-validate', candidateCli, ['config', 'validate', '--json'], prefix));
  assert.equal(validated.valid, true);
  assert.equal(validated.path, configPath);
  receipt.candidateInstalledByteValues = await installedByteValues('candidate');
  const final = await snapshot('after-final-validation');
  assert.equal(final.changedFromPrevious, false, 'Read-only validation and SDK resolution must not write config');
  receipt.configBytesChanged = final.sha256 !== receipt.configSnapshots[0].sha256;
  receipt.legacyBudgetStringsPreserved = true;
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
  receipt.allChildrenJoined = commands.every((command) => command.record.settled &&
    command.record.exit !== null && !hasUnjoinedWork(command.outcome.error));
  receipt.unjoinedWork = unjoined;
  try {
    receipt.sourceClean = git('status', '--porcelain', '--untracked-files=no') === '';
    assert(receipt.sourceClean && receipt.allChildrenJoined && !unjoined);
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
  await fs.writeFile(path.join(artifacts, 'upgrade-receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
}
if (failure) throw failure;
assert(receipt.complete);
console.log(JSON.stringify(receipt, null, 2));

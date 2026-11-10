import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Source-only prepared proof; execute only on the reviewed secretless runner.
const HEAD = '188689fb9b1db0633e49c4204bfc39ef8bbfbd70';
const source = path.resolve(process.argv[2]);
const artifacts = path.resolve(process.argv[3]);
assert.match(HEAD, /^[a-f0-9]{40}$/, 'Fill the reviewed candidate SHA before executing this template');
const git = (...args) => execFileSync('git', args, { cwd: source, encoding: 'utf8', timeout: 10000 });
assert.equal(git('rev-parse', 'HEAD').trim(), HEAD);
assert.equal(git('status', '--porcelain'), '');
const { runManagedCommand, hasUnjoinedWork } = await import(pathToFileURL(path.join(source, 'scripts/lib/managed-child-process.mts')).href);
await fs.mkdir(artifacts, { recursive: true });
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'feature-css-fixed-'));
const project = path.join(scratch, 'draft-review');
const configFile = path.join(scratch, 'openclaw.json');
const configBytes = `${JSON.stringify({ agents: { ownership: 'explicit', entries: { main: { workspace: path.join(scratch, 'workspace') } } } }, null, 2)}\n`;
await fs.writeFile(configFile, configBytes);
const inherited = {};
for (const key of ['PATH', 'PNPM_HOME', 'COREPACK_HOME', 'LANG', 'LC_ALL', 'TZ']) if (process.env[key] !== undefined) inherited[key] = process.env[key];
const env = { ...inherited, HOME: scratch, USERPROFILE: scratch, TMPDIR: scratch, TMP: scratch, TEMP: scratch,
  XDG_CONFIG_HOME: path.join(scratch, 'xdg-config'), XDG_CACHE_HOME: path.join(scratch, 'xdg-cache'), XDG_DATA_HOME: path.join(scratch, 'xdg-data'),
  OPENCLAW_CONFIG_PATH: configFile, OPENCLAW_STATE_DIR: path.join(scratch, 'state'), CI: 'true', NO_COLOR: '1' };
const receipt = { head: HEAD, complete: false, allChildrenJoined: false, sourceClean: false, configUnchanged: false, generatedInputsUnchanged: false, scratchRemoved: false, validationPreservedBuild: false,
  boundary: 'stock pnpm openclaw plugins init --type feature; untouched generated npm install and npm run build', commands: [] };
const generated = new Map();
let failure;
let unjoined = false;

async function command(name, bin, args, cwd, timeoutMs = 180000, envOverrides = {}) {
  const chunks = [[], []];
  const abort = new AbortController();
  const entry = { name, bin, args, bytes: 0, exit: null, startedAt: performance.now() };
  receipt.commands.push(entry);
  const outcome = await runManagedCommand({ bin, args, cwd, env: { ...env, ...envOverrides }, timeoutMs, signal: abort.signal, stdio: ['ignore', 'pipe', 'pipe'],
    requireProcessTreeExit: true, waitForCleanupRelease: true,
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
  entry.unjoined = outcome.error ? hasUnjoinedWork(outcome.error) : false; unjoined ||= entry.unjoined;
  const texts = chunks.map((pieces) => Buffer.concat(pieces).toString('utf8'));
  await Promise.all(texts.map((text, index) => fs.writeFile(path.join(artifacts, `${name}.${index ? 'stderr' : 'stdout'}.txt`), text)));
  if (outcome.error) { entry.error = { name: outcome.error.name, message: outcome.error.message }; throw outcome.error; }
  entry.status = outcome.status;
  assert.equal(entry.exit?.signal, null, `${name}: unexpected signal`);
  assert.equal(entry.exit?.code, outcome.status, `${name}: exit mismatch`);
  return { status: outcome.status, stdout: texts[0], stderr: texts[1] };
}

try {
  const init = await command('init', 'pnpm', ['--silent', 'openclaw', 'plugins', 'init', 'draft-review', '--name', 'Draft Review', '--type', 'feature', '--directory', project], source);
  assert.equal(init.status, 0);
  for (const file of ['package.json', 'tsconfig.json', 'src/index.ts', 'src/contract.ts', 'src/control-ui.ts', 'src/styles.d.ts', 'src/control-ui.css', 'openclaw.plugin.json', 'README.md']) {
    const bytes = await fs.readFile(path.join(project, file)); generated.set(file, bytes);
    const target = path.join(artifacts, 'generated', file); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes);
  }
  const manifest = JSON.parse(generated.get('package.json').toString('utf8'));
  const tsconfig = JSON.parse(generated.get('tsconfig.json').toString('utf8'));
  assert.equal(manifest.scripts.build, 'tsc -p tsconfig.json && openclaw plugins build');
  assert.equal(manifest.devDependencies.typescript, '7.0.2');
  assert.equal(manifest.devDependencies.openclaw, 'latest');
  assert.deepEqual(tsconfig.include, ['src/**/*.ts']);
  const install = await command('npm-install', 'npm', ['install', '--no-audit', '--fund=false'], project, 900000);
  assert.equal(install.status, 0, 'Dependency prerequisite failed; this is not a fixed-build verdict');
  await fs.copyFile(path.join(project, 'package-lock.json'), path.join(artifacts, 'package-lock.json'));
  receipt.installed = {};
  for (const name of ['typescript', 'openclaw', 'typebox', 'esbuild']) {
    const installed = JSON.parse(await fs.readFile(path.join(project, 'node_modules', name, 'package.json'), 'utf8'));
    receipt.installed[name] = { version: installed.version };
  }
  assert.equal(receipt.installed.typescript.version, '7.0.2');
  const hostVersion = JSON.parse(await fs.readFile(path.join(source, 'package.json'), 'utf8')).version;
  assert.equal(receipt.installed.openclaw.version, hostVersion, 'Published SDK version differs from the generating host; stop before a product verdict');
  const build = await command('npm-build', 'npm', ['run', 'build'], project, 180000);
  assert.equal(build.status, 0, 'The unchanged advertised feature build must succeed');
  const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const buildSnapshot = new Map();
  receipt.buildOwnedMetadata = [];
  for (const file of ['package.json', 'openclaw.plugin.json']) {
    const before = generated.get(file);
    const after = await fs.readFile(path.join(project, file));
    buildSnapshot.set(file, after);
    receipt.buildOwnedMetadata.push({ file, beforeSha256: digest(before), afterSha256: digest(after), changed: !before.equals(after) });
    await fs.writeFile(path.join(artifacts, `built-${file}`), after);
  }
  const builtManifest = JSON.parse(buildSnapshot.get('openclaw.plugin.json').toString('utf8'));
  const builtPackage = JSON.parse(buildSnapshot.get('package.json').toString('utf8'));
  assert.equal(builtManifest.id, 'draft-review');
  const ui = builtManifest.controlUi;
  assert(ui && typeof ui.entry === 'string');
  assert.match(ui.entry, /^dist\/control-ui\/[a-f0-9]{64}\/index\.js$/);
  assert.deepEqual(ui.styles, [`${path.posix.dirname(ui.entry)}/index.css`]);
  assert.equal(builtPackage.openclaw.controlUi, './src/control-ui.ts');
  assert.deepEqual(builtPackage.openclaw.extensions, ['./dist/index.js']);
  const generation = path.posix.dirname(ui.entry);
  const generationDir = path.join(project, generation);
  const assetNames = (await fs.readdir(generationDir)).toSorted();
  assert(assetNames.includes('index.js') && assetNames.includes('index.css'));
  assert(assetNames.every((name) => /^[A-Za-z0-9._-]+\.(?:js|css)$/.test(name)));
  receipt.bundle = { manifestSha256: digest(buildSnapshot.get('openclaw.plugin.json')), generation, assets: [] };
  for (const name of assetNames) {
    const file = `${generation}/${name}`;
    const bytes = await fs.readFile(path.join(project, file));
    assert(bytes.length > 0, `${file} must be non-empty`);
    buildSnapshot.set(file, bytes);
    receipt.bundle.assets.push({ file, bytes: bytes.length, sha256: digest(bytes) });
    const target = path.join(artifacts, 'bundle', name); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes);
  }
  const backend = await fs.readFile(path.join(project, 'dist/index.js'));
  assert(backend.length > 0); buildSnapshot.set('dist/index.js', backend);
  receipt.backend = { file: 'dist/index.js', bytes: backend.length, sha256: digest(backend) };
  const validate = await command('npm-validate', 'npm', ['run', 'validate'], project, 180000);
  assert.equal(validate.status, 0, 'Native validation of the built scaffold must succeed');
  const jsonStart = validate.stdout.indexOf('{');
  assert(jsonStart >= 0, 'Native validation emitted no JSON result');
  const validation = JSON.parse(validate.stdout.slice(jsonStart));
  assert.deepEqual(validation, { valid: true, pluginId: 'draft-review', errors: [] });
  receipt.validation = validation;
  // Native validation checks the published generation. It must not rewrite the build.
  for (const [file, bytes] of buildSnapshot) assert.deepEqual(await fs.readFile(path.join(project, file)), bytes, `Validation changed ${file}`);
  receipt.validationPreservedBuild = true;
  const checks = [
    ['existing-cli-scaffold-tests', 'pnpm', ['test', 'src/cli/plugins-authoring-command.test.ts', 'src/cli/plugins-scaffold-compilation.test.ts', '--maxWorkers=1']],
    ['core-types', 'pnpm', ['tsgo:core']],
    ['scripts-types', 'pnpm', ['tsgo:scripts']],
    ['core-owned-lint', 'node', ['scripts/run-oxlint.mjs', '--tsconfig', 'config/tsconfig/oxlint.core.json', 'src/cli/plugins-feature-scaffold.ts']],
    ['scripts-owned-lint', 'node', ['scripts/run-oxlint.mjs', '--tsconfig', 'config/tsconfig/oxlint.scripts.json', 'scripts/validate-plugin-init-provider-scaffold.ts']],
    ['owned-format', 'pnpm', ['format:check', '--', 'src/cli/plugins-feature-scaffold.ts', 'scripts/validate-plugin-init-provider-scaffold.ts']],
  ];
  for (const [name, bin, args] of checks) {
    const check = await command(name, bin, args, source, 600000);
    assert.equal(check.status, 0, `${name} must pass`);
  }
  const regression = await command('committed-provider-feature-regression', 'pnpm', ['test:plugins:init-provider-scaffold'], source, 1200000,
    { OPENCLAW_PLUGIN_INIT_VALIDATE_ROOT: path.join(scratch, 'committed-regression') });
  assert.equal(regression.status, 0, 'Committed provider/feature package validation must pass; registry, Inspector, install-script, and other prerequisite failures are separate from the CSS verdict');
  assert.match(regression.stdout, /Generated provider scaffold passed ClawHub validation:/);
  assert.match(regression.stdout, /Generated feature scaffold passed build and validation:/);
  receipt.committedRegressionPassed = true;
  receipt.generatedHashes = Object.fromEntries([...generated].map(([file, bytes]) => [file, createHash('sha256').update(bytes).digest('hex')]));
  receipt.observed = 'Actual CLI-generated feature passes its advertised build and native validation, with a readable JavaScript/CSS generation';
} catch (error) { failure = error; receipt.error = { name: error.name, message: error.message, stack: error.stack }; }
finally {
  receipt.finalCheckErrors = [];
  receipt.allChildrenJoined = !unjoined && receipt.commands.every((entry) => Number.isFinite(entry.settledAt) && entry.exit !== null && entry.unjoined === false);
  try { assert.equal(git('rev-parse', 'HEAD').trim(), HEAD); assert.equal(git('status', '--porcelain'), ''); receipt.sourceClean = true; }
  catch (error) { receipt.finalCheckErrors.push({ check: 'sourceClean', message: error.message }); }
  try { assert.equal(await fs.readFile(configFile, 'utf8'), configBytes); receipt.configUnchanged = true; }
  catch (error) { receipt.finalCheckErrors.push({ check: 'configUnchanged', message: error.message }); }
  try {
    for (const [file, bytes] of generated) {
      // plugins build owns these metadata writes; their exact before/after bytes are archived above.
      if (file === 'package.json' || file === 'openclaw.plugin.json') continue;
      assert.deepEqual(await fs.readFile(path.join(project, file)), bytes, file);
    }
    receipt.generatedInputsUnchanged = true;
  }
  catch (error) { receipt.finalCheckErrors.push({ check: 'generatedInputsUnchanged', message: error.message }); }
  if (receipt.allChildrenJoined) {
    try { await fs.rm(scratch, { recursive: true, force: true }); receipt.scratchRemoved = true; }
    catch (error) { receipt.finalCheckErrors.push({ check: 'scratchRemoved', message: error.message }); }
  }
  receipt.complete = !failure && receipt.allChildrenJoined && receipt.sourceClean && receipt.configUnchanged && receipt.generatedInputsUnchanged && receipt.validationPreservedBuild && receipt.committedRegressionPassed === true && receipt.scratchRemoved && receipt.finalCheckErrors.length === 0;
  await fs.writeFile(path.join(artifacts, 'feature-css-fixed.receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
}
if (failure) throw failure;
assert(receipt.complete);
console.log(JSON.stringify({ head: HEAD, complete: receipt.complete, observed: receipt.observed, installed: receipt.installed }));

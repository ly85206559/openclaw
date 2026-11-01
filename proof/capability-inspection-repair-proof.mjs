import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

const [sourceArg, artifactsArg, head, family, stage, priorHead] = process.argv.slice(2);
const source = path.resolve(sourceArg);
const artifacts = path.resolve(artifactsArg);
assert(/^[a-f0-9]{40}$/.test(head));
assert(/^[a-f0-9]{40}$/.test(priorHead));
assert(['web', 'embedding'].includes(family));
assert(['prior', 'fixed'].includes(stage));
const fixed = stage === 'fixed';
const git = (...args) => execFileSync('git', args, { cwd: source, encoding: 'utf8', timeout: 10000 });
assert.equal(git('rev-parse', 'HEAD').trim(), head);
const { runManagedCommand, hasUnjoinedWork } = await import(pathToFileURL(path.join(source, 'scripts/lib/managed-child-process.mts')).href);
await fs.mkdir(artifacts, { recursive: true });
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'capability-inspection-proof-'));
const metadataPath = 'src/cli/capability-cli/metadata.ts';
const contracts = {
  web: {
    id: 'web.fetch',
    description: 'Fetch URL content directly or through a selected web fetch provider.',
    transports: ['local'], resultShape: 'page content with fetch metadata',
    priorFlags: ['--url', '--provider', '--format', '--json'],
    fixedFlags: ['--url', '--provider', '--format', '--max-chars', '--json'],
    flag: '--max-chars', helpArgs: ['infer', 'web', 'fetch', '--help'],
  },
  embedding: {
    id: 'embedding.create',
    description: 'Create embeddings through embedding providers.',
    transports: ['local'], resultShape: 'vectors with provider/model attribution',
    priorFlags: ['--text', '--provider', '--model', '--agent', '--json'],
    fixedFlags: ['--text', '--input-type', '--provider', '--model', '--agent', '--json'],
    flag: '--input-type', helpArgs: ['infer', 'embedding', 'create', '--help'],
  },
};
const contract = contracts[family];
const expected = {
  id: contract.id, description: contract.description, transports: contract.transports,
  flags: fixed ? contract.fixedFlags : contract.priorFlags, resultShape: contract.resultShape,
};
const sibling = {
  id: 'model.list', description: 'List known models from the model catalog.',
  transports: ['local'], flags: ['--json'], resultShape: 'catalog entries',
};
const configPath = path.join(scratch, 'openclaw.json');
const config = JSON.stringify({ gateway: { mode: 'local' }, plugins: { allow: [] } }, null, 2) + '\n';
const receipt = {
  head, priorHead, family, stage, complete: false, cleanup: false, cases: [],
  boundary: 'actual infer/capability inspect, command help, and infer list CLI',
  claim: fixed ? 'repaired capability discovery' : 'diagnostic feature-discovery absence only; not product green',
};
const commands = [];
let failure;
let unjoined = false;

function environment() {
  const env = {};
  for (const key of ['PATH', 'PNPM_HOME', 'COREPACK_HOME', 'LANG', 'LC_ALL', 'TZ', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return {
    ...env, HOME: scratch, USERPROFILE: scratch, CI: 'true', NO_COLOR: '1',
    XDG_CONFIG_HOME: path.join(scratch, 'xdg-config'), XDG_CACHE_HOME: path.join(scratch, 'xdg-cache'),
    XDG_DATA_HOME: path.join(scratch, 'xdg-data'), TMPDIR: scratch, TMP: scratch, TEMP: scratch,
    OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_STATE_DIR: path.join(scratch, 'state'),
  };
}

async function cli(name, args) {
  const capture = [[], []];
  const abort = new AbortController();
  const started = performance.now();
  const record = { name, args, bytes: 0, exit: null, settled: false, exitVerified: false };
  const done = runManagedCommand({
    bin: 'pnpm', args: ['--silent', 'openclaw', ...args], cwd: source, env: environment(),
    stdio: ['ignore', 'pipe', 'pipe'], timeoutMs: 180000, signal: abort.signal,
    requireProcessTreeExit: true, waitForCleanupRelease: true,
    onReady(child) {
      child.once('exit', (code, signal) => { record.exit = { code, signal }; });
      for (const [index, stream] of [child.stdout, child.stderr].entries()) {
        stream.on('data', (chunk) => {
          record.bytes += chunk.length;
          if (record.bytes <= 4 * 1024 * 1024) capture[index].push(Buffer.from(chunk));
          else abort.abort(new Error('Proof capture budget exceeded'));
        });
      }
    },
  }).then((status) => ({ status }), (error) => ({ error })).then((outcome) => {
    record.settled = true;
    record.wallSeconds = (performance.now() - started) / 1000;
    record.status = outcome.status;
    return outcome;
  });
  const command = { record, done, abort, outcome: undefined, async persist() {
    for (const [index, channel] of ['stdout', 'stderr'].entries()) {
      await fs.writeFile(path.join(artifacts, `${name}.${channel}.txt`), Buffer.concat(capture[index]));
    }
  } };
  commands.push(command);
  receipt.cases.push(record);
  const result = await done;
  command.outcome = result;
  await command.persist();
  if (result.error) { unjoined ||= hasUnjoinedWork(result.error); throw result.error; }
  assert(record.bytes <= 4 * 1024 * 1024, `${name}: capture overflow`);
  assert.deepEqual(record.exit, { code: 0, signal: null });
  assert.equal(result.status, 0);
  record.exitVerified = true;
  return Buffer.concat(capture[0]).toString('utf8');
}

try {
  await fs.writeFile(configPath, config);
  await fs.writeFile(path.join(artifacts, 'synthetic-config.json'), config);
  const metadata = await fs.readFile(path.join(source, metadataPath), 'utf8');
  await fs.writeFile(path.join(artifacts, 'metadata.ts'), metadata);
  if (fixed) {
    assert.deepEqual(git('diff', '--name-only', priorHead, head).trim().split('\n'), [metadataPath]);
    const before = git('show', `${priorHead}:${metadataPath}`);
    await fs.writeFile(path.join(artifacts, 'prior-metadata.ts'), before);
    const oldLine = `    flags: ${JSON.stringify(contract.priorFlags).replaceAll(',', ', ')},`;
    const newLine = `    flags: ${JSON.stringify(contract.fixedFlags).replaceAll(',', ', ')},`;
    assert.equal(before.split(oldLine).length, 2, 'Expected one prior metadata flags line');
    assert.equal(metadata, before.replace(oldLine, newLine), 'Repair must change only the one metadata flags line');
    receipt.metadataOnlyRepair = true;
    receipt.executionTestsDocsAndSdkUnchanged = true;
    await fs.writeFile(path.join(artifacts, 'metadata-only.patch'), git('diff', priorHead, head));
  } else assert.equal(head, priorHead);

  const inspected = JSON.parse(await cli('inspect-json', ['infer', 'inspect', '--name', contract.id, '--json']));
  assert.deepEqual(inspected, expected);
  assert.equal(inspected.flags.includes(contract.flag), fixed);
  const textOutput = await cli('inspect-text', ['infer', 'inspect', '--name', contract.id]);
  assert.equal(textOutput, JSON.stringify(expected, null, 2) + '\n');
  const inspectedText = JSON.parse(textOutput);
  assert.deepEqual(inspectedText, expected);
  const alias = JSON.parse(await cli('alias-inspect-json', ['capability', 'inspect', '--name', contract.id, '--json']));
  assert.deepEqual(alias, expected);
  const help = await cli('command-help', contract.helpArgs);
  assert(help.includes(contract.flag), 'The actual command must already advertise the accepted flag at both heads');
  if (family === 'embedding') assert(help.includes('document') && help.includes('query'));
  const siblingResult = JSON.parse(await cli('sibling-inspect-json', ['infer', 'inspect', '--name', sibling.id, '--json']));
  assert.deepEqual(siblingResult, sibling);
  const listed = JSON.parse(await cli('list-json', ['infer', 'list', '--json']));
  assert(Array.isArray(listed) && listed.length > 0);
  assert.equal(new Set(listed.map((entry) => entry.id)).size, listed.length);
  for (const item of [expected, sibling]) {
    assert.deepEqual(listed.find((entry) => entry.id === item.id), {
      id: item.id, transports: item.transports, description: item.description,
    });
  }
  const listedText = await cli('list-text', ['infer', 'list']);
  assert.deepEqual(listedText.trim().split('\n').map((line) => JSON.parse(line)), listed);
  receipt.discoveryFlagPresent = inspected.flags.includes(contract.flag);
  receipt.commandHelpFlagPresent = true;
  receipt.listAndSiblingUnchanged = true;
  receipt.publicContractVerified = true;
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
  receipt.allChildrenJoined = commands.every((command) => command.record.settled && command.record.exit !== null && !hasUnjoinedWork(command.outcome.error));
  receipt.unjoinedWork = unjoined;
  try {
    receipt.configUnchanged = await fs.readFile(configPath, 'utf8') === config;
    receipt.sourceClean = git('status', '--porcelain', '--untracked-files=no') === '';
    assert(receipt.configUnchanged && receipt.sourceClean, 'Config or tracked source changed');
    assert(receipt.allChildrenJoined && !unjoined, 'Strict child cleanup was not established');
    if (!failure) {
      await fs.rm(scratch, { recursive: true });
      receipt.cleanup = true;
      receipt.complete = true;
    }
  } catch (error) { failure ??= error; }
  if (failure) { receipt.error = String(failure.stack ?? failure); receipt.retainedScratch = scratch; }
  await fs.writeFile(path.join(artifacts, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
}
if (failure) throw failure;
assert(receipt.complete, 'Capability inspection proof did not complete');

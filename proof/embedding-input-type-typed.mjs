import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

const source = path.resolve(process.argv[2]);
const artifacts = path.resolve(process.argv[3]);
const head = 'fb00394ef86884e7fd8603eddcbad7aea0320b7a';
const git = (...args) => execFileSync('git', args, { cwd: source, encoding: 'utf8', timeout: 10000 });
assert.equal(git('rev-parse', 'HEAD').trim(), head);
await fs.mkdir(artifacts, { recursive: true });
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'embedding-input-type-typed-'));
const configPath = path.join(scratch, 'openclaw.json');
const texts = ['synthetic-document-alpha', 'synthetic-document-beta'];
const vectors = {
  document: [[0.1, -0.2], [0.3, 0.4]],
  query: [[9, 1], [8, 2]],
};
const { runManagedCommand, hasUnjoinedWork } = await import(pathToFileURL(path.join(source, 'scripts/lib/managed-child-process.mts')).href);
const receipt = { head, boundary: 'real CLI to controlled Voyage HTTP adapter; not vendor live', complete: false, cleanup: false, cases: [] };
const commands = [];
const requests = [];
let activeCase;
let fixtureFailure;
let config;
let failure;
let unjoined = false;
let listening = false;

const server = http.createServer((request, response) => {
  const chunks = [];
  let bytes = 0;
  request.on('error', (error) => { fixtureFailure ??= error; });
  request.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes <= 65536) chunks.push(Buffer.from(chunk));
    else { fixtureFailure ??= new Error('Fixture request budget exceeded'); request.destroy(); }
  });
  request.on('end', () => {
    try {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/embeddings');
      assert(activeCase, 'HTTP request outside an active successful CLI case');
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push({ name: activeCase.name, method: request.method, url: request.url, body });
      assert.equal(body.model, 'voyage-4-large');
      assert.equal(body.input_type, activeCase.kind);
      let data;
      if (activeCase.kind === 'query') {
        assert.equal(body.input.length, 1);
        const index = texts.indexOf(body.input[0]);
        assert(index >= 0, 'Unexpected query text');
        data = [{ index: 0, embedding: vectors.query[index] }];
      } else {
        assert.deepEqual(body.input, texts);
        data = [
          { index: 1, embedding: vectors.document[1] },
          { index: 0, embedding: vectors.document[0] },
        ];
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data }));
    } catch (error) {
      fixtureFailure ??= error;
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'Synthetic fixture request mismatch' }));
    }
  });
});
server.requestTimeout = 5000;
server.on('error', (error) => { fixtureFailure ??= error; });

function environment() {
  const env = {};
  // Keep executable discovery, not ambient OpenClaw configuration or vendor credentials.
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

function start(name, args) {
  const capture = [[], []];
  const abort = new AbortController();
  const started = performance.now();
  const record = { name, bytes: 0, exit: null, settled: false };
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
    record.outcome = outcome;
    return outcome;
  });
  const command = { record, done, abort, async persist() {
    for (const [index, channel] of ['stdout', 'stderr'].entries()) {
      await fs.writeFile(path.join(artifacts, `${name}.${channel}.txt`), Buffer.concat(capture[index]));
    }
    return capture.map((chunks) => Buffer.concat(chunks).toString('utf8'));
  } };
  commands.push(command);
  return command;
}

async function cli(name, args, expectedStatus) {
  const command = start(name, args);
  const result = await command.done;
  const [stdout, stderr] = await command.persist();
  const observed = { name, status: result.status, exit: command.record.exit, bytes: command.record.bytes, wallSeconds: command.record.wallSeconds, verified: false };
  receipt.cases.push(observed);
  if (result.error) { unjoined ||= hasUnjoinedWork(result.error); throw result.error; }
  assert(command.record.bytes <= 4 * 1024 * 1024, `${name}: capture overflow`);
  assert.equal(command.record.exit?.signal, null, `${name}: unexpected signal`);
  assert.equal(command.record.exit?.code, result.status);
  assert.equal(result.status, expectedStatus);
  assert(!fixtureFailure, fixtureFailure?.stack);
  return { stdout, stderr, observed };
}

try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  listening = true;
  const port = server.address().port;
  config = JSON.stringify({
    gateway: { mode: 'local' },
    plugins: { allow: ['voyage'] },
    agents: { entries: { proof: { workspace: path.join(scratch, 'workspace'), agentDir: path.join(scratch, 'agent') } } },
    models: { providers: { voyage: {
      baseUrl: `http://127.0.0.1:${port}/v1`, api: 'openai-completions', models: [],
      headers: { Authorization: 'Bearer synthetic-proof-fixture' },
      request: { allowPrivateNetwork: true },
    } } },
  }, null, 2) + '\n';
  await fs.writeFile(configPath, config);
  await fs.mkdir(path.join(scratch, 'workspace'), { recursive: true });
  await fs.mkdir(path.join(scratch, 'agent'), { recursive: true });
  await fs.writeFile(path.join(artifacts, 'synthetic-config.json'), config);

  const help = await cli('help', ['infer', 'embedding', 'create', '--help'], 0);
  assert(help.stdout.includes('--input-type <type>'));
  assert(help.stdout.includes('document') && help.stdout.includes('query'));
  help.observed.verified = true;
  const inspected = await cli('inspect', ['infer', 'inspect', '--name', 'embedding.create', '--json'], 0);
  const metadata = JSON.parse(inspected.stdout);
  assert.equal(metadata.id, 'embedding.create');
  assert(metadata.flags.includes('--input-type'));
  inspected.observed.verified = true;
  const args = ['infer', 'embedding', 'create', '--agent', 'proof', '--provider', 'voyage', '--model', 'voyage/voyage-4-large', '--text', texts[0], '--text', texts[1], '--json'];
  for (const testCase of [
    { name: 'default-document', kind: 'document', extra: [] },
    { name: 'explicit-document', kind: 'document', extra: ['--input-type', 'document'] },
    { name: 'query', kind: 'query', extra: ['--input-type', 'query'] },
  ]) {
    activeCase = testCase;
    const before = requests.length;
    const result = await cli(testCase.name, [...args, ...testCase.extra], 0);
    activeCase = undefined;
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.capability, 'embedding.create');
    assert.equal(output.transport, 'local');
    assert.equal(output.provider, 'voyage');
    assert.equal(output.model, 'voyage-4-large');
    assert.deepEqual(output.outputs, [
      { text: texts[0], embedding: vectors[testCase.kind][0], dimensions: 2 },
      { text: texts[1], embedding: vectors[testCase.kind][1], dimensions: 2 },
    ]);
    const sent = requests.slice(before);
    if (testCase.kind === 'query') {
      assert.equal(sent.length, 2);
      assert.deepEqual(sent.map((entry) => entry.body.input[0]).sort(), [...texts].sort());
    } else {
      assert.equal(sent.length, 1);
    }
    result.observed.requestCount = sent.length;
    result.observed.verified = true;
  }
  for (const [name, inputType] of [['invalid-input-type', 'semantic'], ['blank-input-type', '']]) {
    const before = requests.length;
    const result = await cli(name, [...args, '--input-type', inputType], 1);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, false);
    assert.equal(output.error.type, 'cli_error');
    assert(output.error.message.includes('--input-type'));
    assert(output.error.message.includes('document') && output.error.message.includes('query'));
    assert(/invalid|allowed choices/i.test(output.error.message));
    assert.equal(requests.length, before, 'Invalid input dispatched an HTTP request');
    result.observed.requestCount = 0;
    result.observed.verified = true;
  }
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
  receipt.allChildrenJoined = commands.every((command) => command.record.settled && command.record.exit !== null && !hasUnjoinedWork(command.record.outcome?.error));
  receipt.unjoinedWork = unjoined;
  if (listening) {
    try {
      const closed = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      server.closeAllConnections();
      await closed;
      assert.equal(server.listening, false);
      receipt.httpServerClosed = true;
    } catch (error) { failure ??= error; }
  }
  failure ??= fixtureFailure;
  try {
    receipt.configUnchanged = config !== undefined && await fs.readFile(configPath, 'utf8') === config;
    receipt.sourceClean = git('status', '--porcelain', '--untracked-files=no') === '';
    assert(receipt.configUnchanged && receipt.sourceClean, 'Config or tracked source changed');
    assert(receipt.allChildrenJoined && !unjoined && receipt.httpServerClosed, 'Strict cleanup was not established');
    if (!failure) {
      await fs.rm(scratch, { recursive: true });
      receipt.cleanup = true;
      receipt.complete = true;
    }
  } catch (error) { failure ??= error; }
  if (failure) { receipt.error = String(failure.stack ?? failure); receipt.retainedScratch = scratch; }
  await fs.writeFile(path.join(artifacts, 'http-requests.json'), JSON.stringify(requests, null, 2) + '\n');
  await fs.writeFile(path.join(artifacts, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
}
if (failure) throw failure;
assert(receipt.complete, 'Proof did not complete');

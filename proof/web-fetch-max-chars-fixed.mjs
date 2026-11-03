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
const head = 'd48c58ba25febdd69c84a458c80544b48a75a515';
const git = (...args) => execFileSync('git', args, { cwd: source, encoding: 'utf8', timeout: 10000 });
assert.equal(git('rev-parse', 'HEAD').trim(), head);
const { runManagedCommand, hasUnjoinedWork } = await import(pathToFileURL(path.join(source, 'scripts/lib/managed-child-process.mts')).href);
await fs.mkdir(artifacts, { recursive: true });
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'web-fetch-max-chars-fixed-'));
const body = ['WEB_FETCH_BASELINE_BEGIN', 'x'.repeat(6000), 'WEB_FETCH_BASELINE_END'].join('\n');
const publicTarget = 'https://example.com/synthetic-max-chars-document';
const providerReply = { success: true, data: { markdown: body, metadata: { sourceURL: publicTarget, statusCode: 200 } } };
const receipt = {
  head, vendorLive: false, complete: false, cleanup: false,
  boundary: 'actual CLI default fetch and bundled Firecrawl against controlled HTTP endpoints', cases: [],
};
const snapshots = new Map();
const commands = [];
const requests = [];
let activeCase;
let listening = false;
let fixtureFailure;
let failure;
let unjoined = false;

function handle(request, response, payload = '') {
  try {
    assert(requests.length < 16, 'Fixture request count exceeded');
    assert(activeCase, 'Unexpected request outside an active HTTP case');
    const entry = { name: activeCase.name, method: request.method, url: request.url };
    requests.push(entry);
    if (activeCase.kind === 'direct') {
      assert.equal(request.method, 'GET');
      assert.equal(request.url, '/document');
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(body);
    } else {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v2/scrape');
      entry.body = JSON.parse(payload);
      assert.equal(entry.body.url, publicTarget);
      assert.deepEqual(entry.body.formats, ['markdown']);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(providerReply));
    }
  } catch (error) {
    fixtureFailure ??= error;
    response.writeHead(500, { 'content-type': 'text/plain' });
    response.end('Synthetic fixture request mismatch');
  }
}

const server = http.createServer((request, response) => {
  if (request.method !== 'POST') {
    handle(request, response);
    return;
  }
  const chunks = [];
  let bytes = 0;
  request.on('error', (error) => { fixtureFailure ??= error; });
  request.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes <= 65536) chunks.push(Buffer.from(chunk));
    else { fixtureFailure ??= new Error('Fixture request body budget exceeded'); request.destroy(); }
  });
  request.on('end', () => handle(request, response, Buffer.concat(chunks).toString('utf8')));
});
server.requestTimeout = 5000;
server.on('error', (error) => { fixtureFailure ??= error; });

async function writeConfig(name, value) {
  const filename = path.join(scratch, name);
  const bytes = JSON.stringify(value, null, 2) + '\n';
  await fs.writeFile(filename, bytes);
  snapshots.set(filename, bytes);
  await fs.writeFile(path.join(artifacts, name), bytes);
  return filename;
}

function environment(configPath) {
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

function start(name, args, configPath) {
  const capture = [[], []];
  const abort = new AbortController();
  const started = performance.now();
  const record = { name, bytes: 0, exit: null, settled: false };
  const done = runManagedCommand({
    bin: 'pnpm', args: ['--silent', 'openclaw', ...args], cwd: source, env: environment(configPath),
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

async function cli(name, args, configPath, expectedStatus) {
  const command = start(name, args, configPath);
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

function resultFrom(stdout, provider) {
  const envelope = JSON.parse(stdout);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.capability, 'web.fetch');
  assert.equal(envelope.transport, 'local');
  assert.equal(envelope.provider, provider);
  assert.equal(envelope.outputs.length, 1);
  const result = envelope.outputs[0].result;
  assert.equal(result.status, 200);
  assert.equal(result.rawLength, body.length);
  assert.equal(result.truncated, true);
  assert.equal(result.length, result.text.length);
  return result;
}

try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  listening = true;
  const origin = `http://127.0.0.1:${server.address().port}`;
  const url = `${origin}/document`;
  const fetchConfig = {
    enabled: true, maxChars: 1600, maxCharsCap: 2000, cacheTtlMinutes: 0,
    ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
  };
  const defaultConfig = await writeConfig('default-config.json', {
    gateway: { mode: 'local' }, plugins: { allow: [] }, tools: { web: { fetch: fetchConfig } },
  });
  const pinnedConfig = await writeConfig('firecrawl-config.json', {
    gateway: { mode: 'local' },
    plugins: { allow: ['firecrawl'], entries: { firecrawl: { enabled: true, config: { webFetch: { baseUrl: origin } } } } },
    tools: { web: { fetch: fetchConfig } },
  });
  await fs.writeFile(path.join(artifacts, 'fixture-body.txt'), body);
  await fs.writeFile(path.join(artifacts, 'firecrawl-response.json'), JSON.stringify(providerReply, null, 2) + '\n');

  const help = await cli('help', ['infer', 'web', 'fetch', '--help'], defaultConfig, 0);
  assert(help.stdout.includes('--max-chars <n>'));
  assert(help.stdout.includes('100'));
  assert.equal(requests.length, 0);
  help.observed.verified = true;
  const common = ['infer', 'web', 'fetch', '--url', url, '--format', 'text', '--json'];
  for (const testCase of [
    { name: 'default-1600', kind: 'direct', budget: 1600, extra: [] },
    { name: 'minimum-100', kind: 'direct', budget: 100, extra: ['--max-chars', '100'] },
    { name: 'requested-512', kind: 'direct', budget: 512, extra: ['--max-chars', '512'] },
    { name: 'cap-2000', kind: 'direct', budget: 2000, extra: ['--max-chars', '5000'] },
  ]) {
    activeCase = testCase;
    const before = requests.length;
    const fetched = await cli(testCase.name, [...common, ...testCase.extra], defaultConfig, 0);
    activeCase = undefined;
    const result = resultFrom(fetched.stdout, 'direct');
    assert.equal(result.url, url);
    assert.equal(result.extractMode, 'text');
    assert(result.length > 0 && result.length <= testCase.budget);
    if (testCase.budget >= 512) assert(result.text.includes('WEB_FETCH_BASELINE_BEGIN'));
    assert(!result.text.includes('WEB_FETCH_BASELINE_END'));
    assert.equal(result.spill.chars, body.length);
    const relativeSpill = path.relative(scratch, result.spill.path);
    assert(relativeSpill && !relativeSpill.startsWith('..') && !path.isAbsolute(relativeSpill), 'Spill escaped synthetic TMPDIR');
    const spill = await fs.readFile(result.spill.path, 'utf8');
    assert(spill.includes(body), 'Private overflow file did not retain the synthetic response');
    await fs.writeFile(path.join(artifacts, `${testCase.name}.spill.txt`), spill);
    assert.equal(requests.length - before, 1);
    fetched.observed.verified = true;
    fetched.observed.budget = testCase.budget;
    fetched.observed.returnedChars = result.length;
    fetched.observed.spillChars = result.spill.chars;
  }
  for (const [name, value] of [['blank', ''], ['zero', '0'], ['below-minimum', '99']]) {
    const before = requests.length;
    const rejected = await cli(name, [...common, '--max-chars', value], defaultConfig, 1);
    const output = JSON.parse(rejected.stdout);
    assert.equal(output.ok, false);
    assert.equal(output.error.type, 'cli_error');
    assert(output.error.message.includes('--max-chars'));
    assert(value === '99' ? /at least 100/i.test(output.error.message) : /positive integer/i.test(output.error.message));
    assert.equal(requests.length, before);
    rejected.observed.verified = true;
    rejected.observed.requestCount = 0;
  }
  for (const testCase of [
    { name: 'firecrawl-512', kind: 'firecrawl', requested: '512', rawBudget: 512 },
    { name: 'firecrawl-cap-2000', kind: 'firecrawl', requested: '5000', rawBudget: 2000 },
  ]) {
    activeCase = testCase;
    const before = requests.length;
    const fetched = await cli(testCase.name, [
      'infer', 'web', 'fetch', '--url', publicTarget, '--provider', 'firecrawl',
      '--format', 'markdown', '--max-chars', testCase.requested, '--json',
    ], pinnedConfig, 0);
    activeCase = undefined;
    const result = resultFrom(fetched.stdout, 'firecrawl');
    assert.equal(result.url, publicTarget);
    assert.equal(result.extractMode, 'markdown');
    assert(result.text.includes(body.slice(0, testCase.rawBudget)));
    assert(!result.text.includes(body.slice(0, testCase.rawBudget + 1)));
    assert(result.text.length > testCase.rawBudget, 'Provider framing must remain outside its existing raw-content budget');
    assert.equal(requests.length - before, 1);
    fetched.observed.verified = true;
    fetched.observed.rawContentBudget = testCase.rawBudget;
    fetched.observed.returnedChars = result.length;
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
    receipt.configUnchanged = true;
    for (const [filename, expected] of snapshots) {
      if (await fs.readFile(filename, 'utf8') !== expected) receipt.configUnchanged = false;
    }
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
assert(receipt.complete, 'Fixed runtime proof did not complete');

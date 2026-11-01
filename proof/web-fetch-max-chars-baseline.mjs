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
const head = '39629c6aa82ce444f14c37fc1d4d47e5c7f661d0';
const git = (...args) => execFileSync('git', args, { cwd: source, encoding: 'utf8', timeout: 10000 });
assert.equal(git('rev-parse', 'HEAD').trim(), head);
const { runManagedCommand, hasUnjoinedWork } = await import(pathToFileURL(path.join(source, 'scripts/lib/managed-child-process.mts')).href);
await fs.mkdir(artifacts, { recursive: true });
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'web-fetch-max-chars-baseline-'));
const configPath = path.join(scratch, 'openclaw.json');
const body = ['WEB_FETCH_BASELINE_BEGIN', 'x'.repeat(6000), 'WEB_FETCH_BASELINE_END'].join('\n');
const receipt = {
  head, diagnosticOnly: true, complete: false, cleanup: false,
  boundary: 'actual CLI to controlled HTTP endpoint; no vendor API', cases: [],
};
const commands = [];
const requests = [];
let allowHttp = false;
let listening = false;
let config;
let fixtureFailure;
let failure;
let unjoined = false;

const server = http.createServer((request, response) => {
  try {
    assert(requests.length < 4, 'Fixture request count exceeded');
    requests.push({ method: request.method, url: request.url });
    assert(allowHttp, 'Unexpected HTTP request outside the existing-fetch control');
    assert.equal(request.method, 'GET');
    assert.equal(request.url, '/document');
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    response.end(body);
  } catch (error) {
    fixtureFailure ??= error;
    response.writeHead(500, { 'content-type': 'text/plain' });
    response.end('Synthetic fixture request mismatch');
  }
});
server.requestTimeout = 5000;
server.on('error', (error) => { fixtureFailure ??= error; });

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
  const url = `http://127.0.0.1:${server.address().port}/document`;
  config = JSON.stringify({
    gateway: { mode: 'local' },
    plugins: { allow: [] },
    tools: { web: { fetch: {
      enabled: true, maxChars: 1600, maxCharsCap: 2000, cacheTtlMinutes: 0,
      ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
    } } },
  }, null, 2) + '\n';
  await fs.writeFile(configPath, config);
  await fs.writeFile(path.join(artifacts, 'synthetic-config.json'), config);
  await fs.writeFile(path.join(artifacts, 'fixture-body.txt'), body);

  const help = await cli('help-control', ['infer', 'web', 'fetch', '--help'], 0);
  assert(help.stdout.includes('--url <url>'));
  assert(!help.stdout.includes('--max-chars'));
  assert.equal(requests.length, 0);
  help.observed.verified = true;
  help.observed.verdict = 'existing-help-control';

  const absent = await cli('max-chars-absent', ['infer', 'web', 'fetch', '--url', url, '--max-chars', '512', '--json'], 1);
  const rejected = JSON.parse(absent.stdout);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.type, 'cli_error');
  assert(rejected.error.message.includes('--max-chars'));
  assert(/(?:unknown|unrecognized|does not recognize) option/i.test(rejected.error.message));
  assert.equal(requests.length, 0);
  absent.observed.verified = true;
  absent.observed.verdict = 'feature-absent';

  allowHttp = true;
  const fetched = await cli('existing-default-http', ['infer', 'web', 'fetch', '--url', url, '--format', 'text', '--json'], 0);
  allowHttp = false;
  const envelope = JSON.parse(fetched.stdout);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.capability, 'web.fetch');
  assert.equal(envelope.transport, 'local');
  assert.equal(envelope.provider, 'direct');
  assert.equal(envelope.outputs.length, 1);
  const result = envelope.outputs[0].result;
  assert.equal(result.status, 200);
  assert.equal(result.url, url);
  assert.equal(result.extractMode, 'text');
  assert.equal(result.rawLength, body.length);
  assert.equal(result.truncated, true);
  assert.equal(result.length, result.text.length);
  assert(result.length > 0 && result.length <= 1600);
  assert(result.text.includes('WEB_FETCH_BASELINE_BEGIN'));
  assert(!result.text.includes('WEB_FETCH_BASELINE_END'));
  assert.equal(result.spill.chars, body.length);
  const relativeSpill = path.relative(scratch, result.spill.path);
  assert(relativeSpill && !relativeSpill.startsWith('..') && !path.isAbsolute(relativeSpill), 'Spill escaped synthetic TMPDIR');
  const spill = await fs.readFile(result.spill.path, 'utf8');
  assert(spill.includes(body), 'Private overflow file did not retain the synthetic response');
  await fs.writeFile(path.join(artifacts, 'existing-default.spill.txt'), spill);
  assert.equal(requests.length, 1);
  fetched.observed.verified = true;
  fetched.observed.verdict = 'existing-http-control-pass';
  fetched.observed.returnedChars = result.length;
  fetched.observed.rawChars = result.rawLength;
  fetched.observed.spillChars = result.spill.chars;
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
assert(receipt.complete, 'Baseline diagnostic did not complete');

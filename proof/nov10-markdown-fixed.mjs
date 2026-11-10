import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

// Source-only preparation. Run remotely only after the lead reviews this file.
const source = path.resolve(process.argv[2]);
const artifacts = path.resolve(process.argv[3]);
const head = '17a59bfc0922e68a628948ead8e6d06b8f0a65f3';
const git = (...args) => execFileSync('git', args, {
  cwd: source, encoding: 'utf8', timeout: 10000,
  env: { ...process.env, GIT_NO_LAZY_FETCH: '1' },
});
assert.equal(git('rev-parse', 'HEAD').trim(), head);
assert.equal(git('status', '--porcelain', '--untracked-files=no'), '');
const { runManagedCommand, hasUnjoinedWork } = await import(
  pathToFileURL(path.join(source, 'scripts/lib/managed-child-process.mts')).href
);
await fs.mkdir(artifacts, { recursive: true });
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'nov10-markdown-fixed-'));
const configPath = path.join(scratch, 'openclaw.json');
const token = 'synthetic-markdown-baseline-token';
const cases = [
  { name: 'double-emphasis', input: 'Keep ``a*b*`` literally.', baseline: 'Keep ab literally.', desired: 'Keep a*b* literally.', defect: true },
  { name: 'double-link', input: 'Show ``[x](y)`` literally.', baseline: 'Show x literally.', desired: 'Show [x](y) literally.', defect: true },
  { name: 'single-code', input: 'Keep `a*b*` and `[x](y)` literally.', baseline: 'Keep a*b* and [x](y) literally.' },
  { name: 'ordinary-markdown', input: '## Summary\nPlain **bold**, _italic_, ~~gone~~ and [docs](https://example.com).', baseline: 'Summary Plain bold, italic, gone and docs.' },
  { name: 'destination-backticks', input: 'Read [notes](https://example.com/`v1`/notes) now.', baseline: 'Read notes now.' },
  { name: 'completed-fences', input: 'Before\n````js\n**hidden**\n````\n~~~text\n[hidden](url)\n~~~\nAfter', baseline: 'Before After' },
  { name: 'nul-literal', input: 'Keep\0`a\0*b*` now.', baseline: 'Keep\0a\0*b* now.' },
];
const commands = [];
const receipt = {
  head, stage: 'fixed', diagnosticOnly: false, complete: false, cleanup: false,
  boundary: 'built CLI -> authenticated loopback Gateway -> sessions.create/chat.inject -> sessions.list(includeLastMessage)/chat.history',
  limitation: 'Synthetic operator-injected assistant messages; no model turn, UI rendering, external provider or channel delivery claim.',
  cases: [],
};
let gateway;
let port;
let configBytes;
let failure;
let unjoined = false;

function environment() {
  const inherited = {};
  for (const key of ['PATH', 'PNPM_HOME', 'COREPACK_HOME', 'LANG', 'LC_ALL', 'TZ', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT']) {
    if (process.env[key] !== undefined) inherited[key] = process.env[key];
  }
  return {
    ...inherited, HOME: scratch, USERPROFILE: scratch, CI: 'true', NO_COLOR: '1',
    XDG_CONFIG_HOME: path.join(scratch, 'xdg-config'), XDG_CACHE_HOME: path.join(scratch, 'xdg-cache'),
    XDG_DATA_HOME: path.join(scratch, 'xdg-data'), TMPDIR: scratch, TMP: scratch, TEMP: scratch,
    OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_STATE_DIR: path.join(scratch, 'state'),
  };
}

function start(name, args, timeoutMs) {
  const capture = [[], []];
  const abort = new AbortController();
  const record = { name, bytes: 0, exit: null, settled: false };
  const started = performance.now();
  const done = runManagedCommand({
    bin: 'pnpm', args: ['--silent', 'openclaw', ...args], cwd: source, env: environment(),
    stdio: ['ignore', 'pipe', 'pipe'], timeoutMs, signal: abort.signal,
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

async function rpc(name, method, params) {
  const command = start(name, [
    'gateway', 'call', method, '--url', `ws://127.0.0.1:${port}`, '--token', token,
    '--params', JSON.stringify(params), '--timeout', '30000', '--json',
  ], 90000);
  const outcome = await command.done;
  const [stdout] = await command.persist();
  if (outcome.error) { unjoined ||= hasUnjoinedWork(outcome.error); throw outcome.error; }
  assert.equal(outcome.status, 0, `${name}: CLI failed; see raw stdout/stderr`);
  assert.deepEqual(command.record.exit, { code: 0, signal: null });
  assert(command.record.bytes <= 8 * 1024 * 1024, `${name}: capture overflow`);
  return JSON.parse(stdout);
}

async function reservePort() {
  const lease = net.createServer();
  await new Promise((resolve, reject) => {
    lease.once('error', reject);
    lease.listen(0, '127.0.0.1', resolve);
  });
  const reserved = lease.address().port;
  await new Promise((resolve, reject) => lease.close((error) => error ? reject(error) : resolve()));
  assert.equal(lease.listening, false);
  receipt.portReservationClosed = true;
  return reserved;
}

async function isPortOpen() {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.setTimeout(1000, () => { socket.destroy(); reject(new Error('Listener probe timed out')); });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', (error) => { socket.destroy(); error.code === 'ECONNREFUSED' ? resolve(false) : reject(error); });
  });
}

function messageText(message) {
  assert(Array.isArray(message.content), 'History message did not have content blocks');
  return message.content.filter((part) => part.type === 'text').map((part) => part.text).join('');
}

try {
  port = await reservePort();
  configBytes = JSON.stringify({
    gateway: { mode: 'local', bind: 'loopback', port, auth: { mode: 'token', token }, controlUi: { enabled: false } },
    agents: { defaults: { workspace: path.join(scratch, 'workspace') }, entries: { main: {} } },
    plugins: { allow: [] },
  }, null, 2) + '\n';
  await fs.writeFile(configPath, configBytes);
  await fs.writeFile(path.join(artifacts, 'synthetic-config.json'), configBytes);
  await fs.writeFile(path.join(artifacts, 'cases.json'), JSON.stringify(cases, null, 2) + '\n');
  gateway = start('gateway', ['gateway', 'run', '--bind', 'loopback', '--port', String(port), '--token', token], 900000);
  const deadline = Date.now() + 240000;
  let ready = false;
  while (Date.now() < deadline && !ready) {
    assert(!gateway.record.settled, 'Gateway exited before startup');
    try {
      const response = await fetch(`http://127.0.0.1:${port}/startup`, { signal: AbortSignal.timeout(2000) });
      const startup = await response.json();
      ready = response.ok && startup.ok === true && startup.status === 'started';
      if (ready) receipt.startup = startup;
    } catch { /* The bounded startup poll waits only for this isolated process. */ }
    if (!ready) await delay(100);
  }
  assert(ready, 'Gateway did not complete startup within 240 seconds');
  receipt.gatewayReady = true;
  const created = await rpc('create-session', 'sessions.create', { label: 'nov10-markdown-fixed' });
  assert.equal(created.ok, true);
  assert.equal(typeof created.key, 'string');
  assert.equal(created.runStarted, false, 'Session creation unexpectedly started a model turn');
  assert.equal(created.runError, undefined, 'Session creation reported an error');
  const sessionKey = created.key;
  receipt.sessionKey = sessionKey;
  for (const fixture of cases) {
    const expectedFixed = fixture.desired ?? fixture.baseline;
    const injected = await rpc(`${fixture.name}-inject`, 'chat.inject', { sessionKey, message: fixture.input });
    assert.equal(injected.ok, true);
    assert.equal(typeof injected.messageId, 'string');
    const listed = await rpc(`${fixture.name}-list`, 'sessions.list', {
      includeLastMessage: true, includeGlobal: true, includeUnknown: true, limit: 20,
    });
    assert(Array.isArray(listed.sessions), 'sessions.list did not return sessions');
    const row = listed.sessions.find((entry) => entry.key === sessionKey);
    assert(row, 'Created session absent from sessions.list');
    const history = await rpc(`${fixture.name}-history`, 'chat.history', { sessionKey, limit: 20 });
    assert(Array.isArray(history.messages), 'chat.history did not return messages');
    const last = history.messages.filter((entry) => entry.role === 'assistant').at(-1);
    assert(last, 'Injected assistant message absent from chat.history');
    const raw = messageText(last);
    const observation = {
      name: fixture.name, input: fixture.input, expectedBaseline: fixture.baseline, expectedFixed,
      expectedDesired: fixture.desired ?? fixture.baseline, actualPreview: row.lastMessagePreview,
      historyText: raw, fixedMatches: row.lastMessagePreview === expectedFixed,
      historyPreserved: raw === fixture.input, defect: fixture.defect ?? false,
    };
    receipt.cases.push(observation);
    console.log(JSON.stringify(observation));
    assert.equal(raw, fixture.input, `${fixture.name}: stored history changed`);
    assert.equal(row.lastMessagePreview, expectedFixed, `${fixture.name}: fixed preview mismatch`);
    if (fixture.defect) assert.notEqual(row.lastMessagePreview, fixture.baseline, `${fixture.name}: baseline defect remains`);
  }
  assert.equal(receipt.cases.filter((entry) => entry.defect && entry.fixedMatches && entry.historyPreserved).length, 2);
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
    name: record.name, bytes: record.bytes, exit: record.exit,
    settled: record.settled, status: record.outcome?.status, wallSeconds: record.wallSeconds,
    error: record.outcome?.error ? String(record.outcome.error) : undefined,
  }));
  receipt.allChildrenJoined = commands.every(({ record }) => record.settled && record.exit !== null && !hasUnjoinedWork(record.outcome?.error));
  receipt.unjoinedWork = unjoined;
  try {
    receipt.gatewayPortClosed = port !== undefined && !(await isPortOpen());
    receipt.configUnchanged = configBytes !== undefined && await fs.readFile(configPath, 'utf8') === configBytes;
    receipt.sourceClean = git('status', '--porcelain', '--untracked-files=no') === '';
    assert(receipt.allChildrenJoined && !unjoined && receipt.portReservationClosed && receipt.gatewayPortClosed, 'Strict process/server cleanup was not established');
    assert(receipt.configUnchanged && receipt.sourceClean, 'Config or tracked source changed');
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
assert(receipt.complete, 'Fixed proof did not complete');

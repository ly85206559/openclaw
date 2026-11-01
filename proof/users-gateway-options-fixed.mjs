import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const source = path.resolve(process.argv[2]);
const artifacts = path.resolve(process.argv[3]);
const head = 'eff4c0869e2e9487fa02120eb6b9e981a6f1e7b2';
const git = (...args) => execFileSync('git', args, { cwd: source, encoding: 'utf8', timeout: 10000 });
assert.equal(git('rev-parse', 'HEAD').trim(), head);
await fs.mkdir(artifacts, { recursive: true });
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'users-options-fixed-'));
const password = 'synthetic-users-options-password';
const wrongPassword = 'synthetic-wrong-users-options-password';
const redact = (text) => text.replaceAll(password, '[fixture-password]').replaceAll(wrongPassword, '[wrong-fixture-password]');
const { runManagedCommand, hasUnjoinedWork } = await import(pathToFileURL(path.join(source, 'scripts/lib/managed-child-process.mts')).href);
const receipt = { head, complete: false, cleanup: false, cases: [] };
const snapshots = new Map();
let gateway;
let port;
let failure;
let unjoined = false;

async function writeConfig(name, value) {
  const filename = path.join(scratch, name);
  const bytes = JSON.stringify(value, null, 2) + '\n';
  await fs.writeFile(filename, bytes);
  snapshots.set(filename, bytes);
  await fs.writeFile(path.join(artifacts, name), redact(bytes));
  return filename;
}

function environment(name, config) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('OPENCLAW_') || /^(ANTHROPIC|OPENAI|GEMINI|GOOGLE|AZURE|AWS)_/.test(key)) delete env[key];
  }
  return { ...env, HOME: scratch, USERPROFILE: scratch, OPENCLAW_CONFIG_PATH: config,
    OPENCLAW_STATE_DIR: path.join(scratch, `${name}-state`), NO_COLOR: '1' };
}

function start(name, args, env, timeoutMs) {
  const capture = [[], []];
  const abort = new AbortController();
  const record = { name, bytes: 0, exit: null, settled: false };
  const done = runManagedCommand({
    bin: 'pnpm', args: ['--silent', 'openclaw', ...args], cwd: source, env,
    stdio: ['ignore', 'pipe', 'pipe'], timeoutMs, signal: abort.signal,
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
    record.outcome = outcome;
    return outcome;
  });
  return { record, done, abort, async persist() {
    for (const [index, channel] of ['stdout', 'stderr'].entries()) {
      await fs.writeFile(path.join(artifacts, `${name}.${channel}.txt`), redact(Buffer.concat(capture[index]).toString('utf8')));
    }
    assert(record.bytes <= 4 * 1024 * 1024, `${name}: capture overflow`);
    return capture.map((chunks) => Buffer.concat(chunks).toString('utf8'));
  } };
}

async function cli(name, args, env) {
  const command = start(name, args, env, 180000);
  const result = await command.done;
  const [stdout, stderr] = await command.persist();
  if (result.error) { unjoined ||= hasUnjoinedWork(result.error); throw result.error; }
  assert.equal(command.record.exit?.signal, null, `${name}: unexpected signal`);
  assert.equal(command.record.exit?.code, result.status);
  receipt.cases.push({ name, status: result.status, exit: command.record.exit, strictTreeJoined: true });
  return { ...result, stdout, stderr };
}

async function portOpen(value) {
  return await new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port: value });
    const finish = (open) => { socket.destroy(); resolve(open); };
    socket.setTimeout(1000, () => { socket.destroy(); reject(new Error('Listener closure probe timed out')); });
    socket.once('connect', () => finish(true));
    socket.once('error', (error) => {
      if (error.code === 'ECONNREFUSED') finish(false);
      else { socket.destroy(); reject(error); }
    });
  });
}

try {
  const reservation = net.createServer();
  await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
  port = reservation.address().port;
  await new Promise((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
  const serverConfig = await writeConfig('server-config.json', {
    gateway: { mode: 'local', bind: 'loopback', port, auth: { mode: 'password', password }, controlUi: { enabled: false } },
    plugins: { allow: [] }, agents: { defaults: { workspace: path.join(scratch, 'workspace') } },
  });
  const clientConfig = await writeConfig('client-config.json', {
    gateway: { mode: 'local', port: 1, auth: { mode: 'password', password: wrongPassword } }, plugins: { allow: [] },
  });
  gateway = start('gateway', ['gateway', 'run', '--bind', 'loopback', '--port', String(port), '--password', password], environment('server', serverConfig), 600000);
  const deadline = Date.now() + 240000;
  let ready = false;
  while (Date.now() < deadline && !gateway.record.settled) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/startup`, { signal: AbortSignal.timeout(2000) });
      if (response.ok && (await response.json()).status === 'started') { ready = true; break; }
    } catch { /* Startup has not opened the listener yet. */ }
    await delay(250);
  }
  assert(ready, 'Gateway did not reach canonical started readiness');
  receipt.gatewayReady = true;
  const env = environment('client', clientConfig);
  const common = ['users', 'list', '--port', String(port), '--password', password, '--timeout', '15000'];
  const json = await cli('list-json', [...common, '--json'], env);
  assert.equal(json.status, 0);
  const profiles = JSON.parse(json.stdout);
  assert(Array.isArray(profiles.profiles) && profiles.profiles.length > 0);
  const owner = profiles.profiles.find((profile) => profile.id === 'gateway-owner');
  assert(owner, 'Real Gateway owner profile missing');
  const text = await cli('list-text', common, env);
  assert.equal(text.status, 0);
  assert(text.stdout.includes(owner.id));
  assert(!text.stdout.includes('No user profiles found.'));
  const wrong = await cli('wrong-password', ['users', 'list', '--port', String(port), '--password', wrongPassword, '--timeout', '15000', '--json'], env);
  assert.notEqual(wrong.status, 0);
  assert(!Array.isArray(JSON.parse(wrong.stdout).profiles));
  assert(/auth|password|unauthorized/i.test(wrong.stdout + wrong.stderr), 'Wrong password must fail authentication');
  const wrongPort = await cli('wrong-config-port', ['users', 'list', '--password', password, '--timeout', '2000', '--json'], env);
  assert.notEqual(wrongPort.status, 0);
  assert(!Array.isArray(JSON.parse(wrongPort.stdout).profiles));
  assert(/127\.0\.0\.1:1\b/.test(wrongPort.stdout + wrongPort.stderr), 'No-port control must target the configured wrong port');
} catch (error) {
  failure = error;
  unjoined ||= hasUnjoinedWork(error);
} finally {
  if (gateway) {
    const cancelled = !gateway.record.settled;
    if (cancelled) gateway.abort.abort();
    const outcome = await gateway.done;
    try {
      await gateway.persist();
      unjoined ||= hasUnjoinedWork(outcome.error);
      assert(cancelled && outcome.error?.code === 'ABORT_ERR' && !hasUnjoinedWork(outcome.error), 'Gateway cancellation did not establish strict cleanup');
      assert(gateway.record.exit !== null, 'Gateway exit not observed');
      receipt.gatewayExit = gateway.record.exit;
      receipt.gatewayStrictTreeJoined = true;
      assert.equal(await portOpen(port), false, 'Gateway listener remained open');
      receipt.gatewayPortClosed = true;
    } catch (error) { failure ??= error; }
  }
  try {
    receipt.configUnchanged = true;
    for (const [filename, expected] of snapshots) {
      if (await fs.readFile(filename, 'utf8') !== expected) receipt.configUnchanged = false;
    }
    receipt.sourceClean = git('status', '--porcelain', '--untracked-files=no') === '';
    assert(receipt.configUnchanged && receipt.sourceClean, 'Config or tracked source changed');
    if (!failure && !unjoined && receipt.gatewayStrictTreeJoined && receipt.gatewayPortClosed) {
      await fs.rm(scratch, { recursive: true });
      receipt.cleanup = true;
      receipt.complete = true;
    }
  } catch (error) { failure ??= error; }
  if (failure) { receipt.error = redact(String(failure.stack ?? failure)); receipt.retainedScratch = scratch; }
  receipt.unjoinedWork = unjoined;
  await fs.writeFile(path.join(artifacts, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
}
if (failure) throw new Error(redact(String(failure.stack ?? failure)));
assert(receipt.complete, 'Proof did not complete');

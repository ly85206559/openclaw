import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const source = path.resolve(process.argv[2]);
const artifacts = path.resolve(process.argv[3]);
await fs.mkdir(artifacts, { recursive: true });
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'diffs-patch-proof-'));
const state = path.join(scratch, 'state');
const configPath = path.join(state, 'openclaw.json');
const token = randomBytes(32).toString('hex');
const phase = process.env.PROOF_PHASE ?? 'baseline';
const receipt = { phase, head: process.env.SOURCE_HEAD, complete: false, cleanup: false, cases: [] };
const redact = (text) => String(text).replaceAll(token, '<fixture-token>')
  .replace(/(\/plugins\/diffs\/view\/)[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+/g, '$1<artifact>/<token>');
let gateway;
let port;
let stdout = '';
let stderr = '';
let gatewayExit;
let failure;

function gatewayGroupAlive() {
  if (!gateway?.pid) return false;
  try { process.kill(-gateway.pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

async function waitForGatewayGroup(timeoutMs) {
  const started = Date.now();
  while (gatewayGroupAlive() && Date.now() - started < timeoutMs) await delay(100);
  assert.equal(gatewayGroupAlive(), false, 'Gateway process group survived shutdown');
}

async function claimPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  const value = address.port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return value;
}

async function request(route, body) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  return { status: response.status, text: await response.text() };
}

async function invokeViewer(name, args) {
  const invoked = await request('/tools/invoke', { tool: 'diffs', args: { ...args, mode: 'view' } });
  await fs.writeFile(path.join(artifacts, `${name}-response.json`), redact(invoked.text));
  assert.equal(invoked.status, 200, `${name}: actual tool invocation failed`);
  const body = JSON.parse(invoked.text);
  assert.equal(body.ok, true);
  assert.equal(body.result.details.changed, true);
  const viewerPath = body.result.details.viewerPath;
  assert.equal(typeof viewerPath, 'string');
  assert(viewerPath.startsWith('/plugins/diffs/view/'));
  const viewer = await request(viewerPath);
  assert.equal(viewer.status, 200, `${name}: viewer unavailable`);
  await fs.writeFile(path.join(artifacts, `${name}-viewer.html`), redact(viewer.text));
  const matches = [...viewer.text.matchAll(/<script type="application\/json" data-openclaw-diff-payload>([\s\S]*?)<\/script>/g)];
  assert.equal(matches.length, 1, 'one real served diff payload required');
  return JSON.parse(matches[0][1]);
}

try {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' });
  assert.equal(head.status, 0);
  assert.equal(head.stdout.trim(), process.env.SOURCE_HEAD);
  port = await claimPort();
  await fs.mkdir(state, { recursive: true });
  const config = {
    gateway: { mode: 'local', bind: 'loopback', port, auth: { mode: 'token', token } },
    agents: { defaults: { workspace: path.join(scratch, 'workspace') } },
    plugins: {
      allow: ['diffs'],
      load: { paths: [path.join(source, 'extensions', 'diffs')] },
      entries: { diffs: { enabled: true } },
    },
    tools: { alsoAllow: ['diffs'] },
  };
  const authoredConfig = `${JSON.stringify(config, null, 2)}\n`;
  await fs.writeFile(configPath, authoredConfig, { mode: 0o600 });
  gateway = spawn('pnpm', ['--silent', 'openclaw', 'gateway', 'run', '--allow-unconfigured'], {
    cwd: source,
    env: { ...process.env, HOME: scratch, OPENCLAW_STATE_DIR: state, OPENCLAW_CONFIG_PATH: configPath },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  gateway.stdout.on('data', (data) => { stdout = (stdout + data).slice(-5_000_000); });
  gateway.stderr.on('data', (data) => { stderr = (stderr + data).slice(-5_000_000); });
  gateway.on('error', (error) => { gatewayExit = { error: error.message }; });
  gateway.on('exit', (code, signal) => { gatewayExit = { code, signal }; });
  const started = Date.now();
  while (true) {
    assert.equal(gatewayExit, undefined, 'Gateway exited during startup');
    assert(Date.now() - started < 180_000, 'Gateway readiness not observed within bounded startup');
    try {
      const startup = await request('/startup');
      if (startup.status === 200) {
        assert.equal(JSON.parse(startup.text).status, 'started');
        break;
      }
    } catch (error) {
      if (!(error instanceof TypeError) || error.message !== 'fetch failed') throw error;
    }
    await delay(250);
  }
  receipt.gatewayReady = true;
  const control = await invokeViewer('before-after-control', {
    before: 'old\n', after: 'new  \n', path: 'sample.txt',
  });
  assert.equal(control.newFile.contents, 'new  \n');
  assert.equal(control.oldFile.contents, 'old\n');
  receipt.cases.push({ name: 'before-after-control', productVerdict: 'pass', contents: control.newFile.contents });
  const patch = '--- a/sample.txt\n+++ b/sample.txt\n@@ -1 +1 @@\n-old\n+new  \n';
  const changed = await invokeViewer('patch', { patch });
  const actual = changed.fileDiff.additionLines;
  const expected = ['new  \n'];
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  receipt.cases.push({ name: 'patch', productVerdict: pass ? 'pass' : 'fail', actual, expected });
  assert.deepEqual(changed.fileDiff.deletionLines, ['old\n']);
  if (phase === 'baseline') {
    assert.deepEqual(actual, ['new'], 'only the exact trimming defect qualifies as baseline reproduction');
    assert.equal(pass, false);
    receipt.productVerdict = 'fail';
  } else {
    assert.deepEqual(actual, expected);
    receipt.productVerdict = 'pass';
  }
  assert.equal(await fs.readFile(configPath, 'utf8'), authoredConfig, 'authored config changed');
  receipt.configUnchanged = true;
  const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: source, encoding: 'utf8' });
  assert.equal(status.status, 0);
  assert.equal(status.stdout, '', 'tracked source changed');
  receipt.sourceClean = true;
  receipt.complete = true;
} catch (error) {
  failure = error;
  receipt.error = redact(error.stack ?? error);
} finally {
  try {
    if (gatewayGroupAlive()) {
      process.kill(-gateway.pid, 'SIGTERM');
      await waitForGatewayGroup(30_000);
    }
  } catch (error) {
    receipt.shutdownError = redact(error.stack ?? error);
    failure ??= error;
  }
  try {
    if (gatewayGroupAlive()) {
      process.kill(-gateway.pid, 'SIGKILL');
      await waitForGatewayGroup(5000);
    }
    await fs.rm(scratch, { recursive: true });
    await assert.rejects(fs.stat(scratch), { code: 'ENOENT' });
    if (port) await assert.rejects(fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) }));
    receipt.cleanup = true;
  } catch (error) {
    receipt.cleanupError = redact(error.stack ?? error);
    failure ??= error;
  }
  if (failure) receipt.complete = false;
  receipt.gatewayExit = gatewayExit;
  await fs.writeFile(path.join(artifacts, 'gateway.stdout.txt'), redact(stdout));
  await fs.writeFile(path.join(artifacts, 'gateway.stderr.txt'), redact(stderr));
  await fs.writeFile(path.join(artifacts, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
}
if (failure) throw new Error(redact(failure.stack ?? failure));
console.log(JSON.stringify(receipt));

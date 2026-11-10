import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HEAD = '40c3b508ba130cb9244f077015321b4fa4e91965';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yf7kAAAAASUVORK5CYII=', 'base64');
const PROMPT = 'Synthetic cancellation proof: one blue square.';
const MODELS = { openrouter: 'google/gemini-3.1-flash-image-preview', google: 'gemini-3.1-flash-image', minimax: 'image-01' };
const BASES = { openrouter: 'https://openrouter.ai/api/v1', google: 'https://generativelanguage.googleapis.com/v1beta', minimax: 'https://api.minimax.io/v1' };
const source = path.resolve(process.argv[2]);
const artifacts = path.resolve(process.argv[3]);
const self = fileURLToPath(import.meta.url);
const load = (relative) => import(pathToFileURL(path.join(source, relative)).href);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

if (process.argv[4] === 'provider-child') {
  const [providerId, scenario, configFile] = process.argv.slice(5);
  const cfg = JSON.parse(await fs.readFile(configFile, 'utf8'));
  const controller = new AbortController();
  const say = (value) => process.stdout.write(`PROOF ${JSON.stringify(value)}\n`);
  const cancel = () => { controller.abort(new Error('synthetic proof cancellation')); say({ event: 'aborted' }); };
  const input = (chunk) => { if (chunk.toString().includes('abort')) cancel(); };
  process.stdin.on('data', input);
  const cleanup = await load('src/cli/runtime-cleanup.js');
  const state = await load('src/state/openclaw-state-db-cache.js');
  const workers = await load('src/infra/worker-native-lifecycle.js');
  try {
    const module = await load(`extensions/${providerId}/image-generation-provider.ts`);
    const provider = providerId === 'google' ? module.googleImageGenerationProvider
      : providerId === 'openrouter' ? module.buildOpenRouterImageGenerationProvider()
        : module.buildMinimaxImageGenerationProvider();
    if (scenario === 'pre-aborted') cancel();
    say({ event: 'calling', providerId, scenario });
    try {
      const result = await provider.generateImage({
        cfg, provider: providerId, model: MODELS[providerId], prompt: PROMPT,
        agentDir: path.join(process.env.OPENCLAW_STATE_DIR, 'agents/main/agent'),
        signal: controller.signal, timeoutMs: 15000,
        ...(scenario === 'edit' ? { inputImages: [{ buffer: PNG, mimeType: 'image/png', fileName: 'reference.png' }] } : {}),
        ...(scenario === 'count-two' ? { count: 2 } : {}),
      });
      for (const image of result.images) assert.deepEqual(image.buffer, PNG);
      say({ event: 'outcome', status: 'fulfilled', images: result.images.length, aborted: controller.signal.aborted });
    } catch (error) {
      say({ event: 'outcome', status: 'rejected', name: error.name, message: error.message, aborted: controller.signal.aborted });
    }
  } finally {
    process.stdin.off('data', input);
    process.stdin.destroy();
    await cleanup.closeCliResources();
    await cleanup.waitForPendingCliDisposers();
    await state.closeOpenClawStateDatabaseAsync();
    await workers.closeDefaultRetainedNativeWorkerSource();
  }
} else {
  const git = (...args) => execFileSync('git', args, { cwd: source, encoding: 'utf8', timeout: 10000 });
  assert.equal(git('rev-parse', 'HEAD').trim(), HEAD);
  assert.equal(git('status', '--porcelain'), '');
  const initialSource = git('status', '--porcelain');
  const { runManagedCommand, hasUnjoinedWork } = await load('scripts/lib/managed-child-process.mts');
  await fs.mkdir(artifacts, { recursive: true });
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'image-cancel-baseline-'));
  const receipt = { head: HEAD, vendorLive: false, proof: 'actual provider + guarded HTTP through explicit loopback proxy; actual CLI separately', complete: false, cleanup: false,
    allChildrenJoined: false, configsUnchanged: false, sourceClean: false, serversClosed: false, socketsClosed: false, scratchRemoved: false, cases: [] };
  const snapshots = new Map();
  const sockets = new Set();
  const commands = [];
  const events = [];
  let active;
  let fixtureFailure;
  let failure;
  let unjoined = false;
  let proxy;
  let origin;
  const now = () => performance.now();
  const track = (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.on('error', () => {}); };
  const bounded = async (promise, label, ms = 30000) => {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Fixture deadline: ${label}`)), ms); })]); }
    finally { clearTimeout(timer); }
  };
  const listen = async (server) => { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); return server.address().port; };
  const freshEnvironment = (home, configFile) => {
    const env = {};
    for (const key of ['PATH', 'PNPM_HOME', 'COREPACK_HOME', 'LANG', 'LC_ALL', 'TZ', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT']) if (process.env[key] !== undefined) env[key] = process.env[key];
    return { ...env, HOME: home, USERPROFILE: home, TMPDIR: home, TMP: home, TEMP: home, CI: 'true', NO_COLOR: '1',
      XDG_CONFIG_HOME: path.join(home, 'xdg-config'), XDG_CACHE_HOME: path.join(home, 'xdg-cache'), XDG_DATA_HOME: path.join(home, 'xdg-data'),
      OPENCLAW_CONFIG_PATH: configFile, OPENCLAW_STATE_DIR: path.join(home, 'state') };
  };
  function start(name, bin, args, env, stdin = 'ignore') {
    const chunks = [[], []];
    const ready = deferred();
    const ack = deferred();
    const control = new AbortController();
    const record = { name, startedAt: now(), exit: null, bytes: 0, messages: [] };
    let line = '';
    let child;
    const done = runManagedCommand({ bin, args, cwd: source, env, stdio: [stdin, 'pipe', 'pipe'],
      timeoutMs: 180000, signal: control.signal, requireProcessTreeExit: true, waitForCleanupRelease: true,
      onReady(value) {
        child = value;
        child.once('exit', (code, signal) => { record.exit = { code, signal, at: now() }; });
        for (const [index, stream] of [child.stdout, child.stderr].entries()) stream.on('data', (chunk) => {
          record.bytes += chunk.length;
          if (record.bytes > 4 * 1024 * 1024) { control.abort(new Error('Capture budget')); return; }
          chunks[index].push(Buffer.from(chunk));
          const text = chunk.toString();
          if (index === 1 && text.includes('Command interrupted by SIGINT.')) ack.resolve(now());
          if (index === 0) {
            line += text;
            const lines = line.split('\n'); line = lines.pop();
            for (const row of lines) if (row.startsWith('PROOF ')) {
              const message = JSON.parse(row.slice(6)); record.messages.push({ ...message, at: now() });
              if (message.event === 'aborted') ack.resolve(now());
            }
          }
        });
        ready.resolve();
      },
    }).then((status) => ({ status }), (error) => ({ error })).then((value) => {
      record.settledAt = now(); record.helperUnjoined = value.error ? hasUnjoinedWork(value.error) : false;
      record.helperOutcome = value.error ? { error: { name: value.error.name, message: value.error.message } } : { status: value.status };
      return value;
    });
    const command = { record, done, ready: ready.promise, ack: ack.promise, control,
      abortProvider() { child.stdin.write('abort\n'); }, interrupt() {
        // runManagedCommand owns this POSIX group; reach pnpm and its CLI descendants together.
        assert.equal(process.platform, 'linux'); process.kill(-child.pid, 'SIGINT');
      },
      async persist() { const texts = chunks.map((parts) => Buffer.concat(parts).toString('utf8')); await Promise.all(texts.map((text, index) => fs.writeFile(path.join(artifacts, `${name}.${index === 0 ? 'stdout' : 'stderr'}.txt`), text))); return texts; } };
    commands.push(command); return command;
  }
  function payload(providerId, url) {
    const data = PNG.toString('base64');
    if (providerId === 'google') return { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data } }] } }] };
    if (providerId === 'minimax') return { data: { image_base64: [data] }, base_resp: { status_code: 0 } };
    return url.endsWith('/images') ? { data: [{ b64_json: data }] } : { choices: [{ message: { images: [{ image_url: { url: `data:image/png;base64,${data}` } }] } }] };
  }
  try {
    const cert = path.join(scratch, 'fixture-cert.pem');
    const key = path.join(scratch, 'fixture-key.pem');
    const certResult = await runManagedCommand({ bin: 'openssl', args: ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=openrouter.ai', '-addext', 'subjectAltName=DNS:openrouter.ai,DNS:generativelanguage.googleapis.com,DNS:api.minimax.io', '-keyout', key, '-out', cert], cwd: scratch, stdio: 'ignore', timeoutMs: 30000, requireProcessTreeExit: true, waitForCleanupRelease: true });
    assert.equal(certResult, 0);
    const certificate = await fs.readFile(cert, 'utf8');
    origin = https.createServer({ key: await fs.readFile(key), cert: certificate }, async (request, response) => {
      try {
        assert(active, 'Request without active case');
        assert(active.requests.length < 3, 'Unexpected request multiplicity');
        assert.equal(request.method, 'POST');
        const pieces = []; let bytes = 0;
        for await (const piece of request) { bytes += piece.length; assert(bytes <= 65536); pieces.push(piece); }
        const body = JSON.parse(Buffer.concat(pieces).toString('utf8'));
        const item = { at: now(), url: request.url, body, closedAt: null, releasedAt: null };
        active.requests.push(item);
        const owner = active;
        response.once('close', () => { item.closedAt = now(); owner.closed.resolve(item.closedAt); });
        const prompt = owner.providerId === 'google' ? body.contents?.[0]?.parts?.at(-1)?.text : body.prompt ?? body.messages?.[0]?.content;
        assert.equal(typeof prompt === 'string' ? prompt : prompt?.[0]?.text, PROMPT);
        if (owner.scenario === 'edit') {
          const reference = owner.providerId === 'google' ? body.contents[0].parts[0].inlineData.data
            : owner.providerId === 'minimax' ? body.subject_reference[0].image_file
              : body.input_references[0].image_url.url;
          assert.equal(reference, owner.providerId === 'google' ? PNG.toString('base64') : `data:image/png;base64,${PNG.toString('base64')}`);
        }
        if (owner.providerId === 'openrouter') assert.equal(body.n, 1);
        owner.received.resolve();
        if (owner.hold) await owner.release.promise;
        if (!response.destroyed) { item.releasedAt = now(); response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(payload(owner.providerId, request.url))); }
      } catch (error) { fixtureFailure ??= error; response.writeHead(500); response.end('Synthetic fixture failure'); }
    });
    origin.on('connection', track);
    origin.on('tlsClientError', (error) => { fixtureFailure ??= error; });
    const originPort = await listen(origin);
    const allowed = new Set(['openrouter.ai:443', 'generativelanguage.googleapis.com:443', 'api.minimax.io:443']);
    proxy = http.createServer((_request, response) => { fixtureFailure ??= new Error('Expected CONNECT tunnel'); response.writeHead(502); response.end(); });
    proxy.on('connection', track);
    proxy.on('connect', (request, client, head) => {
      try { assert(allowed.has(request.url), `Unexpected proxy target: ${request.url}`); }
      catch (error) { fixtureFailure ??= error; client.destroy(); return; }
      events.push({ event: 'connect', target: request.url, at: now() });
      const upstream = net.connect(originPort, '127.0.0.1'); track(upstream);
      upstream.once('connect', () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); client.pipe(upstream); upstream.pipe(client); });
      client.once('close', () => upstream.destroy()); upstream.once('close', () => client.destroy());
    });
    const proxyPort = await listen(proxy);
    for (const providerId of ['openrouter', 'google', 'minimax']) {
      const scenarios = ['generate', 'edit', ...(providerId === 'openrouter' ? ['count-two'] : []), 'pre-aborted', 'midflight'];
      for (const scenario of scenarios) {
        const name = `${providerId}-${scenario}`;
        const home = path.join(scratch, name); await fs.mkdir(home);
        const configFile = path.join(home, 'openclaw.json');
        const cfg = { agents: { ownership: 'explicit', entries: { main: { workspace: path.join(home, 'workspace') } } },
          plugins: { allow: [providerId], entries: { [providerId]: { enabled: true } } },
          models: { providers: { [providerId]: { baseUrl: BASES[providerId], apiKey: 'synthetic-proof-not-a-live-key', auth: 'api-key', models: [],
            request: { proxy: { mode: 'explicit-proxy', url: `http://127.0.0.1:${proxyPort}` }, tls: { ca: certificate } } } } } };
        const bytes = `${JSON.stringify(cfg, null, 2)}\n`; await fs.writeFile(configFile, bytes); snapshots.set(configFile, bytes);
        await fs.writeFile(path.join(artifacts, `${name}.config.json`), bytes);
        active = { providerId, scenario, requests: [], received: deferred(), closed: deferred(), release: deferred(), hold: scenario === 'midflight' };
        const current = active;
        const command = start(name, process.execPath, ['--import', './scripts/tsx.mjs', self, source, artifacts, 'provider-child', providerId, scenario, configFile], freshEnvironment(home, configFile), 'pipe');
        await command.ready;
        if (current.hold) {
          await bounded(current.received.promise, `${name} request`);
          command.abortProvider(); current.abortAckAt = await bounded(command.ack, `${name} abort acknowledgment`);
          // Observation window only: absence of close is recorded, never proof of bounded cancellation.
          current.closedBeforeManualRelease = await Promise.race([current.closed.promise.then(() => true), pause(500).then(() => false)]);
          current.manualReleaseAt = now(); current.release.resolve();
        }
        const outcome = await bounded(command.done, name, 180000);
        await command.persist();
        if (outcome.error) { unjoined ||= hasUnjoinedWork(outcome.error); throw outcome.error; }
        assert.equal(outcome.status, 0); assert.equal(command.record.exit?.signal, null);
        assert(!fixtureFailure, fixtureFailure?.stack);
        const result = command.record.messages.find((entry) => entry.event === 'outcome');
        assert(result, `${name} missing actual-provider result`);
        assert.equal(result.status, 'fulfilled', `${name} baseline phenotype changed`);
        assert.equal(result.images, scenario === 'count-two' ? 2 : 1);
        assert.equal(current.requests.length, scenario === 'count-two' ? 2 : 1);
        if (scenario === 'pre-aborted' || scenario === 'midflight') assert.equal(result.aborted, true);
        if (scenario === 'midflight') { assert.equal(current.closedBeforeManualRelease, false); assert(result.at >= current.manualReleaseAt); }
        receipt.cases.push({ name, boundary: 'real-provider-http-same-process', ...command.record, requests: current.requests, abortAckAt: current.abortAckAt, manualReleaseAt: current.manualReleaseAt, closedBeforeManualRelease: current.closedBeforeManualRelease });
        active = undefined;
      }
    }
    // The CLI case has a separate receipt; a provider process result does not imply CLI proof.
    const name = 'openrouter-cli-midflight';
    const template = receipt.cases.find((entry) => entry.name === 'openrouter-generate');
    const configFile = path.join(scratch, 'openrouter-generate', 'openclaw.json');
    const home = path.dirname(configFile);
    const output = path.join(home, 'output.png'); await fs.writeFile(output, Buffer.from('existing-output'));
    active = { providerId: 'openrouter', requests: [], received: deferred(), closed: deferred(), release: deferred(), hold: true };
    const current = active;
    const command = start(name, 'pnpm', ['--silent', 'openclaw', 'infer', 'image', 'generate', '--agent', 'main', '--model', `openrouter/${MODELS.openrouter}`, '--prompt', PROMPT, '--output', output, '--json'], freshEnvironment(home, configFile));
    await command.ready; await bounded(current.received.promise, 'CLI request', 120000);
    command.interrupt(); current.abortAckAt = await bounded(command.ack, 'CLI accepted SIGINT');
    current.closedBeforeManualRelease = await Promise.race([current.closed.promise.then(() => true), pause(500).then(() => false)]);
    current.exitBeforeManualRelease = command.record.exit !== null;
    current.manualReleaseAt = now(); current.release.resolve();
    const outcome = await bounded(command.done, 'CLI cleanup', 180000); const [stdout] = await command.persist();
    if (outcome.error) { unjoined ||= hasUnjoinedWork(outcome.error); throw outcome.error; }
    assert.equal(outcome.status, 130); assert.equal(command.record.exit?.signal, null);
    assert.equal(stdout.trim(), ''); assert.deepEqual(await fs.readFile(output), Buffer.from('existing-output'));
    assert.equal(current.closedBeforeManualRelease, false); assert.equal(current.exitBeforeManualRelease, false);
    assert(!fixtureFailure, fixtureFailure?.stack);
    receipt.cases.push({ name, boundary: 'actual-pnpm-openclaw-CLI', ...command.record, requests: current.requests, abortAckAt: current.abortAckAt, manualReleaseAt: current.manualReleaseAt, closedBeforeManualRelease: current.closedBeforeManualRelease, exitBeforeManualRelease: current.exitBeforeManualRelease, controlsReference: template.name });
    active = undefined;
  } catch (error) { failure = error; receipt.error = { name: error.name, message: error.message, stack: error.stack }; }
  finally {
    if (active) receipt.partialCase = { providerId: active.providerId, scenario: active.scenario, requests: active.requests, abortAckAt: active.abortAckAt, manualReleaseAt: active.manualReleaseAt };
    active?.release.resolve();
    for (const command of commands) if (!command.record.settledAt) command.control.abort(new Error('Proof cleanup'));
    for (const command of commands) { const outcome = await command.done; if (outcome.error) unjoined ||= hasUnjoinedWork(outcome.error); await command.persist(); }
    receipt.commands = commands.map((command) => command.record);
    receipt.allChildrenJoined = !unjoined && commands.every(({ record }) =>
      Number.isFinite(record.settledAt) && record.exit !== null &&
      (Number.isInteger(record.exit.code) || typeof record.exit.signal === 'string') && record.helperUnjoined === false);
    receipt.finalCheckErrors = [];
    try {
      for (const [file, bytes] of snapshots) assert.equal(await fs.readFile(file, 'utf8'), bytes, 'Synthetic config was mutated');
      receipt.configsUnchanged = true;
    } catch (error) { receipt.finalCheckErrors.push({ check: 'configsUnchanged', message: error.message }); }
    try {
      assert.equal(git('rev-parse', 'HEAD').trim(), HEAD); assert.equal(git('status', '--porcelain'), initialSource);
      receipt.sourceClean = true;
    } catch (error) { receipt.finalCheckErrors.push({ check: 'sourceClean', message: error.message }); }
    for (const socket of sockets) socket.destroy();
    const servers = [proxy, origin].filter(Boolean);
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close((error) => {
      if (error) receipt.finalCheckErrors.push({ check: 'serversClosed', message: error.message }); resolve();
    }))));
    receipt.serversClosed = servers.every((server) => server.listening === false) && !receipt.finalCheckErrors.some((error) => error.check === 'serversClosed');
    receipt.socketsClosed = sockets.size === 0;
    receipt.cleanup = receipt.allChildrenJoined && receipt.serversClosed && receipt.socketsClosed;
    if (receipt.cleanup) {
      try { await fs.rm(scratch, { recursive: true, force: true }); receipt.scratchRemoved = true; }
      catch (error) { receipt.finalCheckErrors.push({ check: 'scratchRemoved', message: error.message }); }
    }
    receipt.complete = !failure && !fixtureFailure && receipt.cases.length === 14 &&
      receipt.cleanup && receipt.configsUnchanged && receipt.sourceClean && receipt.scratchRemoved && receipt.finalCheckErrors.length === 0;
    receipt.events = events;
    await fs.writeFile(path.join(artifacts, 'image-cancel-baseline.receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  }
  if (failure) throw failure;
  assert(receipt.complete, 'Baseline or strict final checks incomplete; inspect raw receipt');
  console.log(JSON.stringify({ head: HEAD, complete: receipt.complete, cleanup: receipt.cleanup, cases: receipt.cases.length }));
}

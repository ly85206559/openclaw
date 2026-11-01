import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const source = path.resolve(process.argv[2]);
const artifacts = path.resolve(process.argv[3]);
const head = 'a5b140c444bc8eecc9fcf50de2d3bfd58eb29492';
const git = (...args) => execFileSync('git', args, { cwd: source, encoding: 'utf8', timeout: 10000 });
assert.equal(git('rev-parse', 'HEAD').trim(), head);
await fs.mkdir(artifacts, { recursive: true });
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-unicode-gateway-'));
const configPath = path.join(scratch, 'openclaw.json');
const gatewayPassword = 'synthetic-voice-gateway-password';
const carrierToken = 'synthetic-voice-carrier-token';
const realtimeKey = 'synthetic-voice-realtime-key';
const modelKey = 'synthetic-voice-model-key';
const publicWebhook = 'https://voice-proof.example.com/voice/webhook';
const providerCallId = `CA${'1'.repeat(32)}`;
const expectedQuestion = 'Meet in İstanbul tomorrow';
const corruptedQuestion = 'Meet in İstanbultomorrow';
const agentAnswer = 'Voice proof acknowledged.';
const { WebSocket, WebSocketServer } = createRequire(path.join(source, 'package.json'))('ws');
const { runManagedCommand, hasUnjoinedWork } = await import(pathToFileURL(path.join(source, 'scripts/lib/managed-child-process.mts')).href);
const receipt = {
  head, complete: false, cleanup: false,
  boundary: 'shipped Gateway -> signed carrier HTTP/WS -> official realtime adapter -> real agent runtime -> controlled model HTTP -> realtime tool result',
  limitations: 'Synthetic carrier, transcription and model service; no vendor live audio, phone network or model inference claim.',
  commands: [],
  providerResponses: [],
};
const modelRequests = [];
const realtimeEvents = [];
let gateway;
let carrier;
let configBytes;
let fixtureFailure;
let failure;
let unjoined = false;
let validWebhookSent = false;
let realtimeReady = false;
let greetingSettled = false;
let stimulusSent = false;
let finalToolResult;
let callId;
let gatewayPort;
let voicePort;
let modelPort;
let realtimePort;
let stimulusTimer;

const redact = (text) => {
  for (const value of [gatewayPassword, carrierToken, realtimeKey, modelKey]) text = text.replaceAll(value, '[synthetic-credential]');
  return text.replaceAll(scratch, '[fixture-state]').replaceAll(/127\.0\.0\.1(?::\d+)?/g, '[loopback]').replaceAll(/\+1555000\d+/g, '[synthetic-phone]').replaceAll(/(\/voice\/stream\/realtime\/)[0-9a-f-]{36}/gi, '$1[stream-token]');
};
const save = async (name, value) => fs.writeFile(path.join(artifacts, name), redact(typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n'));

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

function start(name, args, timeoutMs) {
  const capture = [[], []];
  const abort = new AbortController();
  const record = { name, bytes: 0, exit: null, settled: false };
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
    return outcome;
  });
  return { record, done, abort, async persist() {
    assert(record.bytes <= 8 * 1024 * 1024, `${name}: capture overflow`);
    const output = capture.map((chunks) => Buffer.concat(chunks).toString('utf8'));
    await Promise.all(output.map((text, index) => save(`${name}.${index === 0 ? 'stdout' : 'stderr'}.txt`, text)));
    return output;
  } };
}

async function gatewayCall(name, method, params) {
  const command = start(name, ['gateway', 'call', method, '--url', `ws://127.0.0.1:${gatewayPort}`, '--password', gatewayPassword, '--params', JSON.stringify(params), '--timeout', '30000', '--json'], 90000);
  const outcome = await command.done;
  const [stdout] = await command.persist();
  receipt.commands.push({ ...command.record, status: outcome.status });
  if (outcome.error) { unjoined ||= hasUnjoinedWork(outcome.error); throw outcome.error; }
  assert.equal(outcome.status, 0, `${name}: CLI failed`);
  assert.equal(command.record.exit?.code, 0);
  assert.equal(command.record.exit?.signal, null);
  return JSON.parse(stdout);
}

async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server.address().port;
}
async function reservePort() {
  const server = net.createServer();
  const port = await listen(server);
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}
async function waitUntil(predicate, label, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fixtureFailure) throw fixtureFailure;
    if (await predicate()) return;
    if (gateway?.record.settled) throw new Error(`Gateway exited while waiting for ${label}`);
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
async function portOpen(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.setTimeout(1000, () => { socket.destroy(); reject(new Error('Listener probe timed out')); });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', (error) => { socket.destroy(); error.code === 'ECONNREFUSED' ? resolve(false) : reject(error); });
  });
}
function signedForm(fields) {
  const form = new URLSearchParams(fields);
  const material = publicWebhook + [...form].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => key + value).join('');
  return { form, signature: createHmac('sha1', carrierToken).update(material).digest('base64') };
}
async function webhook(fields, valid = true) {
  const { form, signature } = signedForm(fields);
  const response = await fetch(`http://127.0.0.1:${voicePort}/voice/webhook`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': valid ? signature : 'invalid-fixture-signature' },
    body: form.toString(), signal: AbortSignal.timeout(10000),
  });
  return { status: response.status, body: await response.text() };
}

const modelServer = http.createServer((request, response) => {
  const chunks = [];
  let bytes = 0;
  request.on('error', (error) => { fixtureFailure ??= error; });
  request.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes <= 4 * 1024 * 1024) chunks.push(Buffer.from(chunk));
    else { fixtureFailure ??= new Error('Model request budget exceeded'); request.destroy(); }
  });
  request.on('end', () => {
    try {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/chat/completions');
      assert.equal(request.headers.authorization, `Bearer ${modelKey}`);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      modelRequests.push(body);
      assert.equal(body.model, 'fixture-model');
      assert.equal(body.stream, true);
      const userText = body.messages.filter((message) => message.role === 'user').flatMap((message) => typeof message.content === 'string' ? [message.content] : message.content.filter((part) => part.type === 'text').map((part) => part.text)).join('\n');
      assert(userText.includes(`User request:\n${expectedQuestion}`), 'Actual agent HTTP prompt lost the expected Unicode question');
      assert(userText.includes(`Caller: ${expectedQuestion}`), 'Actual agent HTTP prompt lost the partial transcript context');
      assert(!userText.includes(corruptedQuestion), 'Actual agent HTTP prompt contains the corrupted missing-space question');
      receipt.observedAgentUserPrompt = userText;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const base = { id: 'chatcmpl-voice-fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture-model' };
      response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: agentAnswer }, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 16, completion_tokens: 4, total_tokens: 20 } })}\n\n`);
      response.end('data: [DONE]\n\n');
    } catch (error) {
      fixtureFailure ??= error;
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'Synthetic model boundary mismatch' }));
    }
  });
});
modelServer.requestTimeout = 10000;
const realtimeServer = http.createServer((_request, response) => { response.writeHead(404); response.end(); });
const realtimeWss = new WebSocketServer({ server: realtimeServer, maxPayload: 4 * 1024 * 1024 });
realtimeWss.on('connection', (socket, request) => {
  let realtimeSession;
  let greetingResponseId;
  let manualResponseSequence = 0;
  try {
    const endpoint = new URL(request.url, 'http://fixture');
    assert.equal(endpoint.pathname, '/realtime');
    assert.equal(endpoint.searchParams.get('model'), 'gpt-realtime-2.1');
    assert.equal(request.headers.authorization, `Bearer ${realtimeKey}`);
  } catch (error) { fixtureFailure ??= error; socket.close(1008, 'Unexpected fixture request'); return; }
  socket.on('error', (error) => { fixtureFailure ??= error; });
  socket.on('message', (bytes) => {
    try {
      assert(realtimeEvents.length < 100, 'Realtime event capture budget exceeded');
      const event = JSON.parse(bytes.toString());
      realtimeEvents.push(event);
      if (event.type === 'session.update') {
        if (!realtimeSession) {
          assert(event.session.tools.some((tool) => tool.name === 'openclaw_agent_consult'), 'Real plugin consult tool not registered');
          realtimeSession = event.session;
        } else {
          realtimeSession = {
            ...realtimeSession, ...event.session,
            audio: {
              ...realtimeSession.audio, ...event.session.audio,
              input: { ...realtimeSession.audio.input, ...event.session.audio?.input },
            },
          };
        }
        socket.send(JSON.stringify({ type: 'session.updated', session: realtimeSession }));
        realtimeReady = true;
        if (greetingResponseId && event.session.audio?.input?.turn_detection?.create_response === true) {
          greetingSettled = true;
          receipt.greetingResponseSettled = greetingResponseId;
        }
      }
      if (event.type === 'response.create') {
        assert.equal(typeof event.event_id, 'string', 'Manual response request lacks its event identity');
        const responseId = `fixture-manual-response-${++manualResponseSequence}`;
        if (!stimulusSent) {
          assert(!greetingResponseId, 'Unexpected second manual response before caller input');
          greetingResponseId = responseId;
        }
        receipt.providerResponses.push({ requestEventId: event.event_id, responseId, kind: stimulusSent ? 'followup' : 'greeting' });
        socket.send(JSON.stringify({ type: 'response.created', response: { id: responseId, status: 'in_progress' } }));
        socket.send(JSON.stringify({ type: 'response.done', response: { id: responseId, status: 'completed', output: [] } }));
      }
      if (event.type === 'input_audio_buffer.append' && !stimulusSent) {
        stimulusSent = true;
        socket.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'fixture-input', delta: 'Meet in İstanbul' }));
        socket.send(JSON.stringify({ type: 'response.created', response: { id: 'fixture-response', status: 'in_progress' } }));
        socket.send(JSON.stringify({ type: 'response.done', response: { id: 'fixture-response', status: 'completed', output: [{ id: 'fixture-tool-item', type: 'function_call', status: 'completed', call_id: 'fixture-consult', name: 'openclaw_agent_consult', arguments: JSON.stringify({ question: 'message' }) }] } }));
        stimulusTimer = setTimeout(() => {
          socket.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'fixture-input', delta: 'İstanbul tomorrow' }));
        }, 50);
      }
      if (event.type === 'conversation.item.create' && event.item?.type === 'function_call_output') {
        const output = JSON.parse(event.item.output);
        if (output.text === agentAnswer) {
          assert.equal(event.item.call_id, 'fixture-consult');
          finalToolResult = output;
        }
      }
    } catch (error) { fixtureFailure ??= error; }
  });
});
for (const server of [modelServer, realtimeServer, realtimeWss]) server.on('error', (error) => { fixtureFailure ??= error; });

try {
  modelPort = await listen(modelServer);
  realtimePort = await listen(realtimeServer);
  gatewayPort = await reservePort();
  voicePort = await reservePort();
  configBytes = JSON.stringify({
    gateway: { mode: 'local', bind: 'loopback', port: gatewayPort, auth: { mode: 'password', password: gatewayPassword }, controlUi: { enabled: false } },
    agents: { defaults: { workspace: path.join(scratch, 'workspace'), model: { primary: 'voice-proof/fixture-model' }, models: { 'voice-proof/fixture-model': {} } } },
    models: { mode: 'merge', providers: { 'voice-proof': { baseUrl: `http://127.0.0.1:${modelPort}/v1`, apiKey: modelKey, api: 'openai-completions', models: [{ id: 'fixture-model', name: 'Synthetic voice proof model', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } },
    plugins: { allow: ['voice-call', 'openai'], entries: {
      openai: { enabled: true },
      'voice-call': { enabled: true, config: {
        enabled: true, provider: 'twilio', twilio: { accountSid: `AC${'0'.repeat(32)}`, authToken: carrierToken },
        fromNumber: '+15550002222', inboundPolicy: 'open', publicUrl: publicWebhook,
        serve: { bind: '127.0.0.1', port: voicePort, path: '/voice/webhook' },
        responseTimeoutMs: 90000, sessionScope: 'per-call',
        realtime: { enabled: true, provider: 'openai', streamPath: '/voice/stream/realtime', consultPolicy: 'auto', consultThinkingLevel: 'off', fastContext: { enabled: false }, providers: { openai: { baseUrl: `ws://127.0.0.1:${realtimePort}/realtime`, apiKey: realtimeKey, model: 'gpt-realtime-2.1' } } },
      } },
    } },
  }, null, 2) + '\n';
  await fs.writeFile(configPath, configBytes);
  await save('gateway-config.redacted.json', configBytes);
  gateway = start('gateway', ['gateway', 'run', '--bind', 'loopback', '--port', String(gatewayPort), '--password', gatewayPassword], 600000);
  await waitUntil(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${gatewayPort}/startup`, { signal: AbortSignal.timeout(2000) });
      return response.ok && (await response.json()).status === 'started' && await portOpen(voicePort);
    } catch { return false; }
  }, 'Gateway and registered voice service readiness', 240000);
  receipt.gatewayReady = true;
  const fields = { CallSid: providerCallId, Direction: 'inbound', CallStatus: 'ringing', From: '+15550001111', To: '+15550002222' };
  const rejected = await webhook({ ...fields, CallSid: `CA${'2'.repeat(32)}` }, false);
  assert.equal(rejected.status, 401, 'Invalidly signed synthetic carrier must be rejected');
  receipt.invalidCarrierSignatureRejected = true;
  validWebhookSent = true;
  const admitted = await webhook(fields);
  await save('carrier-twiml.redacted.txt', admitted.body);
  assert.equal(admitted.status, 200);
  const streamMatch = admitted.body.match(/<Stream\s+url="([^"]+)"/);
  assert(streamMatch, 'Normal signed carrier webhook did not issue a stream URL');
  const streamPath = new URL(streamMatch[1].replaceAll('&amp;', '&')).pathname;
  carrier = new WebSocket(`ws://127.0.0.1:${voicePort}${streamPath}`);
  carrier.on('error', (error) => { fixtureFailure ??= error; });
  carrier.on('message', (bytes) => {
    const event = JSON.parse(bytes.toString());
    if (event.event === 'mark') carrier.send(JSON.stringify({ event: 'mark', streamSid: 'MZ-fixture', mark: event.mark }));
  });
  await waitUntil(() => carrier.readyState === WebSocket.OPEN, 'authenticated carrier WebSocket');
  carrier.send(JSON.stringify({ event: 'start', start: { streamSid: 'MZ-fixture', callSid: providerCallId, mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 } } }));
  await waitUntil(() => realtimeReady && greetingSettled, 'official realtime adapter greeting completion and VAD restoration');
  carrier.send(JSON.stringify({ event: 'media', streamSid: 'MZ-fixture', media: { payload: Buffer.alloc(160, 0xff).toString('base64'), timestamp: '0' } }));
  await waitUntil(() => finalToolResult !== undefined, 'real agent completion returned to realtime transport');
  assert.equal(modelRequests.length, 1, 'Expected one normal agent model request, with no retries');
  assert(stimulusSent && receipt.observedAgentUserPrompt, 'External transport chain was not traversed');
  receipt.correctQuestion = expectedQuestion;
  receipt.corruptedQuestionAbsent = !receipt.observedAgentUserPrompt.includes(corruptedQuestion);
  receipt.agentModelRequestCount = modelRequests.length;
  receipt.realtimeFunctionCallOutput = finalToolResult;
  const status = await gatewayCall('active-call-status', 'voicecall.status', {});
  const active = status.calls.find((call) => call.providerCallId === providerCallId);
  assert(active, 'Public Gateway RPC did not report the admitted carrier call');
  callId = active.callId;
  receipt.publicCallObserved = true;
} catch (error) {
  failure = error;
  unjoined ||= hasUnjoinedWork(error);
} finally {
  clearTimeout(stimulusTimer);
  if (validWebhookSent && gateway && !gateway.record.settled) {
    try {
      const ended = await webhook({ CallSid: providerCallId, Direction: 'inbound', CallStatus: 'completed', From: '+15550001111', To: '+15550002222' });
      assert.equal(ended.status, 200, 'Signed carrier completion webhook failed');
      if (callId) {
        const status = await gatewayCall('ended-call-status', 'voicecall.status', { callId });
        assert(status.found && typeof status.call?.endedAt === 'number', 'Gateway did not record carrier completion');
        receipt.publicCallEnded = true;
      }
    } catch (error) { failure ??= error; }
  }
  carrier?.close(1000);
  if (gateway) {
    const cancelled = !gateway.record.settled;
    if (cancelled) gateway.abort.abort();
    const outcome = await gateway.done;
    try {
      await gateway.persist();
      unjoined ||= hasUnjoinedWork(outcome.error);
      assert(cancelled && outcome.error?.code === 'ABORT_ERR' && !hasUnjoinedWork(outcome.error), 'Gateway did not establish strict process-tree cleanup');
      assert(gateway.record.exit !== null, 'Gateway exit was not observed');
      receipt.gatewayExit = gateway.record.exit;
      receipt.gatewayStrictTreeJoined = true;
    } catch (error) { failure ??= error; }
  }
  for (const socket of realtimeWss.clients) socket.terminate();
  if (carrier && carrier.readyState !== WebSocket.CLOSED) carrier.terminate();
  try {
    await new Promise((resolve, reject) => realtimeWss.close((error) => error ? reject(error) : resolve()));
    for (const server of [modelServer, realtimeServer]) {
      server.closeAllConnections();
      if (server.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    for (const port of [gatewayPort, voicePort, modelPort, realtimePort].filter(Boolean)) assert.equal(await portOpen(port), false, 'Owned listener remained open');
    receipt.ownedListenersClosed = true;
    receipt.configUnchanged = configBytes === undefined || await fs.readFile(configPath, 'utf8') === configBytes;
    receipt.sourceClean = git('status', '--porcelain', '--untracked-files=no') === '';
    assert(receipt.configUnchanged && receipt.sourceClean, 'Config or tracked source changed');
    if (fixtureFailure) throw fixtureFailure;
    if (!failure && !unjoined && receipt.gatewayStrictTreeJoined && receipt.publicCallEnded && receipt.ownedListenersClosed) {
      await fs.rm(scratch, { recursive: true });
      receipt.cleanup = true;
      receipt.complete = true;
    }
  } catch (error) { failure ??= error; }
  if (failure) { receipt.error = String(failure.stack ?? failure); receipt.retainedScratch = scratch; }
  receipt.unjoinedWork = unjoined;
  await save('model-requests.json', modelRequests);
  await save('realtime-client-events.json', realtimeEvents);
  await save('receipt.json', receipt);
  if (failure) throw new Error(redact(String(failure.stack ?? failure)));
  assert(receipt.complete, 'Proof did not complete all boundaries and cleanup');
  console.log(JSON.stringify({ head, question: expectedQuestion, corruptedQuestionAbsent: true, agentModelRequests: modelRequests.length, returnedAgentAnswer: finalToolResult.text, gatewayAndPlugin: true, cleanup: true }));
}

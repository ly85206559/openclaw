// Fork-only paired proof. No runtime owner, ingress, context or dispatch is mocked.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const repo = process.cwd();
const mode = process.env.PROOF_MODE;
assert(["baseline", "candidate"].includes(mode), "PROOF_MODE must name the paired cell");
const output = path.resolve(process.env.PROOF_OUT ?? "");
assert(process.env.PROOF_OUT, "PROOF_OUT must name an isolated artifact directory");
await fs.mkdir(output, { recursive: true });
const require = createRequire(path.join(repo, "package.json"));
const { marked } = await import(pathToFileURL(require.resolve("marked")).href);
const markedManifest = JSON.parse(await fs.readFile(path.join(repo, "node_modules/marked/package.json"), "utf8"));
assert.equal(markedManifest.version, "18.1.0");
const { applyMockOpenAiModelConfig } = await import(pathToFileURL(path.join(repo, "scripts/e2e/lib/fixtures/mock-openai-config.mjs")).href);
const { readMockUserText } = await import(pathToFileURL(path.join(repo, "scripts/e2e/lib/mock-inference-facts.ts")).href);
const root = await fs.mkdtemp(path.join(output, "isolated-runtime-"));
const state = path.join(root, "state");
const workspace = path.join(root, "workspace");
await fs.mkdir(state);
await fs.mkdir(workspace);
const requestsPath = path.join(output, "model-requests.jsonl");
const controlPath = path.join(root, "model-response.json");
await fs.writeFile(controlPath, JSON.stringify({ text: "TLON_GATEWAY_PROOF_OK", hold: false }));
const children = [];
const wire = [];
const captures = [];
const receipts = [];
const subscriptions = [];
const streams = new Map();
let phase = "bootstrap";
let failure;
let eventId = 20;

function launch(label, command, args, env) {
  const child = spawn(command, args, { cwd: repo, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  const item = { label, child, readLog: () => log };
  item.closed = new Promise((resolve) => child.once("close", resolve));
  child.stdout.on("data", (chunk) => { log += chunk.toString(); });
  child.stderr.on("data", (chunk) => { log += chunk.toString(); });
  child.on("error", (error) => { item.spawnError = error.message; log += `\nSPAWN ERROR: ${error.message}`; });
  children.push(item);
  return child;
}

async function until(check, label, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const item of children) {
      assert(!item.spawnError, `${item.label} spawn failed: ${item.spawnError}`);
      assert(item.child.exitCode === null && item.child.signalCode === null,
        `${item.label} exited while waiting for ${label}: ${item.readLog()}`);
    }
    const result = await check();
    if (result) { return result; }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

const native = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const entry = { method: req.method, path: url.pathname };
  wire.push(entry);
  if (req.method === "POST" && url.pathname === "/~/login") {
    req.resume();
    res.writeHead(200, { "Set-Cookie": "urbauth-~zod=synthetic-proof; Path=/" });
    res.end("ok");
    return;
  }
  if (req.method === "GET" && url.pathname === "/~/name") {
    res.end("zod");
    return;
  }
  if (req.method === "GET" && url.pathname.startsWith("/~/scry/")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(url.pathname === "/~/scry/settings/all.json"
      ? { all: { moltbot: { tlon: {
          dmAllowlist: ["~bus"], groupChannels: ["chat/~host/general"],
          groupInviteAllowlist: [], defaultAuthorizedShips: [],
          autoDiscoverChannels: false, autoAcceptDmInvites: false,
          autoAcceptGroupInvites: false, showModelSig: false,
          channelRules: { "chat/~host/general": { mode: "open" } },
        } } } } : {}));
    return;
  }
  if (url.pathname.startsWith("/~/channel/") && req.method === "PUT") {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (part) => { body += part; });
    req.on("end", () => {
      try {
        entry.body = JSON.parse(body);
        for (const action of entry.body) {
          if (action.action === "subscribe") {
            subscriptions.push({ ...action, channel: url.pathname });
          }
        }
        res.writeHead(204);
        res.end();
      } catch (error) {
        res.writeHead(400);
        res.end(error.message);
      }
    });
    return;
  }
  if (url.pathname.startsWith("/~/channel/") && req.method === "GET") {
    streams.set(url.pathname, res);
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    res.write(": connected\n\n");
    return;
  }
  if (url.pathname.startsWith("/~/channel/") && req.method === "DELETE") {
    res.writeHead(204);
    res.end();
    return;
  }
  res.writeHead(404);
  res.end();
});

async function providerRequests() {
  try {
    const text = await fs.readFile(requestsPath, "utf8");
    return text.split("\n").filter(Boolean).map((line) => JSON.parse(line))
      .filter((entry) => entry.method === "POST" && entry.path === "/v1/responses");
  } catch (error) {
    if (error.code === "ENOENT") { return []; }
    throw error;
  }
}

function currentUserText(entry) {
  const body = typeof entry.body === "string" ? JSON.parse(entry.body) : entry.body;
  assert(body && !body.truncated, "The model request artifact must retain the full raw payload");
  const input = body.input ?? body.messages;
  assert(Array.isArray(input), "Responses input must contain real projected messages");
  return input.toReversed().map(readMockUserText).find((text) => text !== undefined);
}

function sentProofAnswers() {
  return wire.flatMap((entry) => Array.isArray(entry.body) ? entry.body : [])
    .filter((action) => action.action === "poke" &&
      (action.mark === "chat-dm-action" || action.mark === "channel-action-1") &&
      JSON.stringify(action.json).includes("TLON_GATEWAY_PROOF_OK"));
}

async function sendCell({ name, group = false, code, denied = false }) {
  const sender = denied ? "~nec" : "~bus";
  const marker = `TLON_PROOF_${name.toUpperCase().replaceAll("-", "_")}`;
  const value = code === "nested"
    ? `${marker}\nBefore\n\`\`\`markdown\n# literal heading\n\`\`\`\nAfter`
    : code === "ordinary" ? `${marker}\nconst answer = 42;` : marker;
  const content = code
    ? [...(group ? [{ inline: ["~zod"] }] : []), { block: { code: { code: value, lang: "markdown" } } }]
    : [{ inline: [group ? `~zod ${value}` : value] }];
  const essay = { author: sender, content, sent: 1_700_000_000_000 + eventId };
  const json = group
    ? { nest: "chat/~host/general", response: { post: { id: name, "r-post": { set: { essay } } } } }
    : { whom: sender, id: name, response: { add: { essay } } };
  const subscription = subscriptions.find((sub) => sub.app === (group ? "channels" : "chat"));
  assert(subscription && streams.has(subscription.channel), "Native firehose subscription is active");
  const before = (await providerRequests()).length;
  const answerCount = sentProofAnswers().length;
  eventId += 21;
  const injected = { eventId, subscriptionId: subscription.id, json };
  wire.push({ injected });
  streams.get(subscription.channel).write(`id: ${eventId}\ndata: ${JSON.stringify({ id: subscription.id, json })}\n\n`);
  await until(() => wire.some((entry) => Array.isArray(entry.body) &&
    entry.body.some((action) => action.action === "ack" && action["event-id"] >= eventId)), `${name} native ACK`);
  if (denied) {
    await delay(1_000);
    const added = (await providerRequests()).slice(before);
    assert(!added.some((entry) => currentUserText(entry)?.includes(marker)), "Denied sender reached inference");
    assert.equal(sentProofAnswers().length, answerCount, "Denied sender received a product reply");
    receipts.push({ name, control: "denied marker absent after ACK and one-second quiet interval", pass: true });
    return;
  }
  const entry = await until(async () => (await providerRequests()).slice(before)
    .find((request) => currentUserText(request)?.includes(marker)), `${name} real provider request`);
  await until(() => sentProofAnswers().length > answerCount, `${name} real Tlon reply`);
  const userText = currentUserText(entry);
  const tokens = marked.lexer(userText).filter((token) => token.type !== "space");
  const codeNodes = tokens.filter((token) => token.type === "code" && token.text.startsWith(marker));
  const intact = code ? codeNodes.length === 1 && codeNodes[0].lang === "markdown" && codeNodes[0].text === value
    : userText.includes(marker);
  if (code === "ordinary") {
    assert(userText.includes(`\`\`\`markdown\n${value}\n\`\`\``), "Ordinary producer bytes changed");
  }
  captures.push({ name, marker, expectedCode: code ? value : undefined, userText, tokens,
    rawRequestSeq: entry.seq, nativeReply: sentProofAnswers().at(-1), intact });
  console.log("GATEWAY_CONTEXT_CAPTURE " + JSON.stringify({ mode, name, userText, intact,
    codeNodes: tokens.filter((token) => token.type === "code").map(({ lang, text }) => ({ lang, text })) }));
  receipts.push({ name, kind: code ?? "plain", pass: intact });
}

try {
  const nativePort = await listen(native);
  const reservation = http.createServer();
  const modelPort = await listen(reservation);
  await new Promise((resolve) => reservation.close(resolve));
  const gatewayReservation = http.createServer();
  const gatewayPort = await listen(gatewayReservation);
  await new Promise((resolve) => gatewayReservation.close(resolve));
  const configPath = path.join(state, "openclaw.json");
  const cfg = {
    gateway: { mode: "local", bind: "loopback", port: gatewayPort,
      auth: { mode: "token", token: "synthetic-tlon-gateway-proof" }, controlUi: { enabled: false } },
    agents: { defaults: { workspace, heartbeat: { every: "0m" } } },
    session: { dmScope: "per-channel-peer" },
    plugins: { enabled: true, allow: ["openai", "tlon"], entries: { tlon: { enabled: true }, openai: { enabled: true } } },
    channels: { tlon: { enabled: true, ship: "~zod", code: "synthetic-proof",
      url: `http://127.0.0.1:${nativePort}`, network: { dangerouslyAllowPrivateNetwork: true },
      dmAllowlist: ["~bus"], groupChannels: ["chat/~host/general"], autoDiscoverChannels: false,
      autoAcceptDmInvites: false, autoAcceptGroupInvites: false, showModelSignature: false,
      authorization: { channelRules: { "chat/~host/general": { mode: "open" } } } } },
  };
  applyMockOpenAiModelConfig(cfg, { mockPort: modelPort });
  await fs.writeFile(configPath, JSON.stringify(cfg, null, 2));
  const env = { ...process.env, OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_STATE_DIR: state,
    OPENCLAW_NO_RESPAWN: "1", OPENCLAW_SKIP_STARTUP_MODEL_PREWARM: "1",
    OPENAI_API_KEY: "synthetic-loopback-model-proof", ANTHROPIC_API_KEY: "" };
  delete env.OPENCLAW_SKIP_CHANNELS;
  launch("mock-model", process.execPath, [path.join(repo, "scripts/e2e/mock-openai-server.mjs")],
    { ...env, MOCK_PORT: String(modelPort), MOCK_REQUEST_LOG: requestsPath, MOCK_RESPONSE_CONTROL: controlPath });
  await until(async () => {
    try { return (await fetch(`http://127.0.0.1:${modelPort}/health`)).ok; } catch { return false; }
  }, "mock model health");
  launch("gateway", "pnpm", ["openclaw", "gateway", "run", "--port", String(gatewayPort), "--bind", "loopback"], env);
  await until(() => subscriptions.some((sub) => sub.app === "chat" && streams.has(sub.channel)) &&
    children.find((item) => item.label === "gateway").readLog().includes("Firehose subscriptions active"), "built Gateway and real Tlon ingress");
  phase = "semantic-proof";
  for (const cell of [
    { name: "dm-nested", code: "nested" }, { name: "group-nested", group: true, code: "nested" },
    { name: "dm-ordinary", code: "ordinary" }, { name: "group-ordinary", group: true, code: "ordinary" },
    { name: "dm-plain" }, { name: "group-plain", group: true }, { name: "denied-dm", denied: true },
    { name: "post-denial-alive" },
  ]) { await sendCell(cell); }
  const broken = receipts.filter((receipt) => !receipt.pass).map((receipt) => receipt.name);
  assert.deepEqual(broken, mode === "baseline" ? ["dm-nested", "group-nested"] : []);
  assert.equal(receipts.length, 8);
  phase = "audited";
  if (mode === "baseline") { process.exitCode = 1; }
} catch (error) {
  failure = { message: error.message, stack: error.stack };
  process.exitCode = 1;
} finally {
  const cleanupErrors = [];
  for (const item of children.toReversed()) {
    if (item.child.exitCode === null && item.child.signalCode === null) {
      if (item.child.pid) { process.kill(-item.child.pid, "SIGTERM"); }
      const deadline = Date.now() + 20_000;
      while (item.child.exitCode === null && item.child.signalCode === null && Date.now() < deadline) { await delay(100); }
      if (item.child.pid && item.child.exitCode === null && item.child.signalCode === null) {
        process.kill(-item.child.pid, "SIGKILL");
        cleanupErrors.push(`${item.label} required forced termination`);
      }
    }
    await item.closed;
    await fs.writeFile(path.join(output, `${item.label}.log`), item.readLog());
  }
  if (phase === "audited") {
    const deadline = Date.now() + 15_000;
    while (!wire.some((entry) => entry.method === "DELETE") && Date.now() < deadline) { await delay(100); }
    if (!wire.some((entry) => entry.method === "DELETE")) { cleanupErrors.push("Gateway did not close its native Urbit channel"); }
  }
  for (const stream of streams.values()) { stream.end(); }
  await new Promise((resolve) => { native.close(resolve); native.closeAllConnections(); });
  const cleanup = { nativeClosed: !native.listening, deleteReceipts: wire.filter((entry) => entry.method === "DELETE"),
    errors: cleanupErrors, children: children.map(({ label, child }) => ({ label, exitCode: child.exitCode, signal: child.signalCode })) };
  if (cleanupErrors.length) { process.exitCode = 1; phase = "cleanup-failed"; }
  const report = { mode, phase, node: process.version, marked: markedManifest.version,
    scope: "built Gateway, real Tlon durable ingress/context/dispatch, native synthetic Urbit, loopback recording model",
    receipts, failure, cleanup };
  await fs.writeFile(path.join(output, "gateway-proof.json"), JSON.stringify(report, null, 2));
  await fs.writeFile(path.join(output, "native-wire.json"), JSON.stringify(wire, null, 2));
  await fs.writeFile(path.join(output, "model-context-captures.json"), JSON.stringify(captures, null, 2));
  console.log(JSON.stringify(report));
}

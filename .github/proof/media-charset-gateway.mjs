// Fork-only proof: built CLI/Gateway and real extraction/provider projection; no owner mocks.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const repo = process.cwd();
const mode = process.env.PROOF_MODE;
const output = process.env.PROOF_OUT;
assert(["baseline", "candidate"].includes(mode));
assert(output, "PROOF_OUT must be an isolated artifact directory");
await fs.mkdir(output, { recursive: true });
const { applyMockOpenAiModelConfig } = await import(pathToFileURL(path.join(repo, "scripts/e2e/lib/fixtures/mock-openai-config.mjs")).href);
const { readMockUserText } = await import(pathToFileURL(path.join(repo, "scripts/e2e/lib/mock-inference-facts.ts")).href);
const root = await fs.mkdtemp(path.join(output, "isolated-runtime-"));
const state = path.join(root, "state");
const workspace = path.join(root, "workspace");
await fs.mkdir(state);
await fs.mkdir(workspace);
const requestLog = path.join(output, "model-requests.jsonl");
const controlPath = path.join(root, "model-response.json");
await fs.writeFile(controlPath, JSON.stringify({ text: "CHARSET_GATEWAY_OK", hold: false }));
const children = [];
const receipts = [];
const captures = [];
let phase = "bootstrap";
let failure;
let privateHits = 0;
const privateServer = http.createServer((req, res) => { privateHits++; req.resume(); res.end("must not be fetched"); });

function launch(label, command, args, env) {
  const child = spawn(command, args, { cwd: repo, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  const item = { label, child, readLog: () => log };
  item.closed = new Promise((resolve) => child.once("close", resolve));
  child.stdout.on("data", (chunk) => { log += chunk.toString(); });
  child.stderr.on("data", (chunk) => { log += chunk.toString(); });
  child.on("error", (error) => { item.spawnError = error.message; });
  children.push(item);
}

async function until(check, label, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const item of children) {
      assert(!item.spawnError, `${item.label} spawn error: ${item.spawnError}`);
      assert(item.child.exitCode === null && item.child.signalCode === null,
        `${item.label} exited waiting for ${label}: ${item.readLog()}`);
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

async function freePort() {
  const server = http.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function requests() {
  try {
    return (await fs.readFile(requestLog, "utf8")).split("\n").filter(Boolean).map(JSON.parse)
      .filter((entry) => entry.method === "POST" && entry.path === "/v1/responses");
  } catch (error) {
    if (error.code === "ENOENT") { return []; }
    throw error;
  }
}

function bodyOf(entry) {
  const body = typeof entry.body === "string" ? JSON.parse(entry.body) : entry.body;
  assert(body && !body.truncated, "Captured model payload must not be clipped");
  assert(Array.isArray(body.input ?? body.messages));
  return body;
}

function currentUserText(entry) {
  const body = bodyOf(entry);
  return (body.input ?? body.messages).toReversed().map(readMockUserText).find((text) => text !== undefined);
}

function modelText(body) {
  const strings = [];
  function visit(value) {
    if (typeof value === "string") { strings.push(value); }
    else if (Array.isArray(value)) { value.forEach(visit); }
    else if (value && typeof value === "object") { Object.values(value).forEach(visit); }
  }
  visit(body.instructions);
  visit(body.input ?? body.messages);
  return strings.join("\n");
}

try {
  const modelPort = await freePort();
  const gatewayPort = await freePort();
  const privatePort = await listen(privateServer);
  const configPath = path.join(state, "openclaw.json");
  const token = "synthetic-charset-gateway-proof";
  const cfg = {
    gateway: { mode: "local", bind: "loopback", port: gatewayPort,
      auth: { mode: "token", token }, controlUi: { enabled: false },
      http: { endpoints: { responses: { enabled: true } } } },
    agents: { defaults: { workspace, heartbeat: { every: "0m" } } },
    plugins: { enabled: true, allow: ["openai"], entries: { openai: { enabled: true } } },
  };
  applyMockOpenAiModelConfig(cfg, { mockPort: modelPort });
  await fs.writeFile(configPath, JSON.stringify(cfg, null, 2));
  const env = { ...process.env, OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_STATE_DIR: state,
    OPENCLAW_NO_RESPAWN: "1", OPENCLAW_SKIP_STARTUP_MODEL_PREWARM: "1",
    OPENAI_API_KEY: "synthetic-loopback-model-proof", ANTHROPIC_API_KEY: "" };
  launch("mock-model", process.execPath, [path.join(repo, "scripts/e2e/mock-openai-server.mjs")],
    { ...env, MOCK_PORT: String(modelPort), MOCK_REQUEST_LOG: requestLog, MOCK_RESPONSE_CONTROL: controlPath });
  await until(async () => {
    try { return (await fetch(`http://127.0.0.1:${modelPort}/health`)).ok; } catch { return false; }
  }, "mock model health");
  launch("gateway", "pnpm", ["openclaw", "gateway", "run", "--port", String(gatewayPort), "--bind", "loopback"], env);
  await until(async () => {
    try { return (await fetch(`http://127.0.0.1:${gatewayPort}/healthz`)).ok; } catch { return false; }
  }, "built Gateway health");
  phase = "semantic-proof";
  const cyrillic = Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2, 0x20, 0x88]);
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("Привет €", "utf16le")]);
  const cases = [
    { name: "sniffed-declared-charset", mime: "application/x-openclaw-charset-proof; charset=windows-1251", bytes: cyrillic, expected: "Привет €", regression: true },
    { name: "sniffed-quoted-alias", mime: 'application/x-openclaw-charset-proof; charset="cp1251"', bytes: cyrillic, expected: "Привет €", regression: true },
    { name: "direct-text-contract", mime: "text/plain; charset=windows-1251", bytes: cyrillic, expected: "Привет €" },
    { name: "utf16-bom-wins", mime: "text/plain; charset=windows-1251", bytes: utf16, expected: "Привет €" },
    { name: "utf8-default", mime: "text/plain", bytes: Buffer.from("UTF8 café €"), expected: "UTF8 café €" },
    { name: "unknown-label-fallback", mime: "text/plain; charset=not-an-encoding", bytes: Buffer.from("UTF8 fallback café €"), expected: "UTF8 fallback café €" },
    { name: "binary-mime-still-rejected", mime: "application/octet-stream; charset=windows-1251", bytes: cyrillic, rejected: true },
    { name: "private-url-still-blocked", source: { type: "url", url: `http://127.0.0.1:${privatePort}/must-not-fetch.txt` }, rejected: true },
  ];
  for (const cell of cases) {
    const marker = `CHARSET_GATEWAY_${cell.name.toUpperCase().replaceAll("-", "_")}`;
    const before = (await requests()).length;
    const source = cell.source ?? { type: "base64", media_type: cell.mime,
      data: cell.bytes.toString("base64"), filename: `${cell.name}.bin` };
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
      method: "POST", signal: AbortSignal.timeout(120_000),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ model: "openclaw", user: marker, stream: false,
        input: [{ type: "message", role: "user", content: [
          { type: "input_text", text: `${marker}: read the attachment. Reply exactly CHARSET_GATEWAY_OK.` },
          { type: "input_file", source },
        ] }] }),
    });
    const responseBody = await response.json();
    if (cell.rejected) {
      assert.equal(response.status, 400, `${cell.name} must retain its existing rejection`);
      assert.equal(responseBody.error.type, "invalid_request_error");
      assert(!(await requests()).slice(before).some((entry) => currentUserText(entry)?.includes(marker)));
      receipts.push({ name: cell.name, status: response.status, pass: true });
      continue;
    }
    assert.equal(response.status, 200, JSON.stringify(responseBody));
    assert.equal(responseBody.status, "completed", JSON.stringify(responseBody));
    assert(JSON.stringify(responseBody.output).includes("CHARSET_GATEWAY_OK"));
    const entry = await until(async () => (await requests()).slice(before)
      .filter((request) => request.inferenceFacts?.purpose === "other")
      .find((request) => currentUserText(request)?.includes(marker)), `${cell.name} foreground model input`);
    const text = modelText(bodyOf(entry));
    const blocks = [...text.matchAll(/<file name="[^"]+"[^>]*>\n([\s\S]*?)\n<\/file>/gu)].map((match) => match[1]);
    assert.equal(blocks.length, 1, "Exactly one current attachment must reach the real model request");
    const wrapped = blocks[0].match(/^\n?<<<EXTERNAL_UNTRUSTED_CONTENT id="([a-f0-9]{16})">>>\nSource: External\n---\n([\s\S]*)\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id="\1">>>$/u);
    assert(wrapped, "Extracted bytes must retain the real untrusted-content boundary");
    const actual = wrapped[2];
    const pass = actual === cell.expected;
    if (mode === "baseline" && cell.regression) {
      assert.equal(actual, "Ïðèâåò ˆ", "Baseline must fail for the exact decoding defect, not startup");
    } else { assert.equal(actual, cell.expected); }
    const capture = { mode, name: cell.name, requestPurpose: entry.inferenceFacts.purpose,
      rawRequestSeq: entry.seq, fileBlock: blocks[0], fileContent: actual, expected: cell.expected, pass };
    console.log("BUILT_GATEWAY_MODEL_INPUT " + JSON.stringify(capture));
    captures.push(capture);
    receipts.push({ name: cell.name, status: response.status, pass });
  }
  assert.equal(privateHits, 0, "Blocked URL must never reach its server");
  assert.deepEqual(receipts.filter((receipt) => !receipt.pass).map((receipt) => receipt.name),
    mode === "baseline" ? ["sniffed-declared-charset", "sniffed-quoted-alias"] : []);
  phase = "audited";
  if (mode === "baseline") { process.exitCode = 1; }
} catch (error) {
  failure = { message: error.message, stack: error.stack };
  process.exitCode = 1;
} finally {
  const cleanupErrors = [];
  for (const item of children.toReversed()) {
    if (item.child.exitCode === null && item.child.signalCode === null && item.child.pid) {
      process.kill(-item.child.pid, "SIGTERM");
      const deadline = Date.now() + 20_000;
      while (item.child.exitCode === null && item.child.signalCode === null && Date.now() < deadline) { await delay(100); }
      if (item.child.exitCode === null && item.child.signalCode === null) {
        process.kill(-item.child.pid, "SIGKILL");
        cleanupErrors.push(`${item.label} required forced termination`);
      }
    }
    await item.closed;
    await fs.writeFile(path.join(output, `${item.label}.log`), item.readLog());
  }
  await new Promise((resolve) => { privateServer.close(resolve); privateServer.closeAllConnections(); });
  if (cleanupErrors.length) { phase = "cleanup-failed"; process.exitCode = 1; }
  const report = { mode, phase, node: process.version, scope: "built CLI/Gateway /v1/responses input_file base64 -> real classifier/extractor -> recorded foreground model input; HTTP cache covered separately", receipts, privateHits, failure,
    cleanup: { errors: cleanupErrors, privateServerClosed: !privateServer.listening,
      children: children.map(({ label, child }) => ({ label, exitCode: child.exitCode, signal: child.signalCode })) } };
  await fs.writeFile(path.join(output, "gateway-proof.json"), JSON.stringify(report, null, 2));
  await fs.writeFile(path.join(output, "model-input-captures.json"), JSON.stringify(captures, null, 2));
  console.log(JSON.stringify(report));
}

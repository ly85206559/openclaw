import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createPortReservation } from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";

const mode = process.env.PROOF_MODE;
assert.ok(mode === "baseline" || mode === "candidate", "explicit proof mode required");
const output = process.env.PROOF_OUTPUT_DIR;
assert.ok(output, "proof artifact directory required");
await mkdir(output, { recursive: true });
const root = await mkdtemp(path.join(os.tmpdir(), "web-fetch-json-gateway-"));
const token = randomUUID();
const numericDocument =
  '{"id":9007199254740993,"negative":-9007199254740993,"decimal":0.1234567890123456789,"exponent":1e400,"negativeZero":-0,"nested":[{"id":9223372036854775807}],"string":"9007199254740993","safe":42,"enabled":true,"empty":null}';
const patterns = [
  /"id"\s*:\s*9007199254740993\b/u,
  /"negative"\s*:\s*-9007199254740993\b/u,
  /"decimal"\s*:\s*0\.1234567890123456789\b/u,
  /"exponent"\s*:\s*1e400\b/u,
  /"negativeZero"\s*:\s*-0\s*[,}]/u,
  /"id"\s*:\s*9223372036854775807\b/u,
  /"string"\s*:\s*"9007199254740993"/u,
  /"safe"\s*:\s*42\b/u,
  /"enabled"\s*:\s*true\b/u,
  /"empty"\s*:\s*null\b/u,
];
const fixtures = [
  { route: "/json", type: "application/json", body: numericDocument, extractor: "json", patterns },
  { route: "/vendor-json", type: "application/vnd.example+json; charset=utf-8", body: numericDocument, extractor: "json", patterns },
  { route: "/scalar", type: "application/json", body: "9007199254740993", extractor: "json", patterns: [/(?:^|\n)9007199254740993(?:\n|$)/u] },
  { route: "/array", type: "application/json", body: "[9007199254740993,-0,1e400]", extractor: "json", patterns: [/\[\s*9007199254740993\s*,\s*-0\s*,\s*1e400\s*\]/u] },
  { route: "/invalid", type: "application/json", body: '{"id":9007199254740993', extractor: "raw", patterns: [/"id":9007199254740993/u] },
  { route: "/text", type: "text/plain", body: "record 9007199254740993", extractor: "raw", patterns: [/record 9007199254740993/u] },
];
const receipt = { mode, sourceSha: process.env.SOURCE_SHA, cases: [], controls: [], fixtureCounts: {}, cleanup: {}, errors: [] };
const sanitize = (text) => String(text).replaceAll(token, "[SYNTHETIC_GATEWAY_TOKEN]");
const fixture = createServer((request, response) => {
  const row = fixtures.find(({ route }) => route === request.url);
  if (!row) {
    receipt.errors.push(`unexpected fixture request: ${request.method} ${request.url}`);
    response.writeHead(404).end();
    return;
  }
  receipt.fixtureCounts[row.route] = (receipt.fixtureCounts[row.route] ?? 0) + 1;
  if (request.method !== "GET") receipt.errors.push(`unexpected fixture method: ${request.method}`);
  response.writeHead(200, { "content-type": row.type });
  response.end(row.body);
});
async function listen(server, port = 0) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server.address().port;
}
async function close(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
const fixturePort = await listen(fixture);
const reservation = createPortReservation();
const gatewayPort = await listen(reservation);
const configPath = path.join(root, "state", "openclaw.json");
await mkdir(path.dirname(configPath), { recursive: true });
await mkdir(path.join(root, "workspace"), { recursive: true });
await writeFile(configPath, JSON.stringify({
  gateway: { mode: "local", bind: "loopback", port: gatewayPort, auth: { mode: "token", token }, controlUi: { enabled: false } },
  agents: { defaults: { workspace: path.join(root, "workspace") }, entries: { main: {} } },
  plugins: { enabled: false },
  cron: { enabled: false },
  tools: { allow: ["web_fetch"], web: { search: { enabled: false }, fetch: { enabled: true, cacheTtlMinutes: 0, ssrfPolicy: { allowedHostnames: ["127.0.0.1"] } } } },
}));
const env = {
  ...process.env,
  HOME: root,
  OPENCLAW_HOME: root,
  OPENCLAW_STATE_DIR: path.join(root, "state"),
  OPENCLAW_CONFIG_PATH: configPath,
  OPENCLAW_GATEWAY_TOKEN: "",
  OPENCLAW_GATEWAY_PASSWORD: "",
  OPENCLAW_GATEWAY_URL: "",
  OPENCLAW_GATEWAY_PORT: "",
  OPENCLAW_SKIP_CHANNELS: "1",
  OPENCLAW_SKIP_PROVIDERS: "1",
  OPENCLAW_SKIP_GMAIL_WATCHER: "1",
  OPENCLAW_SKIP_CRON: "1",
  OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
  OPENCLAW_SKIP_CANVAS_HOST: "1",
  GH_TOKEN: "",
  GITHUB_TOKEN: "",
};
delete env.VITEST;
delete env.OPENCLAW_TEST_MINIMAL_GATEWAY;
delete env.OPENCLAW_PROFILE;
let child;
let childExit;
let exited = false;
let stdout = "";
let stderr = "";
function capture(stream, chunk) {
  if (stream === "stdout") stdout += chunk;
  else stderr += chunk;
}
async function invoke(input, authenticated = true) {
  const response = await fetch(`http://127.0.0.1:${gatewayPort}/tools/invoke`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(authenticated ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(30_000),
  });
  const raw = await response.text();
  return { status: response.status, raw, body: JSON.parse(raw) };
}
try {
  await close(reservation);
  child = spawn("pnpm", ["openclaw", "gateway", "run", "--port", String(gatewayPort), "--bind", "loopback"], { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (chunk) => capture("stdout", chunk.toString()));
  child.stderr.on("data", (chunk) => capture("stderr", chunk.toString()));
  childExit = new Promise((resolve) => {
    child.once("error", (error) => { exited = true; resolve({ error: error.message }); });
    child.once("exit", () => { exited = true; });
    // CLI wrappers forward shutdown to their detached descendants; inherited pipes join that lifetime.
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const deadline = Date.now() + 120_000;
  let ready = false;
  while (Date.now() < deadline && !exited) {
    try {
      const response = await fetch(`http://127.0.0.1:${gatewayPort}/readyz`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(2_000) });
      const raw = await response.text();
      if (response.status === 200 && JSON.parse(raw).ready === true) { receipt.readiness = { status: response.status, raw }; ready = true; break; }
    } catch { /* The sole owned Gateway is still starting; never rerun an invocation. */ }
    await delay(100);
  }
  assert.ok(ready, "supported Gateway did not become ready within the bounded startup budget");
  const unauthorized = await invoke({ tool: "web_fetch", args: { url: `http://127.0.0.1:${fixturePort}/json` } }, false);
  receipt.controls.push({ name: "missing-bearer", ...unauthorized });
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.body.error.type, "unauthorized");
  const unknown = await invoke({ tool: "json-fidelity-nonexistent-tool", args: {}, sessionKey: "main" });
  receipt.controls.push({ name: "unknown-tool", ...unknown });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.ok, false);
  assert.equal(unknown.body.error.type, "not_found");
  for (const row of fixtures) {
    const response = await invoke({ tool: "web_fetch", args: { url: `http://127.0.0.1:${fixturePort}${row.route}`, extractMode: "text", maxChars: 20_000 }, sessionKey: "main" });
    const result = response.body.result;
    assert.equal(response.status, 200, row.route);
    assert.equal(response.body.ok, true, row.route);
    assert.notEqual(result.isError, true, row.route);
    assert.equal(result.details.status, 200, row.route);
    assert.equal(result.details.extractor, row.extractor, row.route);
    assert.equal(result.details.truncated, false, row.route);
    assert.equal(typeof result.details.text, "string", row.route);
    const textBlock = result.content.find((block) => block.type === "text");
    assert.ok(textBlock, row.route);
    // Parse only the tool envelope. Parsing the source document would corrupt the numeric oracle.
    const modelEnvelope = JSON.parse(textBlock.text);
    assert.equal(modelEnvelope.text, result.details.text, row.route);
    assert.equal(modelEnvelope.status, 200, row.route);
    assert.equal(modelEnvelope.extractor, row.extractor, row.route);
    assert.equal(modelEnvelope.truncated, false, row.route);
    if (mode === "candidate" || row.extractor === "raw") assert.ok(result.details.text.includes(row.body), `${row.route}: source text must remain verbatim`);
    const failedPatterns = row.patterns.filter((pattern) => !pattern.test(result.details.text)).map(String);
    receipt.cases.push({ route: row.route, fixtureBody: row.body, status: response.status, extractor: result.details.extractor, fidelityPassed: failedPatterns.length === 0, failedPatterns, rawResponse: response.raw });
  }
  const failed = receipt.cases.filter((row) => !row.fidelityPassed).map((row) => row.route);
  assert.deepEqual(failed, mode === "baseline" ? ["/json", "/vendor-json", "/scalar", "/array"] : []);
  for (const row of fixtures) assert.equal(receipt.fixtureCounts[row.route], 1, row.route);
  assert.equal(receipt.errors.length, 0);
  receipt.expectedResultVerified = true;
} catch (error) {
  receipt.errors.push(sanitize(error.stack ?? error));
} finally {
  if (child?.pid && childExit) {
    try { process.kill(-child.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") receipt.errors.push(`SIGTERM: ${error.message}`); }
    const groupAlive = () => {
      try { process.kill(-child.pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; }
    };
    let cleanupDeadline = Date.now() + 15_000;
    let exit = await Promise.race([childExit, delay(15_000, undefined, { ref: false }).then(() => undefined)]);
    while (groupAlive() && Date.now() < cleanupDeadline) await delay(100);
    if (!exit || groupAlive()) {
      receipt.cleanup.forcedKill = true;
      try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") receipt.errors.push(`SIGKILL: ${error.message}`); }
      cleanupDeadline = Date.now() + 5_000;
      exit = await Promise.race([childExit, delay(5_000, undefined, { ref: false }).then(() => undefined)]);
      while (groupAlive() && Date.now() < cleanupDeadline) await delay(100);
      receipt.errors.push("Gateway required forced process-group cleanup");
    }
    receipt.cleanup.childExit = exit ?? { timedOut: true };
    receipt.cleanup.processGroupGone = !groupAlive();
    if (!exit || !receipt.cleanup.processGroupGone) receipt.errors.push("Gateway process group did not settle");
  }
  fixture.closeAllConnections();
  try { await close(fixture); receipt.cleanup.fixtureClosed = true; } catch (error) { receipt.errors.push(`fixture close: ${error.message}`); }
  if (reservation.listening) await close(reservation);
  for (const port of [gatewayPort, fixturePort]) {
    const probe = createPortReservation();
    try { await listen(probe, port); await close(probe); } catch (error) { receipt.errors.push(`owned port ${port} still listening: ${error.message}`); }
  }
  receipt.cleanup.noOwnedListeners = receipt.errors.every((error) => !error.startsWith("owned port "));
  await writeFile(path.join(output, "gateway.stdout.log"), sanitize(stdout));
  await writeFile(path.join(output, "gateway.stderr.log"), sanitize(stderr));
  await writeFile(path.join(output, "receipt.json"), sanitize(JSON.stringify(receipt, null, 2)));
}
assert.equal(receipt.errors.length, 0, JSON.stringify(receipt.errors));
assert.equal(receipt.expectedResultVerified, true);
console.log(JSON.stringify({ mode, sourceSha: receipt.sourceSha, cases: receipt.cases.length, fidelityPassed: receipt.cases.filter((row) => row.fidelityPassed).length, expectedBaselineFailures: mode === "baseline" ? 4 : 0, controls: receipt.controls.length, cleanup: receipt.cleanup }));

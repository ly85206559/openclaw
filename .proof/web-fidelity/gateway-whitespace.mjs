import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as reservePort } from "node:net";
import os from "node:os";
import path from "node:path";

assert.equal(process.env.GITHUB_ACTIONS, "true");
assert.equal(process.platform, "linux");
const mode = process.env.PROOF_MODE;
assert.ok(mode === "baseline" || mode === "candidate");
const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
assert.equal(sourceSha, process.env.SOURCE_SHA);
const output = process.env.PROOF_OUTPUT_DIR;
assert.ok(output);
await mkdir(output, { recursive: true });
const buildStamp = JSON.parse(await readFile("dist/.buildstamp", "utf8"));
assert.equal(buildStamp.head, sourceSha);
assert.equal(buildStamp.inputsClean, true);
const entrySha256 = createHash("sha256").update(await readFile("dist/entry.js")).digest("hex");
const root = await mkdtemp(path.join(os.tmpdir(), "web-whitespace-gateway-"));
const token = randomUUID();
const code = '    if enabled:\n        print("two  spaces")\n\n\n\treturn True';
const fixtures = [
  {
    route: "/closed",
    body: `# Example\n\n- Read [the guide](https://example.test/guide).\n\n\`\`\`python\n${code}\n\`\`\`\n\n## After\n\n- done`,
    expected: 'Example\n\nRead the guide.\n\n    if enabled:\n        print("two  spaces")\n\n\n\treturn True\n\nAfter\n\ndone',
  },
  {
    route: "/unclosed",
    body: `\`\`\`python\n${code}`,
    expected: '    if enabled:\n        print("two  spaces")\n\n\n\treturn True',
  },
  {
    route: "/prose",
    body: "# Notes\n\nRead  [the guide](https://example.test/guide).\n\n\n- one\n- two\n\n1. first\n2. second",
    expected: "Notes\n\nRead the guide.\n\none\ntwo\n\nfirst\nsecond",
  },
  {
    route: "/inline",
    body: "Use ``` to start a code block.\nNext paragraph.",
    expected: "Use ``` to start a code block.\nNext paragraph.",
  },
];
const receipt = {
  mode, sourceSha, buildStamp, entrySha256,
  cases: [], controls: [], wire: [], fixtureCounts: {}, cleanup: {}, errors: [],
  limits: "Canonical qaRuntime build and supported CLI/Gateway; no release package, UI, model, vendor, or public website proof.",
};
const sanitize = (value) => String(value)
  .replaceAll(token, "[SYNTHETIC_TOKEN]")
  .replaceAll("127.0.0.1", "[LOOPBACK]")
  .replace(/\[gateway\] agent model:[^\r\n]*/gu, "[gateway] agent model: [NOT_INVOKED]");
const fixture = createServer((request, response) => {
  const row = fixtures.find(({ route }) => route === request.url);
  if (!row || request.method !== "GET") {
    receipt.errors.push(`Unexpected fixture request ${request.method} ${request.url}`);
    response.writeHead(404).end();
    return;
  }
  receipt.fixtureCounts[row.route] = (receipt.fixtureCounts[row.route] ?? 0) + 1;
  receipt.wire.push({
    route: row.route, method: request.method,
    contentType: "text/markdown; charset=utf-8",
    bodySha256: createHash("sha256").update(row.body).digest("hex"),
  });
  response.writeHead(200, { "content-type": "text/markdown; charset=utf-8" });
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
async function bounded(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function joinProcessGroup(pid, deadline) {
  const started = Date.now();
  while (true) {
    try { process.kill(-pid, 0); }
    catch (error) {
      if (error.code === "ESRCH") return Date.now() - started;
      throw error;
    }
    if (Date.now() >= deadline) throw new Error("Gateway process group did not exit within shutdown budget");
    await new Promise((resolve) => setTimeout(resolve, Math.min(50, deadline - Date.now())));
  }
}
let fixturePort;
let gatewayPort;
let child;
let childClosed;
let stdout = "";
let stderr = "";
const reservation = reservePort();
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
function extracted(response, extractMode) {
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  const result = response.body.result;
  assert.notEqual(result.isError, true);
  assert.equal(result.details.status, 200);
  assert.equal(result.details.extractor, "cf-markdown");
  assert.equal(result.details.extractMode, extractMode);
  assert.equal(result.details.truncated, false);
  assert.equal(result.details.cached, undefined);
  assert.match(result.details.contentType, /^text\/markdown(?:;|$)/u);
  const block = result.content.find((item) => item.type === "text");
  assert.ok(block);
  const envelope = JSON.parse(block.text);
  assert.equal(envelope.text, result.details.text);
  assert.equal(envelope.status, 200);
  assert.equal(envelope.extractor, "cf-markdown");
  assert.equal(envelope.extractMode, extractMode);
  assert.equal(envelope.truncated, false);
  const match = result.details.text.match(/<<<EXTERNAL_UNTRUSTED_CONTENT id="([a-f0-9]{16})">>>\nSource: Web Fetch\n---\n([\s\S]*)\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id="\1">>>$/u);
  assert.ok(match, "Complete matching untrusted-content wrapper required");
  return match[2];
}
try {
  fixturePort = await listen(fixture);
  gatewayPort = await listen(reservation);
  const configPath = path.join(root, "state", "openclaw.json");
  await mkdir(path.dirname(configPath), { recursive: true });
  await mkdir(path.join(root, "workspace"), { recursive: true });
  await writeFile(configPath, JSON.stringify({
    gateway: { mode: "local", bind: "loopback", port: gatewayPort, auth: { mode: "token", token }, controlUi: { enabled: false } },
    agents: { defaults: { workspace: path.join(root, "workspace") }, entries: { main: {} } },
    plugins: { enabled: false }, cron: { enabled: false },
    tools: { allow: ["web_fetch"], web: { search: { enabled: false }, fetch: { enabled: true, cacheTtlMinutes: 0, ssrfPolicy: { allowedHostnames: ["127.0.0.1"] } } } },
  }));
  const env = {
    PATH: process.env.PATH, CI: "true", GITHUB_ACTIONS: "true", LANG: "C.UTF-8", TERM: "dumb", NO_COLOR: "1",
    HOME: root, OPENCLAW_HOME: root, XDG_CONFIG_HOME: path.join(root, "config"), XDG_CACHE_HOME: path.join(root, "cache"),
    OPENCLAW_STATE_DIR: path.join(root, "state"), OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_SKIP_CHANNELS: "1", OPENCLAW_SKIP_PROVIDERS: "1", OPENCLAW_SKIP_GMAIL_WATCHER: "1",
    OPENCLAW_SKIP_CRON: "1", OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1", OPENCLAW_SKIP_CANVAS_HOST: "1",
  };
  await close(reservation);
  let signalReady;
  const readyLog = new Promise((resolve) => { signalReady = resolve; });
  child = spawn("pnpm", ["openclaw", "gateway", "run", "--port", String(gatewayPort), "--bind", "loopback"], {
    env, detached: true, stdio: ["ignore", "pipe", "pipe"],
  });
  const capture = (stream, chunk) => {
    if (stream === "stdout") stdout += chunk.toString();
    else stderr += chunk.toString();
    if (/\[gateway\] ready(?:\r?\n|$)/u.test(`${stdout}\n${stderr}`)) signalReady();
  };
  child.stdout.on("data", (chunk) => capture("stdout", chunk));
  child.stderr.on("data", (chunk) => capture("stderr", chunk));
  childClosed = new Promise((resolve) => {
    child.once("error", (error) => resolve({ error: error.message }));
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  await bounded(Promise.race([
    readyLog,
    childClosed.then((exit) => { throw new Error(`Gateway closed before readiness: ${JSON.stringify(exit)}`); }),
  ]), 120_000, "Gateway startup budget exhausted");
  const readiness = await fetch(`http://127.0.0.1:${gatewayPort}/readyz`, {
    headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5_000),
  });
  const readyRaw = await readiness.text();
  receipt.readiness = { status: readiness.status, raw: readyRaw };
  assert.equal(readiness.status, 200);
  assert.equal(JSON.parse(readyRaw).ready, true);
  const unauthorized = await invoke({ tool: "web_fetch", args: { url: `http://127.0.0.1:${fixturePort}/closed` } }, false);
  receipt.controls.push({ name: "missing-bearer", ...unauthorized });
  assert.equal(unauthorized.status, 401);
  const unknown = await invoke({ tool: "web-whitespace-nonexistent", args: {}, sessionKey: "main" });
  receipt.controls.push({ name: "unknown-tool", ...unknown });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.ok, false);
  assert.equal(unknown.body.error.type, "not_found");
  assert.deepEqual(receipt.fixtureCounts, {});
  for (const row of fixtures) {
    const response = await invoke({ tool: "web_fetch", args: { url: `http://127.0.0.1:${fixturePort}${row.route}`, extractMode: "text", maxChars: 20_000 }, sessionKey: "main" });
    const observation = { route: row.route, fixtureBody: row.body, expectedText: row.expected, rawResponse: response.raw };
    receipt.cases.push(observation);
    observation.actualText = extracted(response, "text");
    observation.passed = observation.actualText === row.expected;
  }
  for (const row of fixtures.slice(0, 2)) {
    const response = await invoke({ tool: "web_fetch", args: { url: `http://127.0.0.1:${fixturePort}${row.route}`, extractMode: "markdown", maxChars: 20_000 }, sessionKey: "main" });
    const actualText = extracted(response, "markdown");
    receipt.controls.push({ name: `markdown-mode${row.route}`, rawResponse: response.raw, actualText });
    assert.equal(actualText, row.body);
  }
  for (const row of fixtures) assert.equal(receipt.fixtureCounts[row.route], ["/closed", "/unclosed"].includes(row.route) ? 2 : 1);
  assert.equal(receipt.wire.length, 6);
  const failed = receipt.cases.filter((row) => !row.passed).map((row) => row.route);
  receipt.behaviorFailures = failed;
  if (mode === "baseline") {
    assert.deepEqual(failed, ["/closed", "/unclosed"]);
    receipt.expectedBaselineReproduced = true;
  }
  assert.equal(createHash("sha256").update(await readFile("dist/entry.js")).digest("hex"), entrySha256);
} catch (error) {
  receipt.errors.push(sanitize(error.stack ?? error));
} finally {
  if (child?.pid && childClosed) {
    const shutdownDeadline = Date.now() + 15_000;
    try { process.kill(-child.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") receipt.errors.push(error.message); }
    try {
      receipt.cleanup.childExit = await bounded(childClosed, Math.max(1, shutdownDeadline - Date.now()), "Gateway shutdown did not join");
      receipt.cleanup.processGroupWaitMs = await joinProcessGroup(child.pid, shutdownDeadline);
    }
    catch (error) {
      receipt.errors.push(error.message);
      receipt.cleanup.forcedKill = true;
      try { process.kill(-child.pid, "SIGKILL"); } catch (killError) { if (killError.code !== "ESRCH") receipt.errors.push(killError.message); }
      try { receipt.cleanup.childExit = await bounded(childClosed, 5_000, "Forced cleanup did not join"); }
      catch (joinError) { receipt.errors.push(joinError.message); }
    }
    try { process.kill(-child.pid, 0); receipt.errors.push("Gateway process group remains after shutdown"); }
    catch (error) { if (error.code === "ESRCH") receipt.cleanup.processGroupGone = true; else receipt.errors.push(error.message); }
    const exit = receipt.cleanup.childExit;
    if (exit?.error || !(exit?.signal === "SIGTERM" || [0, 143].includes(exit?.code))) receipt.errors.push(`Unexpected Gateway exit: ${JSON.stringify(exit)}`);
  }
  fixture.closeAllConnections();
  if (fixture.listening) {
    try { await close(fixture); receipt.cleanup.fixtureClosed = true; }
    catch (error) { receipt.errors.push(error.message); }
  }
  if (reservation.listening) await close(reservation);
  receipt.cleanup.noOwnedListeners = true;
  for (const port of [gatewayPort, fixturePort].filter((value) => value !== undefined)) {
    const probe = reservePort();
    try { await listen(probe, port); await close(probe); }
    catch (error) { receipt.cleanup.noOwnedListeners = false; receipt.errors.push(error.message); }
  }
  await writeFile(path.join(output, "gateway.stdout.log"), sanitize(stdout));
  await writeFile(path.join(output, "gateway.stderr.log"), sanitize(stderr));
  await writeFile(path.join(output, "receipt.json"), sanitize(JSON.stringify(receipt, null, 2)));
}
assert.equal(receipt.errors.length, 0, JSON.stringify(receipt.errors));
assert.deepEqual(receipt.behaviorFailures, [], "Observed original whitespace corruption; baseline remains a real failed run");
console.log(JSON.stringify({ mode, sourceSha, cases: receipt.cases.length, controls: receipt.controls.length, cleanup: receipt.cleanup }));

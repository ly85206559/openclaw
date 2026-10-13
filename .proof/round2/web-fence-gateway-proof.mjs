// Proof-only runner. Execute exclusively in reviewed secretless Linux Actions.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createPortReservation } from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

assert.equal(process.env.GITHUB_ACTIONS, "true", "secretless GitHub Actions only");
assert.equal(process.platform, "linux", "owned Linux process-group cleanup required");
const mode = process.env.PROOF_MODE;
assert.ok(mode === "baseline" || mode === "candidate", "explicit proof mode required");
const output = process.env.PROOF_OUTPUT_DIR;
assert.ok(output, "proof artifact directory required");
const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
assert.equal(sourceSha, process.env.SOURCE_SHA, "proof must use the declared checked-out source");
await mkdir(output, { recursive: true });
const root = await mkdtemp(path.join(os.tmpdir(), "web-fence-gateway-"));
const token = randomUUID();
const fixtures = [
  {
    route: "/tilde",
    body: "# Example\n\n~~~text\n# comment\n- literal\n1. literal\n[label](https://example.test/path)\n![alt](image.png)\n`value`\n~~~\n\n## After\n\n- done",
    expected: "Example\n\n# comment\n- literal\n1. literal\n[label](https://example.test/path)\n![alt](image.png)\n`value`\n\nAfter\n\ndone",
  },
  {
    route: "/long-backtick",
    body: "# Example\n\n````md\n# before\n```\n# after\n````\n\n## After",
    expected: "Example\n\n# before\n```\n# after\n\nAfter",
  },
  {
    route: "/trailing-text",
    body: "# Example\n\n```md\n# before\n``` not a close\n# after\n```\n\n## After",
    expected: "Example\n\n# before\n``` not a close\n# after\n\nAfter",
  },
  {
    route: "/unclosed",
    body: "# Example\n\n```md\n# comment\n- literal\n[label](https://example.test/path)\n`value`",
    expected: "Example\n\n# comment\n- literal\n[label](https://example.test/path)\n`value`",
  },
  {
    route: "/triple-control",
    body: "# Example\n\n```text\n# comment\n- literal\n[label](https://example.test/path)\n`value`\n```\n\n## After",
    expected: "Example\n\n# comment\n- literal\n[label](https://example.test/path)\n`value`\n\nAfter",
  },
  {
    route: "/prose-control",
    body: "# Example\n\nRead [the guide](https://example.test/path).\n\n- one\n- two\n\n## Steps\n\n1. first\n2. second",
    expected: "Example\n\nRead the guide.\n\none\ntwo\n\nSteps\n\nfirst\nsecond",
  },
  { route: "/inline-control", body: "```x```", expected: "x" },
  {
    route: "/inline-fence-prose-control",
    body: "Use ``` to start a code block.\nNext paragraph.",
    expected: "Use ``` to start a code block.\nNext paragraph.",
  },
];
const selectedFixtures = fixtures.filter(({ route }) => mode === "baseline"
  ? !["/inline-control", "/inline-fence-prose-control"].includes(route)
  : !["/tilde", "/long-backtick", "/trailing-text"].includes(route));
const markdownFixture = mode === "candidate"
  ? fixtures.find(({ route }) => route === "/unclosed")
  : fixtures[0];
assert.ok(markdownFixture);
const receipt = {
  mode, sourceSha, cases: [], controls: [], wire: [], fixtureCounts: {}, cleanup: {}, errors: [],
  limits: "Candidate text proof covers EOF and existing triple/inline/prose controls only; broader fence grammar is not repaired. No provider, model, browser, or vendor behavior is claimed.",
};
const sanitize = (value) => String(value)
  .replaceAll(token, "[SYNTHETIC_GATEWAY_TOKEN]")
  .replace(/\[gateway\] agent model:[^\r\n]*/gu, "[gateway] [configured model omitted]");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const fixture = createServer((request, response) => {
  const row = fixtures.find(({ route }) => route === request.url);
  if (!row || request.method !== "GET") {
    receipt.errors.push(`unexpected fixture request: ${request.method} ${request.url}`);
    response.writeHead(404).end();
    return;
  }
  receipt.fixtureCounts[row.route] = (receipt.fixtureCounts[row.route] ?? 0) + 1;
  receipt.wire.push({
    method: request.method, route: row.route, accept: request.headers.accept,
    responseContentType: "text/markdown; charset=utf-8",
    responseBytes: Buffer.byteLength(row.body), responseSha256: sha256(row.body),
  });
  response.writeHead(200, {
    "content-type": "text/markdown; charset=utf-8",
    "content-length": Buffer.byteLength(row.body),
  });
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
// Timers are bounded failure watchdogs, never sleeps, polling, or invocation retries.
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
function unwrap(text) {
  const match = text.match(/<<<EXTERNAL_UNTRUSTED_CONTENT id="([a-f0-9]{16})">>>\nSource: Web Fetch\n---\n([\s\S]*)\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id="\1">>>$/u);
  assert.ok(match, "complete matching untrusted-content wrapper required");
  return match[2];
}
let fixturePort;
let gatewayPort;
let child;
let childClosed;
let managedRun;
let terminateManagedChild;
let hasUnjoinedWork;
const outputClosed = { stdout: false, stderr: false };
let stdout = "";
let stderr = "";
const reservation = createPortReservation();
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
  assert.match(result.details.contentType, /^text\/markdown(?:;|$)/u);
  assert.equal(result.details.cached, undefined);
  const textBlock = result.content.find((block) => block.type === "text");
  assert.ok(textBlock, "model-facing tool envelope required");
  const envelope = JSON.parse(textBlock.text);
  assert.equal(envelope.text, result.details.text);
  assert.equal(envelope.status, 200);
  assert.equal(envelope.extractor, "cf-markdown");
  assert.equal(envelope.extractMode, extractMode);
  assert.equal(envelope.truncated, false);
  return unwrap(result.details.text);
}
try {
  const { runManagedCommand, ...managed } = await import(pathToFileURL(path.join(process.cwd(), "scripts/lib/managed-child-process.mts")));
  ({ terminateManagedChild, hasUnjoinedWork } = managed);
  fixturePort = await listen(fixture);
  gatewayPort = await listen(reservation);
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
  // Whitelist runtime essentials; no inherited provider, GitHub, proxy, or real operator credentials.
  const env = {
    PATH: process.env.PATH,
    CI: "true", GITHUB_ACTIONS: "true", LANG: "C.UTF-8", TERM: "dumb", NO_COLOR: "1",
    HOME: root, OPENCLAW_HOME: root, XDG_CONFIG_HOME: path.join(root, "config"), XDG_CACHE_HOME: path.join(root, "cache"),
    OPENCLAW_STATE_DIR: path.join(root, "state"), OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_SKIP_CHANNELS: "1", OPENCLAW_SKIP_PROVIDERS: "1", OPENCLAW_SKIP_GMAIL_WATCHER: "1",
    OPENCLAW_SKIP_CRON: "1", OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1", OPENCLAW_SKIP_CANVAS_HOST: "1",
  };
  await close(reservation);
  let signalReady;
  const readyLog = new Promise((resolve) => { signalReady = resolve; });
  const capture = (stream, chunk) => {
    if (stream === "stdout") stdout += chunk.toString();
    else stderr += chunk.toString();
    if (/\[gateway\] ready(?:\r?\n|$)/u.test(`${stdout}\n${stderr}`)) signalReady();
  };
  let signalStarted;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  managedRun = runManagedCommand({
    bin: "pnpm",
    args: ["openclaw", "gateway", "run", "--port", String(gatewayPort), "--bind", "loopback"],
    cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"], shell: false,
    requireProcessTreeExit: true, waitForCleanupRelease: true,
    onReady(ownedChild) {
      child = ownedChild;
      for (const [name, stream] of [["stdout", child.stdout], ["stderr", child.stderr]]) {
        stream.on("data", (chunk) => capture(name, chunk));
        stream.once("close", () => { outputClosed[name] = true; });
      }
      childClosed = new Promise((resolve) => {
        child.once("error", (error) => resolve({ error: error.message }));
        child.once("close", (code, signal) => resolve({ code, signal }));
      });
      signalStarted();
    },
  }).then(
    (exitCode) => ({ exitCode }),
    (error) => ({ error }),
  );
  await Promise.race([
    started,
    managedRun.then((result) => { throw new Error(`Gateway did not start: ${sanitize(result.error?.stack ?? JSON.stringify(result))}`); }),
  ]);
  await bounded(Promise.race([
    readyLog,
    managedRun.then((result) => { throw new Error(`Gateway finished before readiness: ${sanitize(result.error?.stack ?? JSON.stringify(result))}`); }),
  ]), 120_000, "Gateway did not publish readiness within the startup budget");
  const readiness = await fetch(`http://127.0.0.1:${gatewayPort}/readyz`, {
    headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5_000),
  });
  const readyRaw = await readiness.text();
  receipt.readiness = { status: readiness.status, raw: readyRaw };
  assert.equal(readiness.status, 200);
  assert.equal(JSON.parse(readyRaw).ready, true);

  const unauthorized = await invoke({ tool: "web_fetch", args: { url: `http://127.0.0.1:${fixturePort}/tilde` } }, false);
  receipt.controls.push({ name: "missing-bearer", ...unauthorized });
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.body.error.type, "unauthorized");
  const unknown = await invoke({ tool: "web-fence-nonexistent-tool", args: {}, sessionKey: "main" });
  receipt.controls.push({ name: "unknown-tool", ...unknown });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.ok, false);
  assert.equal(unknown.body.error.type, "not_found");
  assert.deepEqual(receipt.fixtureCounts, {}, "entry controls must not reach the content server");
  for (const row of selectedFixtures) {
    const response = await invoke({ tool: "web_fetch", args: { url: `http://127.0.0.1:${fixturePort}${row.route}`, extractMode: "text", maxChars: 20_000 }, sessionKey: "main" });
    const observation = { route: row.route, fixtureBody: row.body, expectedText: row.expected, rawResponse: response.raw };
    receipt.cases.push(observation);
    observation.actualText = extracted(response, "text");
    observation.passed = observation.actualText === row.expected;
    observation.failureReason = observation.passed ? null : "literal fence content or surrounding prose differs from independent expected text";
  }
  const markdown = await invoke({ tool: "web_fetch", args: { url: `http://127.0.0.1:${fixturePort}${markdownFixture.route}`, extractMode: "markdown", maxChars: 20_000 }, sessionKey: "main" });
  receipt.controls.push({ name: "markdown-mode", rawResponse: markdown.raw });
  assert.equal(extracted(markdown, "markdown"), markdownFixture.body, "Markdown mode must preserve the response");
  const failed = receipt.cases.filter((row) => !row.passed).map((row) => row.route);
  assert.deepEqual(failed, mode === "baseline" ? ["/tilde", "/long-backtick", "/trailing-text", "/unclosed"] : []);
  for (const row of selectedFixtures) assert.equal(receipt.fixtureCounts[row.route], row.route === markdownFixture.route ? 2 : 1, row.route);
  assert.equal(receipt.wire.length, selectedFixtures.length + 1);
  assert.equal(receipt.errors.length, 0);
  receipt.expectedResultVerified = true;
} catch (error) {
  receipt.errors.push(sanitize(error.stack ?? error));
} finally {
  receipt.cleanup.owner = "scripts/lib/managed-child-process.mts:runManagedCommand";
  receipt.cleanup.scope = "Managed wrapper group, output closure, acknowledged cleanup handoff and observed listener release; independent detached descendants are not globally enumerated.";
  if (managedRun) {
    try {
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        receipt.cleanup.stopRequested = "SIGTERM";
        const termination = terminateManagedChild(child, "SIGTERM");
        if (termination?.error) receipt.errors.push(sanitize(termination.error.stack ?? termination.error));
      }
      const result = await managedRun;
      receipt.cleanup.managedExitCode = result.exitCode;
      receipt.cleanup.outputClosed = outputClosed;
      if (result.error) {
        receipt.cleanup.managedError = {
          message: sanitize(result.error.message), code: result.error.code,
          processTreeState: result.error.processTreeState, unjoinedWork: hasUnjoinedWork(result.error),
        };
        throw result.error;
      }
      receipt.cleanup.childExit = childClosed ? await childClosed : undefined;
      assert.equal(receipt.cleanup.stopRequested, "SIGTERM", "Gateway exited before intentional cleanup");
      assert.equal(result.exitCode, 143, "intentional Gateway SIGTERM must be reported");
      assert.deepEqual(receipt.cleanup.childExit, { code: null, signal: "SIGTERM" });
      assert.deepEqual(outputClosed, { stdout: true, stderr: true });
      receipt.cleanup.completed = true;
    } catch (error) {
      receipt.cleanup.completed = false;
      receipt.errors.push(sanitize(error.stack ?? error));
    }
  }
  fixture.closeAllConnections();
  if (fixture.listening) {
    try { await close(fixture); receipt.cleanup.fixtureClosed = true; } catch (error) { receipt.errors.push(`fixture close: ${error.message}`); }
  }
  if (reservation.listening) await close(reservation);
  receipt.cleanup.noOwnedListeners = true;
  for (const port of [gatewayPort, fixturePort].filter((value) => value !== undefined)) {
    const probe = createPortReservation();
    try { await listen(probe, port); await close(probe); } catch (error) {
      receipt.cleanup.noOwnedListeners = false;
      receipt.errors.push(`owned port ${port} still listening: ${error.message}`);
    }
  }
  await writeFile(path.join(output, "gateway.stdout.log"), sanitize(stdout));
  await writeFile(path.join(output, "gateway.stderr.log"), sanitize(stderr));
  await writeFile(path.join(output, "receipt.json"), sanitize(JSON.stringify(receipt, null, 2)));
}
assert.equal(receipt.errors.length, 0, JSON.stringify(receipt.errors));
assert.equal(receipt.expectedResultVerified, true);
console.log(JSON.stringify({
  mode, sourceSha, cases: receipt.cases.length, passed: receipt.cases.filter((row) => row.passed).length,
  expectedBaselineFailures: mode === "baseline" ? 4 : 0, controls: receipt.controls.length, cleanup: receipt.cleanup,
}));

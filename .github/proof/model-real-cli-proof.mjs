// Run only in a secretless Linux fork Actions job with installed workspace dependencies.
// Usage: node model-real-cli-proof.mjs baseline|fixed <evidence-directory>
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";

const [expectation, evidenceArgument] = process.argv.slice(2);
assert.ok(["baseline", "fixed"].includes(expectation), "Select baseline or fixed explicitly");
assert.ok(process.env.RUNNER_TEMP, "This proof requires the isolated Actions runner");
assert.equal(process.platform, "linux");
assert.ok(evidenceArgument, "Provide a task-owned evidence directory");
const evidenceDirectory = path.resolve(evidenceArgument);
await mkdir(evidenceDirectory, { recursive: true });
const root = await mkdtemp(path.join(process.env.RUNNER_TEMP, "model-cli-proof-"));
const stateDirectory = path.join(root, "state");
const proofHome = path.join(root, "home");
const configPath = path.join(stateDirectory, "openclaw.json");
await Promise.all([mkdir(stateDirectory), mkdir(proofHome), mkdir(path.join(root, "workspace"))]);

const cases = [
  { name: "partial-eof", finish: null, text: "partial-answer-before-stream-failure" },
  { name: "stop", finish: "stop", text: "complete-stop-answer" },
  { name: "length", finish: "length", text: "valid-length-limited-answer" },
];
const requests = [];
const fixtureErrors = [];
const server = http.createServer(async (request, response) => {
  try {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/chat/completions");
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    assert.equal(body.model, "proof-fixture");
    assert.equal(body.stream, true);
    const prompt = body.messages.find((message) => message.role === "user")?.content;
    const scenario = cases.find((candidate) => prompt === `PROOF:${candidate.name}`);
    assert.ok(scenario, "The fixture accepts only synthetic proof prompts");
    requests.push({ scenario: scenario.name, path: request.url, body });
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const event = (delta, finishReason) => ({
      id: `chatcmpl-proof-${scenario.name}`,
      object: "chat.completion.chunk",
      created: 1,
      model: "proof-fixture",
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    });
    response.write(`data: ${JSON.stringify(event({ role: "assistant", content: scenario.text }, null))}\n\n`);
    if (scenario.finish !== null) {
      response.write(`data: ${JSON.stringify(event({}, scenario.finish))}\n\n`);
      response.write("data: [DONE]\n\n");
    }
    // A clean HTTP EOF without finish_reason reaches the real transport's terminal error.
    // No socket fault, injected exception, loader override, or production test seam is used.
    response.end();
  } catch (error) {
    fixtureErrors.push(String(error));
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "Synthetic proof fixture rejected request" } }));
  }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert.ok(address && typeof address === "object");
await writeFile(configPath, JSON.stringify({
  agents: {
    defaults: { workspace: path.join(root, "workspace"), model: { primary: "proof/proof-fixture" } },
    entries: { main: {} },
  },
  models: {
    mode: "replace",
    catalogRefresh: { enabled: false },
    providers: {
      proof: {
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        api: "openai-completions",
        apiKey: "synthetic-loopback-proof-key-not-a-credential",
        models: [{
          id: "proof-fixture", name: "Synthetic proof fixture", reasoning: false,
          input: ["text"], contextWindow: 4096, maxTokens: 128,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        }],
      },
    },
  },
}), { mode: 0o600 });

// Explicit environment prevents inherited GitHub/provider credentials or user config.
const childEnvironment = {
  PATH: process.env.PATH,
  HOME: proofHome,
  OPENCLAW_HOME: proofHome,
  OPENCLAW_STATE_DIR: stateDirectory,
  OPENCLAW_CONFIG_PATH: configPath,
  CI: "true",
  NO_COLOR: "1",
};

function jsonObjects(text) {
  const values = [];
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (start < 0) {
      if (character === "{") { start = index; depth = 1; }
      continue;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "{") depth++;
    else if (character === "}" && --depth === 0) {
      try { values.push(JSON.parse(text.slice(start, index + 1))); } catch { /* Wrapper logs are not envelopes. */ }
      start = -1;
    }
  }
  return values;
}

async function runScenario(scenario) {
  const args = ["openclaw", "infer", "model", "run", "--local", "--agent", "main",
    "--model", "proof/proof-fixture", "--prompt", `PROOF:${scenario.name}`, "--json"];
  const started = performance.now();
  const child = spawn("pnpm", args, {
    cwd: process.cwd(), env: childEnvironment, stdio: ["ignore", "pipe", "pipe"],
    // Linux setsid makes this PID the task-owned process-group ID, including wrapper descendants.
    detached: true,
  });
  const ownedGroupId = child.pid;
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (text) => { stdout += text; });
  child.stderr.on("data", (text) => { stderr += text; });
  let timedOut = false;
  let closeObserved = false;
  let forcedClose = false;
  let spawnError;
  const cleanupErrors = [];
  let timeout;
  let cleanupTimeout;
  let code;
  let signal;
  const close = new Promise((resolve) => {
    child.on("error", (error) => { spawnError = String(error); });
    child.once("close", (exitCode, exitSignal) => {
      closeObserved = true;
      resolve([exitCode, exitSignal]);
    });
    timeout = setTimeout(() => {
      timedOut = true;
      if (ownedGroupId !== undefined) {
        try { process.kill(-ownedGroupId, "SIGKILL"); } catch (error) {
          if (error.code !== "ESRCH") cleanupErrors.push(String(error));
        }
      }
      // Even a descendant that escaped the group must not hold the proof's stdio forever.
      cleanupTimeout = setTimeout(() => {
        forcedClose = true;
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        resolve([child.exitCode, child.signalCode]);
      }, 5_000);
    }, 180_000);
  });
  try { [code, signal] = await close; } finally {
    clearTimeout(timeout);
    clearTimeout(cleanupTimeout);
  }
  await Promise.all([
    writeFile(path.join(evidenceDirectory, `${scenario.name}.stdout.txt`), stdout),
    writeFile(path.join(evidenceDirectory, `${scenario.name}.stderr.txt`), stderr),
  ]);
  const envelopes = jsonObjects(stdout);
  const result = { scenario: scenario.name, argv: ["pnpm", ...args], code, signal,
    timedOut, ownedGroupId, closeObserved, forcedClose, spawnError, cleanupErrors,
    seconds: (performance.now() - started) / 1000, envelopes };
  await writeFile(path.join(evidenceDirectory, `${scenario.name}.result.json`), JSON.stringify(result, null, 2));
  assert.equal(timedOut, false, `${scenario.name}: CLI did not settle`);
  assert.equal(spawnError, undefined, `${scenario.name}: CLI spawn failed`);
  assert.equal(forcedClose, false, `${scenario.name}: process-group cleanup did not settle`);
  assert.equal(closeObserved, true, `${scenario.name}: CLI close was not observed`);
  assert.deepEqual(cleanupErrors, [], `${scenario.name}: process-group cleanup failed`);
  assert.equal(signal, null, `${scenario.name}: CLI terminated by signal`);
  assert.deepEqual(fixtureErrors, [], "Fixture errors are proof failures");
  assert.equal(requests.filter((request) => request.scenario === scenario.name).length, 1,
    `${scenario.name}: must traverse one actual loopback HTTP request`);
  const success = envelopes.find((value) => value.ok === true && value.capability === "model.run");
  const shouldSucceed = scenario.finish !== null || expectation === "baseline";
  if (shouldSucceed) {
    assert.equal(code, 0, `${scenario.name}: expected successful CLI exit`);
    assert.ok(success, `${scenario.name}: expected model.run success envelope`);
    assert.equal(success.transport, "local");
    assert.equal(success.provider, "proof");
    assert.equal(success.model, "proof-fixture");
    assert.deepEqual(success.outputs, [{ text: scenario.text, mediaUrl: null }]);
  } else {
    assert.notEqual(code, 0, "Failed partial stream must exit non-zero");
    assert.equal(success, undefined, "Failed partial stream must not emit a success envelope");
    assert.match(stdout + stderr, /Stream ended without finish_reason/,
      "CLI must preserve the real terminal provider error");
  }
  return result;
}

const results = [];
let failure;
let serverCloseObserved = false;
try {
  for (const scenario of cases) results.push(await runScenario(scenario));
} catch (error) {
  failure = error;
} finally {
  await new Promise((resolve) => {
    const deadline = setTimeout(resolve, 5_000);
    server.close(() => {
      serverCloseObserved = true;
      clearTimeout(deadline);
      resolve();
    });
    server.closeAllConnections();
  });
}
if (!serverCloseObserved) failure ??= new Error("Owned loopback server cleanup did not settle");
const summary = { expectation, productHead: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  results, requestCount: requests.length, fixtureErrors, serverCloseObserved,
  passed: failure === undefined, failure: failure === undefined ? undefined : String(failure) };
await Promise.all([
  writeFile(path.join(evidenceDirectory, "requests.json"), JSON.stringify(requests, null, 2)),
  writeFile(path.join(evidenceDirectory, "summary.json"), JSON.stringify(summary, null, 2)),
]);
console.log(JSON.stringify(summary, null, 2));
if (failure !== undefined) throw failure;

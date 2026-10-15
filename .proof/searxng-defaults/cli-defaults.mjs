import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

assert.equal(process.env.GITHUB_ACTIONS, "true");
assert.equal(process.platform, "linux");
const source = process.cwd();
const output = process.env.PROOF_OUTPUT_DIR;
const mode = process.env.PROOF_MODE;
assert.ok(output && ["baseline", "candidate"].includes(mode));
await fs.mkdir(output, { recursive: true });
const stamp = JSON.parse(await fs.readFile("dist/.buildstamp", "utf8"));
assert.equal(stamp.head, process.env.SOURCE_SHA);
assert.equal(stamp.inputsClean, true);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const entryHash = hash(await fs.readFile("dist/entry.js"));
const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "searxng-defaults-"));
const receipt = {
  mode, sourceSha: stamp.head, buildStamp: stamp, entryHash,
  calls: [], requests: [], behaviorFailures: [], errors: [],
};
const cases = [
  { name: "configured-count", maxResults: 1, expectedCount: 1 },
  { name: "explicit-count", maxResults: 1, limit: 3, expectedCount: 3 },
  { name: "unset-count", expectedCount: 4 },
  { name: "configured-timeout", timeoutSeconds: 1, responseDelayMs: 2_000, expectTimeout: true },
  { name: "longer-timeout-control", timeoutSeconds: 3, responseDelayMs: 2_000, expectedCount: 4 },
];
const casesByQuery = new Map(cases.map((testCase) => [`searxng-defaults-${testCase.name}`, testCase]));
const activeChildren = new Map();
const responseTimers = new Set();
const groupExists = (pid) => {
  try { process.kill(-pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
};
async function joinGroup(pid, budgetMs = 15_000) {
  const deadline = Date.now() + budgetMs;
  while (groupExists(pid) && Date.now() < deadline) await delay(50);
  assert.equal(groupExists(pid), false, "CLI process group must terminate naturally");
}
async function stopChild(child, call) {
  if (!child.pid || !groupExists(child.pid)) return;
  process.kill(-child.pid, "SIGTERM");
  const deadline = Date.now() + 5_000;
  while (groupExists(child.pid) && Date.now() < deadline) await delay(50);
  call.failureCleanup = { forcedKill: groupExists(child.pid), processGroupGone: false };
  if (call.failureCleanup.forcedKill) process.kill(-child.pid, "SIGKILL");
  await joinGroup(child.pid, 5_000);
  call.failureCleanup.processGroupGone = true;
}

async function cli(testCase, configPath, state) {
  const query = `searxng-defaults-${testCase.name}`;
  const args = ["infer", "web", "search", "--provider", "searxng", "--query", query];
  if (testCase.limit !== undefined) args.push("--limit", String(testCase.limit));
  args.push("--json");
  const call = { name: testCase.name, args, processGroupGone: false, watchdogFired: false, forcedKill: false };
  receipt.calls.push(call);
  const started = Date.now();
  const child = spawn("pnpm", ["--silent", "openclaw", ...args], {
    cwd: source, detached: true, stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH, HOME: fixture, OPENCLAW_HOME: fixture,
      OPENCLAW_STATE_DIR: state, OPENCLAW_CONFIG_PATH: configPath,
      CI: "true", NO_COLOR: "1", FORCE_COLOR: "0", TERM: "dumb",
      OPENCLAW_SKIP_CHANNELS: "1", OPENCLAW_DISABLE_BACKGROUND_TASKS: "1",
    },
  });
  activeChildren.set(child, call);
  let stdout = "", stderr = "", overflow = false;
  const stop = () => {
    if (child.pid && groupExists(child.pid)) process.kill(-child.pid, "SIGTERM");
  };
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    if (stdout.length > 512_000) { overflow = true; stop(); }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    if (stderr.length > 512_000) { overflow = true; stop(); }
  });
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  let killTimer, finalTimer;
  let rejectDeadline;
  const deadline = new Promise((_resolve, reject) => { rejectDeadline = reject; });
  const timer = setTimeout(() => {
    call.watchdogFired = true;
    stop();
    killTimer = setTimeout(() => {
      if (child.pid && groupExists(child.pid)) {
        call.forcedKill = true;
        process.kill(-child.pid, "SIGKILL");
      }
      finalTimer = setTimeout(() => rejectDeadline(new Error("CLI pipes did not close after the watchdog cleanup budget")), 5_000);
    }, 5_000);
  }, 90_000);
  try {
    call.exit = await Promise.race([closed, deadline]);
    assert.ok(child.pid);
    await joinGroup(child.pid);
    call.processGroupGone = true;
    activeChildren.delete(child);
    assert.equal(call.watchdogFired, false, "CLI watchdog is a harness failure");
    assert.equal(call.forcedKill, false, "CLI must not require forced termination");
    assert.equal(overflow, false, "CLI capture overflow is a harness failure");
    assert.equal(call.exit.signal, null, "CLI must exit without a signal");
    if (stdout.trim()) {
      call.envelope = JSON.parse(stdout);
      await fs.writeFile(path.join(output, `${testCase.name}.envelope.json`), JSON.stringify(call.envelope, null, 2));
    }
    call.stderr = stderr;
    return call;
  } catch (error) {
    clearTimeout(timer);
    clearTimeout(killTimer);
    clearTimeout(finalTimer);
    await stopChild(child, call);
    if (!child.pid || !groupExists(child.pid)) activeChildren.delete(child);
    if (call.watchdogFired) {
      child.stdout.destroy();
      child.stderr.destroy();
    }
    throw error;
  } finally {
    clearTimeout(timer);
    clearTimeout(killTimer);
    clearTimeout(finalTimer);
    call.wallMs = Date.now() - started;
    await fs.writeFile(path.join(output, `${testCase.name}.stdout.log`), stdout);
    await fs.writeFile(path.join(output, `${testCase.name}.stderr.log`), stderr);
    await fs.writeFile(path.join(output, `${testCase.name}.exit.json`), JSON.stringify({
      exit: call.exit ?? null, wallMs: call.wallMs, watchdogFired: call.watchdogFired,
      forcedKill: call.forcedKill, processGroupGone: call.processGroupGone,
      failureCleanup: call.failureCleanup ?? null,
    }, null, 2));
  }
}

function inspectSuccessfulCall(call, testCase) {
  assert.deepEqual(call.exit, { code: 0, signal: null });
  assert.equal(call.stderr, "", "successful CLI must not hide stderr diagnostics");
  const envelope = call.envelope;
  assert.ok(envelope, "successful JSON CLI must return its complete envelope");
  assert.equal(envelope.ok, true);
  assert.equal(envelope.capability, "web.search");
  assert.equal(envelope.transport, "local");
  assert.equal(envelope.provider, "searxng");
  assert.deepEqual(envelope.attempts, []);
  assert.equal(envelope.outputs.length, 1);
  assert.equal(envelope.error, undefined);
  const result = envelope.outputs[0].result;
  assert.equal(result.provider, "searxng");
  assert.equal(result.query, `searxng-defaults-${testCase.name}`);
  assert.equal(result.cached, undefined);
  assert.equal(result.count, result.results.length);
  assert.ok(Number.isInteger(result.count) && result.count >= 1 && result.count <= 4);
  for (const [index, row] of result.results.entries()) {
    assert.equal(row.url, `https://example.com/searxng/${testCase.name}/${index + 1}`);
    assert.ok(row.title.includes(`Fixture result ${index + 1}`));
    assert.ok(row.snippet.includes(`Synthetic snippet ${index + 1}`));
    assert.equal(row.siteName, "example.com");
  }
  return result.count;
}

const server = http.createServer((request, response) => {
  const receivedAt = Date.now();
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const query = url.searchParams.get("q");
  const testCase = casesByQuery.get(query);
  const observed = {
    name: testCase?.name ?? "unknown", method: request.method, path: url.pathname,
    query, format: url.searchParams.get("format"),
    categories: url.searchParams.get("categories"), language: url.searchParams.get("language"),
    accept: request.headers.accept, receivedAt, responseDelayMs: testCase?.responseDelayMs ?? 0,
  };
  receipt.requests.push(observed);
  const valid = testCase && request.method === "GET" && url.pathname === "/search" &&
    url.searchParams.get("format") === "json" && url.searchParams.get("categories") === "general" &&
    url.searchParams.get("language") === "en" && request.headers.accept === "application/json";
  if (!valid) {
    receipt.errors.push({ name: "FixtureRequestError", message: "unexpected method, path, query, or provider headers", observed });
    response.writeHead(400, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "unexpected fixture request" }));
    return;
  }
  let responseTimer;
  response.on("finish", () => { observed.finishedAt = Date.now(); });
  response.on("close", () => {
    observed.closedAt = Date.now();
    observed.closedAfterMs = observed.closedAt - receivedAt;
    observed.closedBeforeResponse = !response.writableFinished;
    if (responseTimer) { clearTimeout(responseTimer); responseTimers.delete(responseTimer); }
  });
  response.on("error", (error) => {
    receipt.errors.push({ name: "FixtureResponseError", message: error.message, case: testCase.name });
  });
  const answer = () => {
    if (responseTimer) responseTimers.delete(responseTimer);
    if (response.destroyed) return;
    observed.responseSentAt = Date.now();
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ results: Array.from({ length: 4 }, (_, index) => ({
      title: `Fixture result ${index + 1}`,
      url: `https://example.com/searxng/${testCase.name}/${index + 1}`,
      content: `Synthetic snippet ${index + 1}`,
    })) }));
  };
  if (testCase.responseDelayMs) {
    responseTimer = setTimeout(answer, testCase.responseDelayMs);
    responseTimers.add(responseTimer);
  } else answer();
});

try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  receipt.fixturePort = address.port;
  for (const testCase of cases) {
    try {
      const state = path.join(fixture, testCase.name, "state");
      const configPath = path.join(fixture, testCase.name, "openclaw.json");
      await fs.mkdir(state, { recursive: true });
      const config = {
        gateway: { mode: "local" },
        tools: { web: { search: {
          provider: "searxng", cacheTtlMinutes: 0,
          ...(testCase.maxResults === undefined ? {} : { maxResults: testCase.maxResults }),
          ...(testCase.timeoutSeconds === undefined ? {} : { timeoutSeconds: testCase.timeoutSeconds }),
        } } },
        plugins: { enabled: true, allow: ["searxng"], slots: { memory: "none" }, entries: {
          searxng: { enabled: true, config: { webSearch: {
            baseUrl: `http://127.0.0.1:${address.port}`, categories: "general", language: "en",
          } } },
        } },
        agents: { ownership: "explicit", defaults: { systemAgent: { agentId: "main" } }, entries: {
          main: { workspace: path.join(fixture, "workspace"), agentDir: path.join(fixture, testCase.name, "agent") },
        } },
      };
      await fs.writeFile(configPath, JSON.stringify(config));
      await fs.writeFile(path.join(output, `${testCase.name}.config.json`), JSON.stringify(config, null, 2));
      await cli(testCase, configPath, state);
    } catch (error) {
      receipt.errors.push({ name: error.name, message: error.message, case: testCase.name });
    }
  }

  // All five physical CLI outcomes are retained before any behavior verdict.
  for (const testCase of cases) {
    try {
      const call = receipt.calls.find((item) => item.name === testCase.name);
      assert.ok(call, "each case must run the supported CLI");
      const requests = receipt.requests.filter((item) => item.name === testCase.name);
      assert.equal(requests.length, 1, "each CLI must perform exactly one provider request");
      const request = requests[0];
      assert.ok(request.closedAt, "each provider response must close");
      if (testCase.expectTimeout && call.exit?.code !== 0) {
        assert.equal(call.exit.code, 1, "expected timeout must be a normal CLI failure");
        assert.ok(/timed?\s*out|timeout/i.test(`${call.stderr}\n${JSON.stringify(call.envelope)}`), "nonzero result must specifically report a timeout");
        assert.equal(request.closedBeforeResponse, true, "timeout must close the actual provider request before the delayed response");
        assert.equal(request.responseSentAt, undefined);
        assert.ok(request.closedAfterMs >= 500 && request.closedAfterMs < 2_000, "timeout duration is measured from HTTP receipt, not CLI startup");
        call.outcome = "configured-timeout-observed";
      } else {
        const count = inspectSuccessfulCall(call, testCase);
        assert.equal(request.closedBeforeResponse, false);
        assert.ok(request.responseSentAt);
        if (testCase.responseDelayMs) assert.ok(request.responseSentAt - request.receivedAt >= testCase.responseDelayMs - 50);
        call.outcome = `success-${count}-results`;
        if (testCase.expectTimeout) receipt.behaviorFailures.push("configured-timeout-ignored");
        if (testCase.name === "configured-count" && count !== testCase.expectedCount) receipt.behaviorFailures.push("configured-maxResults-ignored");
        if (testCase.name !== "configured-count") assert.equal(count, testCase.expectedCount ?? 4, "successful sibling control must retain its result count");
      }
    } catch (error) {
      receipt.errors.push({ name: error.name, message: error.message, case: testCase.name });
    }
  }
  assert.equal(hash(await fs.readFile("dist/entry.js")), entryHash);
  if (mode === "baseline") {
    assert.deepEqual(receipt.behaviorFailures, ["configured-maxResults-ignored", "configured-timeout-ignored"], "baseline must reproduce only the exact configured-default failures");
    for (const name of ["configured-count", "configured-timeout"]) {
      const call = receipt.calls.find((item) => item.name === name);
      assert.equal(call.envelope.outputs[0].result.count, 4, "baseline must return all four fixture rows despite the configured bound");
    }
    receipt.expectedBaselineReproduced = true;
  }
} catch (error) {
  receipt.errors.push({ name: error.name, message: error.message });
} finally {
  for (const [child, call] of activeChildren) {
    try { await stopChild(child, call); }
    catch (error) { receipt.errors.push({ name: "ChildCleanupError", message: error.message, case: call.name }); }
  }
  for (const timer of responseTimers) clearTimeout(timer);
  responseTimers.clear();
  try {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
    receipt.serverClosed = true;
    if (receipt.fixturePort) {
      const probe = http.createServer();
      try {
        await new Promise((resolve, reject) => {
          probe.once("error", reject);
          probe.listen(receipt.fixturePort, "127.0.0.1", resolve);
        });
        receipt.fixturePortRebound = true;
      } finally {
        await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
      }
    }
  } catch (error) { receipt.errors.push({ name: "ServerCleanupError", message: error.message }); }
  try { await fs.rm(fixture, { recursive: true }); receipt.fixtureRemoved = true; }
  catch (error) { receipt.errors.push({ name: "FixtureCleanupError", message: error.message }); }
  await fs.writeFile(path.join(output, "receipt.json"), JSON.stringify(receipt, null, 2));
}
assert.deepEqual(receipt.errors, [], "proof must not contain fixture, CLI, capture, or cleanup errors");
assert.equal(receipt.calls.length, 5);
assert.equal(receipt.requests.length, 5);
assert.ok(receipt.calls.every((call) => call.processGroupGone && !call.watchdogFired && !call.forcedKill));
assert.equal(receipt.serverClosed, true);
assert.equal(receipt.fixturePortRebound, true);
assert.equal(receipt.fixtureRemoved, true);
assert.deepEqual(receipt.behaviorFailures, [], "SearXNG must honor configured defaults and preserve explicit/unset controls");
console.log("PASS: actual infer web search CLI honored configured count and timeout; explicit and unset controls passed; process groups and fixture closed");

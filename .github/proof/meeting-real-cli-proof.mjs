// Remote-only contributor proof. Run after installation/build in secretless fork Actions.
// node meeting-real-cli-proof.mjs <checkout> <baseline|fixed> [result.json]
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const [checkoutArgument, expectation, resultArgument] = process.argv.slice(2);
assert(checkoutArgument, "missing candidate checkout");
assert(["baseline", "fixed"].includes(expectation), "expectation must be baseline or fixed");
assert.equal(process.env.CI, "true", "this proof must run in secretless CI, never locally");
assert.equal(process.platform, "linux", "process-group cleanup requires the Linux proof runner");

async function withinDeadline(operation, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function killOwnedProcessGroup(child) {
  if (!child.pid) {
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") {
      throw error;
    }
  }
}

const checkout = path.resolve(checkoutArgument);
const requireFromCheckout = createRequire(path.join(checkout, "package.json"));
const { WebSocketServer } = requireFromCheckout("ws");
const packageMetadata = JSON.parse(await readFile(path.join(checkout, "package.json"), "utf8"));
assert(packageMetadata.scripts.openclaw, "candidate must expose the supported pnpm openclaw entry");
const scratch = await mkdtemp(path.join(os.tmpdir(), "openclaw-meeting-cli-proof-"));
const token = "synthetic-meeting-cli-proof-token";
const cases = [
  {
    name: "teams-join-empty-mode",
    args: ["teamsmeetings", "join", "https://teams.microsoft.com/l/meetup-join/fixture/0", "--mode", ""],
    method: "teamsmeetings.join",
    params: { url: "https://teams.microsoft.com/l/meetup-join/fixture/0" },
    invalid: "mode must be agent, bidi, or transcribe; received",
  },
  {
    name: "zoom-listen-empty-transport",
    args: ["zoommeetings", "test-listen", "https://zoom.us/j/123456789", "--transport", ""],
    method: "zoommeetings.testListen",
    params: { url: "https://zoom.us/j/123456789" },
    invalid: "transport must be chrome or chrome-node; received",
  },
  {
    name: "teams-join-valid-enums",
    args: [
      "teamsmeetings", "join", "https://teams.microsoft.com/l/meetup-join/fixture/0",
      "--mode", "transcribe", "--transport", "chrome-node",
    ],
    method: "teamsmeetings.join",
    params: {
      url: "https://teams.microsoft.com/l/meetup-join/fixture/0",
      mode: "transcribe",
      transport: "chrome-node",
    },
  },
  {
    name: "zoom-listen-omitted-enums",
    args: ["zoommeetings", "test-listen", "https://zoom.us/j/123456789"],
    method: "zoommeetings.testListen",
    params: { url: "https://zoom.us/j/123456789" },
  },
];
const methods = [...new Set(cases.map((testCase) => testCase.method))];
const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
const serverErrors = [];
server.on("error", (error) => serverErrors.push(String(error)));
let activeCase;
server.on("connection", (socket) => {
  const record = activeCase;
  if (!record) {
    serverErrors.push("connection outside an owned CLI case");
    socket.close(1008, "no active case");
    return;
  }
  record.connections += 1;
  record.closed.push(new Promise((resolve) => socket.once("close", resolve)));
  const nonce = randomUUID();
  let connected = false;
  const respond = (request, payload) =>
    socket.send(JSON.stringify({ type: "res", id: request.id, ok: true, payload }));
  socket.on("error", (error) => record.transportErrors.push(String(error)));
  socket.on("message", (data) => {
    try {
      const request = JSON.parse(data.toString());
      assert.equal(request.type, "req", "expected a protocol request frame");
      assert.equal(typeof request.id, "string", "request must carry an id");
      if (request.method === "connect") {
        assert.equal(connected, false, "duplicate connect on a single socket");
        assert.equal(request.params.auth?.token, token, "expected only synthetic fixture auth");
        assert.equal(request.params.role, "operator");
        assert(request.params.scopes.includes("operator.admin"));
        assert.equal(request.params.client.mode, "cli");
        if (request.params.device) {
          assert.equal(request.params.device.nonce, nonce);
        }
        connected = true;
        record.connects += 1;
        respond(request, {
          type: "hello-ok",
          protocol: request.params.maxProtocol,
          server: { version: "proof-fixture", connId: randomUUID() },
          features: { methods, events: [], capabilities: ["ultrafast"] },
          snapshot: { presence: [], health: {}, stateVersion: { presence: 0, health: 0 }, uptimeMs: 0 },
          auth: { method: "token", role: "operator", scopes: ["operator.admin"] },
          policy: { maxPayload: 1_048_576, maxBufferedBytes: 1_048_576, tickIntervalMs: 60_000 },
        });
      } else {
        assert(connected, "meeting RPC must follow a successful connect");
        record.rpcs.push({ method: request.method, params: request.params });
        assert(methods.includes(request.method), `unexpected RPC ${request.method}`);
        respond(request, { ok: true, proofMeetingCli: true, method: request.method });
      }
    } catch (error) {
      record.transportErrors.push(String(error));
      socket.close(1008, "fixture contract failure");
    }
  });
  socket.send(JSON.stringify({
    type: "event", event: "connect.challenge", payload: { nonce, ts: Date.now() },
  }));
});

const results = [];
const cleanupErrors = [];
let failure;
const started = Date.now();
try {
  await once(server, "listening");
  const gatewayUrl = `ws://127.0.0.1:${server.address().port}`;
  const configPath = path.join(scratch, "openclaw.json");
  const entries = Object.fromEntries(["teams-meetings", "zoom-meetings"].map((id) => [id, {
    enabled: true,
    config: { enabled: true, defaultMode: "transcribe" },
  }]));
  await writeFile(configPath, JSON.stringify({
    gateway: { mode: "local", auth: { mode: "token", token } },
    plugins: {
      enabled: true,
      allow: ["teams-meetings", "zoom-meetings"],
      entries,
      slots: { memory: "none" },
    },
  }));
  const forwardedEnv = {};
  for (const key of ["PATH", "PNPM_HOME", "COREPACK_HOME", "PNPM_STORE_DIR", "TMPDIR", "TMP", "TEMP"]) {
    if (process.env[key] !== undefined) {
      forwardedEnv[key] = process.env[key];
    }
  }
  for (const testCase of cases) {
    const caseHome = path.join(scratch, testCase.name);
    await mkdir(caseHome);
    const record = {
      name: testCase.name,
      args: testCase.args,
      connections: 0,
      connects: 0,
      rpcs: [],
      transportErrors: [],
      stdout: "",
      stderr: "",
      subprocessErrors: [],
      closed: [],
    };
    results.push(record);
    activeCase = record;
    const caseStarted = Date.now();
    const child = spawn("pnpm", ["openclaw", ...testCase.args], {
      cwd: checkout,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env: {
        ...forwardedEnv,
        CI: "true",
        HOME: caseHome,
        USERPROFILE: caseHome,
        XDG_CONFIG_HOME: path.join(caseHome, "config"),
        XDG_CACHE_HOME: path.join(caseHome, "cache"),
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_STATE_DIR: path.join(caseHome, "state"),
        OPENCLAW_GATEWAY_URL: gatewayUrl,
        OPENCLAW_GATEWAY_TOKEN: token,
        NO_COLOR: "1",
        TERM: "dumb",
      },
    });
    child.stdout.setEncoding("utf8").on("data", (chunk) => { record.stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { record.stderr += chunk; });
    child.on("error", (error) => record.subprocessErrors.push(String(error)));
    const closed = new Promise((resolve) =>
      child.once("close", (code, signal) => resolve([code, signal])),
    );
    let code;
    let signal;
    try {
      [code, signal] = await withinDeadline(closed, 180_000, `${testCase.name}: CLI close`);
    } catch (error) {
      record.subprocessErrors.push(String(error));
      try {
        killOwnedProcessGroup(child);
        [code, signal] = await withinDeadline(closed, 5_000, `${testCase.name}: killed group close`);
      } catch (cleanupError) {
        cleanupErrors.push(String(cleanupError));
        // Keep receipt emission bounded even if an escaped process retains a pipe.
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
      }
      record.code = code ?? null;
      record.signal = signal ?? null;
      record.durationMs = Date.now() - caseStarted;
      throw error;
    }
    record.code = code;
    record.signal = signal;
    record.durationMs = Date.now() - caseStarted;
    await withinDeadline(Promise.all(record.closed), 5_000, `${testCase.name}: socket close`);
    delete record.closed;
    activeCase = undefined;
    assert.deepEqual(record.subprocessErrors, [], `${testCase.name}: subprocess/fixture error`);
    assert.equal(signal, null, `${testCase.name}: subprocess must settle without a signal`);
    assert.deepEqual(record.transportErrors, [], `${testCase.name}: fixture transport errors`);
    if (expectation === "fixed" && testCase.invalid) {
      assert.notEqual(code, 0, `${testCase.name}: empty enum must fail`);
      assert.deepEqual(JSON.parse(record.stdout), {
        ok: false,
        error: { type: "cli_error", message: `${testCase.invalid} ` },
      }, `${testCase.name}: expected structured enum diagnostic`);
      assert.equal(record.connections, 0, `${testCase.name}: invalid input must not connect`);
      assert.deepEqual(record.rpcs, [], `${testCase.name}: invalid input must not dispatch RPC`);
    } else {
      assert.equal(code, 0, `${testCase.name}: CLI should complete successfully`);
      assert.equal(record.connects, 1, `${testCase.name}: must use the actual Gateway handshake`);
      assert.deepEqual(record.rpcs, [{ method: testCase.method, params: testCase.params }]);
      assert(record.stdout.includes('"proofMeetingCli": true'), `${testCase.name}: RPC result must be visible`);
    }
  }
  assert.deepEqual(serverErrors, []);
} catch (error) {
  failure = String(error?.stack ?? error);
} finally {
  activeCase = undefined;
  for (const socket of server.clients) {
    socket.terminate();
  }
  try {
    await withinDeadline(new Promise((resolve) => server.close(resolve)), 5_000, "server cleanup");
  } catch (error) {
    cleanupErrors.push(String(error));
    failure ??= String(error?.stack ?? error);
  }
  for (const record of results) {
    if (record.closed) {
      try {
        await withinDeadline(Promise.all(record.closed), 5_000, `${record.name}: socket cleanup`);
      } catch (error) {
        cleanupErrors.push(String(error));
        failure ??= String(error?.stack ?? error);
      }
      delete record.closed;
    }
  }
  const receipt = {
    expectation,
    scope: "supported Teams/Zoom CLI to isolated mock-Gateway boundary, not vendor/browser/audio proof",
    durationMs: Date.now() - started,
    pass: !failure,
    failure: failure ?? null,
    serverErrors,
    cleanupErrors,
    retainedScratch: cleanupErrors.length ? scratch : null,
    results,
  };
  if (resultArgument) {
    await writeFile(path.resolve(resultArgument), JSON.stringify(receipt, null, 2));
  }
  await new Promise((resolve, reject) =>
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`, (error) =>
      error ? reject(error) : resolve(),
    ),
  );
  if (!cleanupErrors.length) {
    await rm(scratch, { recursive: true, force: true });
  }
  if (failure) {
    // A failed close must not leave a fixture handle keeping Actions alive after its receipt.
    process.exit(1);
  }
}

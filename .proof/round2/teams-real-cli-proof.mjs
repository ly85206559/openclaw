// Proof-only shipped CLI runner. Execute only in secretless Linux Actions after build.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: {
  repo: { type: "string" }, "evidence-dir": { type: "string" },
  "expected-head": { type: "string" }, mode: { type: "string" }, pnpm: { type: "string" },
} });
assert.equal(process.platform, "linux", "stock Linux Actions only");
assert.equal(process.env.GITHUB_ACTIONS, "true", "never run this proof locally");
const repo = path.resolve(values.repo ?? ".");
const evidenceDir = path.resolve(values["evidence-dir"] ?? "");
const evidenceRelative = path.relative(repo, evidenceDir);
const mode = values.mode;
assert.ok(mode === "original" || mode === "candidate");
assert.match(values["expected-head"] ?? "", /^[a-f0-9]{40}$/);
assert.ok(values["evidence-dir"] && (evidenceRelative === ".." || evidenceRelative.startsWith(`..${path.sep}`)));
assert.ok(path.isAbsolute(values.pnpm ?? ""));
const preload = fileURLToPath(new URL("./teams-real-cli-proof.preload.mjs", import.meta.url));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const describeError = (error) => ({ name: error?.name, message: error?.message ?? String(error), stack: error?.stack });
const receipt = {
  mode, expectedHead: values["expected-head"], expectedModeVerified: false, regressionGate: "UNRUN",
  cases: [], requests: [], serverErrors: [], processErrors: [], receivedSignals: [], cleanupErrors: [],
};
await fs.mkdir(evidenceDir, { recursive: true });
const stop = new AbortController();
const onSignal = (signal) => {
  receipt.receivedSignals.push(signal);
  stop.abort(new Error(`proof received ${signal}`));
};
const onSigint = () => onSignal("SIGINT");
const onSigterm = () => onSignal("SIGTERM");
const onUnhandled = (error) => receipt.processErrors.push(describeError(error));
process.on("SIGINT", onSigint);
process.on("SIGTERM", onSigterm);
process.on("unhandledRejection", onUnhandled);
let tempDirs;
let taskRoot;
let reservation;
let activeCase;
let runManagedCommand;
let hasUnjoinedWork;
let retainTemporaryInputs = false;
const sockets = new Set();
const teamId = "66666666-6666-6666-6666-666666666666";
const channelId = "19:other@thread.tacv2";
const target = `${teamId}/${channelId}`;
const token = "openclaw-teams-proof-not-a-real-token";
const graphMessage = {
  id: "other-message", body: { content: "Other planning notes", contentType: "text" },
  from: { user: { id: "33333333-3333-3333-3333-333333333333", displayName: "Member" } },
  createdDateTime: "2026-10-13T12:00:00Z",
};
const expectedMessage = {
  id: "other-message", text: "Other planning notes",
  from: { user: { id: "33333333-3333-3333-3333-333333333333", displayName: "Member" } },
  createdAt: "2026-10-13T12:00:00Z",
};
const expectedHumanFields = ["Other planning notes", "other-message", "Member", "2026-10-13T12:00:00Z"];
const channelPath = `/v1.0/teams/${teamId}/channels/${channelId}/messages`;

async function runCli(current, env) {
  const controller = new AbortController();
  const signal = AbortSignal.any([stop.signal, controller.signal, AbortSignal.timeout(120_000)]);
  const stdout = [];
  const stderr = [];
  let bytes = 0;
  let exitCode = null;
  let exitSignal = null;
  let childCloseObserved = false;
  let childCloseError;
  let closeObservation;
  const outputClosed = { stdout: false, stderr: false };
  let managedError;
  let managedExitCode;
  let spawnError;
  const started = performance.now();
  const caseDir = path.join(evidenceDir, current.name);
  await fs.mkdir(caseDir);
  const eventsPath = path.join(caseDir, "external-fixture-events.jsonl");
  await fs.writeFile(eventsPath, "");
  try {
    managedExitCode = await runManagedCommand({
      bin: values.pnpm, args: ["--silent", "openclaw", ...current.args], cwd: repo,
      env: { ...env, TEAMS_PROOF_EVENTS: eventsPath }, stdio: ["ignore", "pipe", "pipe"],
      shell: false, signal, requireProcessTreeExit: true, waitForCleanupRelease: true,
      onReady(child) {
        for (const [name, stream, chunks] of [["stdout", child.stdout, stdout], ["stderr", child.stderr, stderr]]) {
          stream.once("close", () => { outputClosed[name] = true; });
          stream.on("data", (chunk) => {
            chunks.push(chunk);
            bytes += chunk.length;
            if (bytes > 4 * 1024 * 1024) { controller.abort(new Error("CLI output exceeded 4 MiB")); }
          });
        }
        child.once("error", (error) => { spawnError = error; });
        child.once("exit", (code, childSignal) => { exitCode = code; exitSignal = childSignal; });
        closeObservation = once(child, "close", { signal }).then(
          () => { childCloseObserved = true; },
          (error) => { childCloseError = error; },
        );
      },
    });
    // Strict tree cleanup joins exit and output before Node necessarily emits close.
    await closeObservation;
    if (childCloseError) { throw childCloseError; }
  } catch (error) {
    managedError = error;
    retainTemporaryInputs ||= hasUnjoinedWork(error);
  }
  const result = {
    name: current.name, command: ["pnpm", "openclaw", ...current.args],
    stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"),
    exitCode, exitSignal, managedExitCode, elapsedMs: Math.round(performance.now() - started),
    aborted: signal.aborted,
    ...(signal.aborted ? { abortReason: describeError(signal.reason) } : {}),
    ...(spawnError ? { spawnError: describeError(spawnError) } : {}),
    ...(managedError ? { managedError: {
      ...describeError(managedError), processTreeState: managedError.processTreeState,
      unjoinedWork: hasUnjoinedWork(managedError),
    } } : {}),
    cleanup: {
      owner: "scripts/lib/managed-child-process.mts:runManagedCommand", completed: !managedError,
      childCloseObserved, outputClosed,
      scope: "managed wrapper group, output closure, and acknowledged cleanup handoff",
      limitation: "pnpm is not a custody participant; independent detached descendants are not globally enumerated",
    },
  };
  await fs.writeFile(path.join(caseDir, "stdout.txt"), result.stdout);
  await fs.writeFile(path.join(caseDir, "stderr.txt"), result.stderr);
  result.externalFixtureEvents = (await fs.readFile(eventsPath, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
  result.graphRequests = receipt.requests.filter((request) => request.case === current.name);
  receipt.cases.push(result);
  assert.equal(result.managedError, undefined);
  assert.equal(result.spawnError, undefined);
  assert.equal(result.aborted, false);
  assert.equal(result.managedExitCode, 0);
  assert.equal(result.exitCode, 0);
  assert.equal(result.exitSignal, null);
  assert.equal(result.cleanup.childCloseObserved, true);
  assert.deepEqual(result.cleanup.outputClosed, { stdout: true, stderr: true });
  const tokenCalls = result.externalFixtureEvents.filter((event) => event.kind === "external-token-fixture");
  const graphCalls = result.externalFixtureEvents.filter((event) => event.kind === "external-graph-origin-fixture");
  const publicHooks = result.externalFixtureEvents.filter((event) => event.kind === "public-ssrf-runtime-hook");
  const publicExports = result.externalFixtureEvents.filter((event) => event.kind === "public-ssrf-export-resolved");
  const actualLoads = result.externalFixtureEvents.filter((event) => event.kind === "public-ssrf-actual-facade-loaded");
  assert.equal(tokenCalls.length, 1, "real Teams SDK token adapter must reach the fixture once");
  assert.equal(graphCalls.length, 1, "real Teams Graph request must cross the public transport fixture once");
  const graphPid = graphCalls[0].pid;
  assert.equal(tokenCalls[0].pid, graphPid);
  const graphHooks = publicHooks.filter((event) => event.pid === graphPid);
  assert.ok(graphHooks.length > 0, "actual Graph caller must use the verified public SSRF module edge");
  assert.ok(publicExports.some((event) => event.pid === graphPid && event.original === graphHooks[0].original));
  assert.ok(actualLoads.some((event) => event.pid === graphPid && event.original === graphHooks[0].original &&
    event.actual === graphHooks[0].actual), "actual Graph caller must retain the unchanged public facade");
  const requests = result.graphRequests;
  assert.equal(requests.length, 1, "each real CLI command must perform one Graph HTTP read");
  assert.equal(requests[0].responseClosedEarly, false);
  assert.equal(requests[0].aborted, false);
  assert.equal(receipt.serverErrors.length, 0);
  return result;
}

try {
  const interfaces = (await fs.readFile("/proc/self/net/dev", "utf8")).trim().split("\n")
    .slice(2).map((line) => line.split(":")[0].trim()).sort();
  assert.deepEqual(interfaces, ["lo"], "run under unshare --net with loopback only");
  const loopback = JSON.parse(execFileSync("ip", ["-json", "link", "show", "dev", "lo"], { encoding: "utf8" }));
  assert.ok(loopback[0].flags.includes("UP"));
  const networkNamespace = await fs.readlink("/proc/self/ns/net");
  receipt.networkBoundary = { interfaces, networkNamespace, loopbackUp: true, policy: "loopback-only network namespace" };
  receipt.actualHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  assert.equal(receipt.actualHead, values["expected-head"]);
  if (mode === "original") { assert.equal(receipt.actualHead, "cc397809fb666caf37f19d0dfa9a8edfec90c87c"); }
  receipt.sourceHashes = {};
  for (const file of [
    "src/commands/message-format.ts", "src/commands/message.ts", "extensions/msteams/src/channel.ts",
    "extensions/msteams/src/graph-messages.ts", "extensions/msteams/src/graph.ts", "extensions/msteams/src/sdk.ts",
    "extensions/msteams/package.json", "package.json", "pnpm-lock.yaml",
    "scripts/lib/managed-child-process.mts", "src/plugin-sdk/ssrf-runtime.ts",
  ]) { receipt.sourceHashes[file] = sha256(await fs.readFile(path.join(repo, file))); }
  receipt.preloadSha256 = sha256(await fs.readFile(preload));
  ({ runManagedCommand, hasUnjoinedWork } = await import(pathToFileURL(path.join(repo, "scripts/lib/managed-child-process.mts"))));
  const { createTempDirTracker } = await import(pathToFileURL(path.join(repo, "test/helpers/temp-dir.ts")));
  const { reserveTestPortListener } = await import(pathToFileURL(path.join(repo, "src/test-utils/port-claims.ts")));
  tempDirs = createTempDirTracker();
  taskRoot = tempDirs.make("openclaw-teams-shipped-cli-proof-");
  receipt.temporaryRoot = taskRoot;
  const taskHome = path.join(taskRoot, "home");
  const taskState = path.join(taskRoot, "state");
  const workspace = path.join(taskRoot, "workspace");
  await Promise.all([taskHome, taskState, workspace].map((directory) => fs.mkdir(directory)));
  const handler = async (request, response) => {
    assert.ok(activeCase);
    assert.equal(request.socket.remoteAddress, "127.0.0.1");
    assert.equal(request.method, "GET");
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    const url = new URL(request.url, "http://fixture.invalid");
    const pathname = decodeURIComponent(url.pathname);
    assert.equal(pathname, activeCase.action === "read" ? `${channelPath}/other-message` : channelPath);
    if (activeCase.action === "search") { assert.equal(url.searchParams.get("$top"), "50"); }
    else { assert.equal(url.search, ""); }
    const record = { case: activeCase.name, method: request.method, path: pathname,
      query: url.search, auth: "synthetic bearer token", aborted: false };
    receipt.requests.push(record);
    request.on("aborted", () => { record.aborted = true; });
    request.resume();
    response.on("close", () => { record.responseClosedEarly = !response.writableFinished; });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(activeCase.action === "read" ? graphMessage : { value: [graphMessage] }));
  };
  reservation = await reserveTestPortListener({ offsets: [0], signal: stop.signal,
    createListener: () => createServer((request, response) => {
      handler(request, response).catch((error) => {
        receipt.serverErrors.push(describeError(error));
        if (!response.headersSent) { response.writeHead(400, { "content-type": "application/json" }); }
        response.end(JSON.stringify({ error: "proof fixture rejected an unexpected request" }));
      });
    }),
  });
  reservation.listener.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  receipt.graphOrigin = `http://127.0.0.1:${reservation.claim.port}`;
  const configPath = path.join(taskState, "openclaw.json");
  await fs.writeFile(configPath, JSON.stringify({
    agents: { defaults: { workspace }, entries: { main: {} } },
    plugins: { allow: ["msteams"], entries: { msteams: { enabled: true } } },
    channels: { msteams: {
      enabled: true, authType: "secret", appId: "44444444-4444-4444-4444-444444444444",
      tenantId: "55555555-5555-5555-5555-555555555555", appPassword: "synthetic-proof-not-a-real-password",
      dmPolicy: "open", allowFrom: ["*"], groupPolicy: "allowlist",
      teams: { [teamId]: { channels: { [channelId]: {} } } },
    } },
    logging: { level: "silent", consoleLevel: "silent" },
  }));
  const env = {
    PATH: process.env.PATH, HOME: taskHome, USERPROFILE: taskHome, TMPDIR: taskRoot, TMP: taskRoot, TEMP: taskRoot,
    CI: "true", GITHUB_ACTIONS: "true", RUNNER_OS: "Linux", OPENCLAW_HOME: taskHome,
    OPENCLAW_STATE_DIR: taskState, OPENCLAW_CONFIG_PATH: configPath, NO_COLOR: "1", FORCE_COLOR: "0", TERM: "dumb",
    NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`, TEAMS_PROOF_REPO: repo,
    TEAMS_PROOF_GRAPH_ORIGIN: receipt.graphOrigin, TEAMS_PROOF_NETWORK_NAMESPACE: networkNamespace,
  };
  const read = ["message", "read", "--channel", "msteams", "--target", target, "--message-id", "other-message"];
  const search = ["message", "search", "--channel", "msteams", "--channel-id", target, "--query", "planning"];
  const cases = [
    { name: "read-text", action: "read", args: read },
    { name: "search-text", action: "search", args: search },
    { name: "read-json", action: "read", args: [...read, "--json"], json: true },
    { name: "search-json", action: "search", args: [...search, "--json"], json: true },
    { name: "empty-search-text", action: "search", args: [...search.slice(0, -1), "unmatched"], empty: true },
  ];
  let missingHumanFields = 0;
  for (const current of cases) {
    activeCase = current;
    const result = await runCli(current, env);
    if (current.json) {
      const envelope = JSON.parse(result.stdout.trim());
      assert.equal(envelope.action, current.action);
      assert.equal(envelope.channel, "msteams");
      assert.equal(envelope.dryRun, false);
      assert.equal(envelope.handledBy, "plugin");
      assert.deepEqual(envelope.payload, { ok: true, channel: "msteams", action: current.action,
        ...(current.action === "read" ? { message: expectedMessage } : { messages: [expectedMessage], truncated: false }) });
      result.jsonControlPassed = true;
    } else {
      const expected = current.empty ? ["No results."] : expectedHumanFields;
      const missing = expected.filter((field) => !result.stdout.includes(field));
      result.callerVisibleRegression = { expected, missing, passed: missing.length === 0 };
      missingHumanFields += missing.length;
      assert.equal(missing.length, mode === "original" ? expected.length : 0);
      if (current.empty) { assert.equal(result.stdout.includes("Other planning notes"), false); }
    }
  }
  activeCase = undefined;
  assert.equal(receipt.requests.length, 5);
  assert.equal(missingHumanFields, mode === "original" ? 9 : 0);
  assert.deepEqual(receipt.processErrors, []);
  assert.deepEqual(receipt.receivedSignals, []);
  const redact = (text) => text.replaceAll(taskRoot, "[isolated-fixture]")
    .replaceAll(receipt.graphOrigin, "http://[synthetic-loopback]");
  const transcript = receipt.cases.filter((result) => !result.name.endsWith("-json")).map((result) =>
    `$ ${result.command.join(" ")}\n${redact(result.stdout)}\nexit=${result.exitCode}\n`).join("\n");
  await fs.writeFile(path.join(evidenceDir, "redacted-terminal.txt"),
    `Synthetic Graph/token I/O only; real shipped pnpm CLI, Teams plugin, parser, formatter and stdout. Not live Microsoft Teams proof.\nmode=${mode}\nhead=${receipt.actualHead}\n\n${transcript}`);
  receipt.regressionGate = mode === "original" ? "RED" : "GREEN";
  receipt.expectedModeVerified = true;
} catch (error) {
  receipt.failure = describeError(error);
  process.exitCode = 1;
} finally {
  if (reservation) {
    try {
      const closing = reservation.releaseListener();
      for (const socket of sockets) { socket.destroy(); }
      await closing;
      receipt.listenerClosed = !reservation.listener.listening;
    } catch (error) { receipt.cleanupErrors.push(describeError(error)); }
    try { await reservation.claim.release(); receipt.portClaimReleased = true; }
    catch (error) { receipt.cleanupErrors.push(describeError(error)); }
  }
  if (tempDirs && retainTemporaryInputs) {
    receipt.retainedTemporaryRoot = taskRoot;
    receipt.cleanupErrors.push({ message: "canonical cleanup reported unjoined work; inputs retained" });
  } else if (tempDirs) {
    try {
      tempDirs.cleanup();
      assert.equal(tempDirs.dirs.size, 0);
      try { await fs.access(taskRoot); throw new Error("temporary root still exists"); }
      catch (error) { if (error.code !== "ENOENT") { throw error; } }
      receipt.temporaryDirectoriesRemoved = true;
    } catch (error) { receipt.cleanupErrors.push(describeError(error)); }
  }
  process.off("SIGINT", onSigint);
  process.off("SIGTERM", onSigterm);
  process.off("unhandledRejection", onUnhandled);
  if (receipt.cleanupErrors.length || receipt.serverErrors.length || receipt.processErrors.length || receipt.receivedSignals.length) {
    receipt.expectedModeVerified = false;
    process.exitCode = 1;
  }
  await fs.writeFile(path.join(evidenceDir, "receipt.json"), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ mode, regressionGate: receipt.regressionGate, expectedModeVerified: receipt.expectedModeVerified, exitCode: process.exitCode ?? 0 }));
}

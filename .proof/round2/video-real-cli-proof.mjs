// Proof-only runner. Execute exclusively in reviewed secretless Linux Actions.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    repo: { type: "string" },
    "evidence-dir": { type: "string" },
    "expected-head": { type: "string" },
    mode: { type: "string" },
    pnpm: { type: "string" },
  },
});
const repo = path.resolve(values.repo ?? ".");
const evidenceDir = path.resolve(values["evidence-dir"] ?? "");
const evidenceRelativeToRepo = path.relative(repo, evidenceDir);
const mode = values.mode;
assert.ok(mode === "original" || mode === "candidate", "--mode original|candidate is required");
assert.match(values["expected-head"] ?? "", /^[a-f0-9]{40}$/, "require exact --expected-head");
assert.ok(values["evidence-dir"] &&
  (evidenceRelativeToRepo === ".." || evidenceRelativeToRepo.startsWith(`..${path.sep}`)),
  "evidence must be explicitly selected outside the checkout");
assert.ok(path.isAbsolute(values.pnpm ?? ""), "--pnpm must name the prepared absolute executable");
assert.equal(process.platform, "linux", "stock Linux Actions only");
assert.equal(process.env.GITHUB_ACTIONS, "true", "never run this proof locally");

await fs.mkdir(evidenceDir, { recursive: true });
const receipt = {
  mode,
  expectedHead: values["expected-head"],
  expectedModeVerified: false,
  regressionGate: "UNRUN",
  cases: [],
  requests: [],
  serverErrors: [],
  processErrors: [],
  receivedSignals: [],
  cleanupErrors: [],
};
const stop = new AbortController();
const onSignal = (signal) => {
  receipt.receivedSignals.push(signal);
  stop.abort(new Error(`proof received ${signal}`));
};
const onSigint = () => onSignal("SIGINT");
const onSigterm = () => onSignal("SIGTERM");
const onUnhandled = (error) => receipt.processErrors.push(String(error?.stack ?? error));
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
const syntheticKey = "openclaw-proof-not-a-real-api-key";
const expectedIgnored = [{ key: "size", value: "4k" }, { key: "watermark", value: true }];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const describeError = (error) => ({ name: error?.name, message: error?.message ?? String(error), stack: error?.stack });

async function runCli(name, args, env) {
  const controller = new AbortController();
  const signal = AbortSignal.any([stop.signal, controller.signal, AbortSignal.timeout(120_000)]);
  const started = performance.now();
  const stdout = [];
  const stderr = [];
  let capturedBytes = 0;
  let spawnError;
  let managedError;
  let managedExitCode;
  let exitCode = null;
  let exitSignal = null;
  let childCloseObserved = false;
  const outputClosed = { stdout: false, stderr: false };
  try {
    managedExitCode = await runManagedCommand({
      bin: values.pnpm,
      args: ["--silent", "openclaw", ...args],
      cwd: repo,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      signal,
      requireProcessTreeExit: true,
      waitForCleanupRelease: true,
      onReady(child) {
        for (const [streamName, stream, chunks] of [["stdout", child.stdout, stdout], ["stderr", child.stderr, stderr]]) {
          stream.once("close", () => { outputClosed[streamName] = true; });
          stream.on("data", (chunk) => {
            chunks.push(chunk);
            capturedBytes += chunk.length;
            if (capturedBytes > 4 * 1024 * 1024) {
              controller.abort(new Error("CLI proof output exceeded 4 MiB"));
            }
          });
        }
        child.once("error", (error) => { spawnError = error; });
        child.once("exit", (code, receivedSignal) => {
          exitCode = code;
          exitSignal = receivedSignal;
        });
        child.once("close", () => { childCloseObserved = true; });
      },
    });
  } catch (error) {
    managedError = error;
    retainTemporaryInputs ||= hasUnjoinedWork(error);
  }
  const result = {
    name, args, exitCode, exitSignal, managedExitCode,
    elapsedMs: Math.round(performance.now() - started),
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
    aborted: signal.aborted,
    ...(signal.aborted ? { abortReason: describeError(signal.reason) } : {}),
    ...(spawnError ? { spawnError: describeError(spawnError) } : {}),
    ...(managedError ? { managedError: {
      ...describeError(managedError), code: managedError.code,
      processTreeState: managedError.processTreeState,
      unjoinedWork: hasUnjoinedWork(managedError),
    } } : {}),
    cleanup: {
      owner: "scripts/lib/managed-child-process.mts:runManagedCommand",
      completed: !managedError,
      childCloseObserved,
      outputClosed,
      scope: "managed wrapper group, output closure, and any acknowledged cleanup handoff",
      limitation: "pnpm is not a managed custody participant; independent detached descendants are not globally enumerated",
    },
  };
  await fs.mkdir(path.join(evidenceDir, name));
  await fs.writeFile(path.join(evidenceDir, name, "stdout.txt"), result.stdout);
  await fs.writeFile(path.join(evidenceDir, name, "stderr.txt"), result.stderr);
  receipt.cases.push(result);
  assert.equal(result.managedError, undefined, `${name}: canonical command finalization failed`);
  assert.equal(result.managedExitCode, 0, `${name}: supported managed CLI must complete`);
  assert.equal(result.exitCode, 0, `${name}: supported CLI must complete`);
  assert.equal(result.exitSignal, null, `${name}: unexpected child signal`);
  assert.equal(result.aborted, false, `${name}: proof deadline/abort`);
  assert.equal(result.spawnError, undefined, `${name}: process setup failed`);
  assert.deepEqual(result.cleanup.outputClosed, { stdout: true, stderr: true }, `${name}: child output did not close`);
  return result;
}

try {
  // The namespace, not a fetch monkeypatch, denies every non-loopback route.
  // Dependencies and canonical builds must have completed before entering it.
  const interfaces = (await fs.readFile("/proc/self/net/dev", "utf8")).trim().split("\n")
    .slice(2).map((line) => line.split(":")[0].trim()).sort();
  assert.deepEqual(interfaces, ["lo"], "run under unshare --net with only loopback");
  const loopback = JSON.parse(execFileSync("ip", ["-json", "link", "show", "dev", "lo"], { encoding: "utf8" }));
  assert.ok(loopback[0].flags.includes("UP"), "loopback must be up");
  const networkNamespace = await fs.readlink("/proc/self/ns/net");
  receipt.networkBoundary = { interfaces, networkNamespace, loopbackUp: true, policy: "network namespace: loopback only" };
  receipt.actualHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  assert.equal(receipt.actualHead, values["expected-head"]);
  if (mode === "original") {
    assert.equal(receipt.actualHead, "cc397809fb666caf37f19d0dfa9a8edfec90c87c");
  }
  receipt.sourceHashes = {};
  for (const file of [
    "src/cli/capability-cli/video.ts", "src/cli/capability-cli/output.ts",
    "src/video-generation/runtime.ts", "src/video-generation/normalization.ts",
    "extensions/zai/video-generation-provider.ts", "test/fixtures/media-playback.ts",
    "src/test-utils/port-claims.ts", "test/helpers/temp-dir.ts", "pnpm-lock.yaml",
    "scripts/lib/managed-child-process.mts", "scripts/lib/managed-cleanup-handoff.mts",
  ]) {
    receipt.sourceHashes[file] = sha256(await fs.readFile(path.join(repo, file)));
  }
  const { createTempDirTracker } = await import(pathToFileURL(path.join(repo, "test/helpers/temp-dir.ts")));
  const { reserveTestPortListener } = await import(pathToFileURL(path.join(repo, "src/test-utils/port-claims.ts")));
  const { createPlaybackMediaFixture } = await import(pathToFileURL(path.join(repo, "test/fixtures/media-playback.ts")));
  ({ runManagedCommand, hasUnjoinedWork } = await import(pathToFileURL(path.join(repo, "scripts/lib/managed-child-process.mts"))));
  const media = createPlaybackMediaFixture("mp4");
  assert.equal(media.subarray(4, 8).toString("ascii"), "ftyp");
  receipt.mediaFixture = { bytes: media.length, sha256: sha256(media), source: "createPlaybackMediaFixture(mp4)" };
  // Standalone proof has no Vitest lifecycle. Reuse the tracker in finally.
  tempDirs = createTempDirTracker();
  taskRoot = tempDirs.make("openclaw-video-cli-proof-");
  receipt.temporaryRoot = taskRoot;
  const taskHome = path.join(taskRoot, "home");
  const taskState = path.join(taskRoot, "state");
  const workspace = path.join(taskRoot, "workspace");
  await Promise.all([taskHome, taskState, workspace].map((directory) => fs.mkdir(directory)));

  const handler = async (req, res) => {
    const current = activeCase;
    assert.ok(current, "unexpected request outside a CLI case");
    assert.equal(req.socket.remoteAddress, "127.0.0.1");
    const request = { case: current.name, method: req.method, url: req.url, aborted: false };
    receipt.requests.push(request);
    req.on("aborted", () => { request.aborted = true; });
    res.on("close", () => { request.responseClosedEarly = !res.writableFinished; });
    const sendJson = (value) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.method === "POST" && req.url === "/videos/generations") {
      assert.equal(req.headers.authorization, `Bearer ${syntheticKey}`);
      const chunks = [];
      let length = 0;
      for await (const chunk of req) {
        length += chunk.length;
        assert.ok(length <= 64 * 1024, "unexpected large provider request");
        chunks.push(chunk);
      }
      request.auth = "synthetic bearer key";
      request.body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      assert.deepEqual(request.body, {
        model: "cogvideox-3", prompt: `video CLI proof ${current.name}`,
        quality: "speed", fps: 30, duration: 5,
        size: current.ignored ? "1280x720" : "1920x1080",
        with_audio: !current.ignored,
      });
      sendJson({ id: current.name });
    } else if (req.method === "GET" && req.url === `/async-result/${current.name}`) {
      assert.equal(req.headers.authorization, `Bearer ${syntheticKey}`);
      request.auth = "synthetic bearer key";
      sendJson({ task_status: "SUCCESS", video_result: [{ url: `${receipt.baseUrl}/media/${current.name}.mp4` }] });
    } else if (req.method === "GET" && req.url === `/media/${current.name}.mp4`) {
      assert.equal(req.headers.authorization, undefined, "do not forward provider key to a media URL");
      res.writeHead(200, { "content-type": "video/mp4", "content-length": String(media.length) });
      res.end(media);
    } else {
      throw new Error(`unexpected provider request: ${req.method} ${req.url}`);
    }
  };
  reservation = await reserveTestPortListener({
    offsets: [0], signal: stop.signal,
    createListener: () => createServer((req, res) => {
      handler(req, res).catch((error) => {
        receipt.serverErrors.push(describeError(error));
        if (!res.headersSent) { res.writeHead(400, { "content-type": "application/json" }); }
        res.end(JSON.stringify({ error: "proof fixture rejected an unexpected request" }));
      });
    }),
  });
  reservation.listener.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  receipt.baseUrl = `http://127.0.0.1:${reservation.claim.port}`;
  const configPath = path.join(taskState, "openclaw.json");
  await fs.writeFile(configPath, JSON.stringify({
    agents: { defaults: { workspace }, entries: { main: {} } },
    plugins: { allow: ["zai"], entries: { zai: { enabled: true } } },
    models: { providers: { zai: {
      baseUrl: receipt.baseUrl, apiKey: syntheticKey, api: "openai-completions",
      models: [], request: { allowPrivateNetwork: true },
    } } },
  }));
  const cliEnv = {
    PATH: process.env.PATH, HOME: taskHome, USERPROFILE: taskHome,
    TMPDIR: taskRoot, TMP: taskRoot, TEMP: taskRoot,
    CI: "true", GITHUB_ACTIONS: "true", RUNNER_OS: "Linux",
    OPENCLAW_HOME: taskHome, OPENCLAW_STATE_DIR: taskState,
    OPENCLAW_CONFIG_PATH: configPath, NO_COLOR: "1", FORCE_COLOR: "0", TERM: "dumb",
  };
  const cases = [
    { name: "ignored-json", ignored: true, json: true },
    { name: "ignored-text", ignored: true, json: false },
    { name: "supported-json", ignored: false, json: true },
    { name: "supported-text", ignored: false, json: false },
  ];
  for (const current of cases) {
    activeCase = current;
    const output = path.join(taskRoot, `${current.name}.mp4`);
    const result = await runCli(current.name, [
      "infer", "video", "generate", "--agent", "main", "--model", "zai/cogvideox-3",
      "--prompt", `video CLI proof ${current.name}`, "--output", output,
      ...(current.ignored ? ["--size", "4k", "--watermark"] : ["--size", "1920x1080", "--audio"]),
      ...(current.json ? ["--json"] : []),
    ], cliEnv);
    const written = await fs.readFile(output);
    assert.deepEqual(written, media, `${current.name}: preserve real media bytes`);
    result.savedMedia = { bytes: written.length, sha256: sha256(written), path: output };
    await fs.copyFile(output, path.join(evidenceDir, current.name, "result.mp4"));
    const requests = receipt.requests.filter((request) => request.case === current.name);
    assert.deepEqual(requests.map((request) => `${request.method} ${request.url}`), [
      "POST /videos/generations", `GET /async-result/${current.name}`, `GET /media/${current.name}.mp4`,
    ], `${current.name}: exactly one submit, immediate SUCCESS poll and media download`);
    assert.equal(receipt.serverErrors.length, 0);
    if (current.json) {
      const envelope = JSON.parse(result.stdout.trim());
      assert.equal(envelope.ok, true);
      assert.equal(envelope.capability, "video.generate");
      assert.equal(envelope.transport, "local");
      assert.equal(envelope.provider, "zai");
      assert.equal(envelope.model, "cogvideox-3");
      assert.equal(envelope.outputs.length, 1);
      assert.deepEqual(envelope.outputs[0], { path: output, mimeType: "video/mp4", size: media.length });
      if (current.ignored && mode === "original") {
        assert.equal(Object.hasOwn(envelope, "ignoredOverrides"), false);
        result.callerVisibleRegression = { passed: false, expected: expectedIgnored, actual: "missing field" };
      } else {
        assert.deepEqual(envelope.ignoredOverrides ?? [], current.ignored ? expectedIgnored : []);
        result.callerVisibleRegression = { passed: true };
      }
    } else {
      assert.ok(result.stdout.includes("video.generate via local"));
      assert.ok(result.stdout.includes("provider: zai"));
      assert.ok(result.stdout.includes("model: cogvideox-3"));
      assert.ok(result.stdout.includes("outputs: 1"));
      assert.ok(result.stdout.includes(output));
      const warning = `ignoredOverrides: ${JSON.stringify(expectedIgnored)}`;
      if (current.ignored && mode === "original") {
        assert.equal(result.stdout.includes("ignoredOverrides:"), false);
        result.callerVisibleRegression = { passed: false, expected: warning, actual: "missing warning" };
      } else {
        assert.equal(result.stdout.includes(warning), current.ignored);
        if (!current.ignored) { assert.equal(result.stdout.includes("ignoredOverrides:"), false); }
        result.callerVisibleRegression = { passed: true };
      }
    }
  }
  activeCase = undefined;
  assert.equal(receipt.requests.length, 12);
  assert.deepEqual(receipt.processErrors, []);
  assert.deepEqual(receipt.receivedSignals, []);
  assert.ok(receipt.requests.every((request) => !request.aborted && request.responseClosedEarly === false));
  receipt.stderrNonemptyCases = receipt.cases.filter((result) => result.stderr.trim()).map((result) => result.name);
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
    try {
      await reservation.claim.release();
      receipt.portClaimReleased = true;
    } catch (error) { receipt.cleanupErrors.push(describeError(error)); }
  }
  if (tempDirs && retainTemporaryInputs) {
    receipt.retainedTemporaryRoot = taskRoot;
    receipt.cleanupErrors.push({ message: "canonical cleanup reported unjoined work; temporary inputs retained" });
  } else if (tempDirs) {
    try {
      tempDirs.cleanup();
      assert.equal(tempDirs.dirs.size, 0);
      try {
        await fs.access(taskRoot);
        throw new Error("proof temporary root still exists after cleanup");
      } catch (error) {
        if (error.code !== "ENOENT") { throw error; }
      }
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

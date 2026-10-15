import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

// Run only after the controller's canonical qaRuntime build in secretless Actions.
assert.equal(process.env.GITHUB_ACTIONS, "true");
assert.equal(process.platform, "linux");
const source = process.cwd();
const output = process.env.PROOF_OUTPUT_DIR;
const mode = process.env.PROOF_MODE;
assert.ok(output && path.isAbsolute(output));
assert.ok(["baseline", "candidate"].includes(mode));
const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
assert.match(sourceSha, /^[a-f0-9]{40}$/u);
assert.equal(sourceSha, process.env.SOURCE_SHA);
assert.equal(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim(), "");
const buildStamp = JSON.parse(await fs.readFile("dist/.buildstamp", "utf8"));
assert.equal(buildStamp.head, sourceSha);
assert.equal(buildStamp.inputsClean, true);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const custodyFiles = [
  "dist/entry.js", "dist/.buildstamp", "package.json", "pnpm-lock.yaml",
  "extensions/browser/src/cli/browser-cli.ts",
  "extensions/browser/src/cli/browser-cli-actions-input/shared.ts",
  "extensions/browser/src/cli/browser-cli-actions-input/register.files-downloads.ts",
  "extensions/browser/src/gateway/browser-request.ts",
  "extensions/browser/src/browser/pw-session-dialogs.ts",
];
const sourceHashes = Object.fromEntries(await Promise.all(custodyFiles.map(async (file) => [
  file, hash(await fs.readFile(file)),
])));
const driverSha256 = hash(await fs.readFile(fileURLToPath(import.meta.url)));
const requireBrowser = createRequire(path.join(source, "extensions/browser/package.json"));
const { chromium } = requireBrowser("playwright-core");
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
assert.ok(executablePath && path.isAbsolute(executablePath));
await fs.access(executablePath);
await fs.mkdir(output, { recursive: true });
const root = await fs.mkdtemp(path.join(os.tmpdir(), "browser-dialog-cli-gateway-"));
const token = randomUUID();
const profiles = ["openclaw", "work"];
const receipt = {
  mode, sourceSha, buildStamp, sourceHashes, driverSha256,
  boundary: "supported pnpm openclaw processes -> real authenticated Gateway browser.request -> real browser owner -> two real Chromium profiles",
  limits: "Synthetic local confirm pages and token; no mock Gateway/routes/product functions; no release tarball, live website, vendor, audio, or operator-state claim.",
  calls: [], dialogs: [], settlements: [], profiles: [], readiness: [],
  pageErrors: [], fixtureErrors: [], errors: [], cleanup: {},
};
const sanitize = (value) => String(value).replaceAll(token, "[SYNTHETIC_TOKEN]")
  .replace(/\[gateway\] agent model:[^\r\n]*/gu, "[gateway] agent model: [NOT_INVOKED]");
const signalEvents = new EventEmitter();
const contexts = [];
const reservations = [];
const owned = [];
let gateway;
let gatewayPort;
let fixturePort;
let fixture;

async function listen(server, port = 0) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  return server.address().port;
}
async function close(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
async function reserve(port = 0) {
  const server = net.createServer();
  reservations.push(server);
  return { server, port: await listen(server, port) };
}
async function bounded(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); }),
    ]);
  } finally { clearTimeout(timer); }
}
function groupExists(pid) {
  try { process.kill(-pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
}
async function joinGroup(pid, budget = 15_000) {
  const deadline = Date.now() + budget;
  while (groupExists(pid) && Date.now() < deadline) await delay(50);
  assert.equal(groupExists(pid), false, "Owned process group must terminate naturally");
}
function signalGroup(owner, signal) {
  if (owner.child.pid && groupExists(owner.child.pid)) process.kill(-owner.child.pid, signal);
}
function spawnCli(args, label) {
  const observation = {
    label, argv: ["pnpm", "--silent", "openclaw", ...args],
    stdout: "", stderr: "", processGroupGone: false, startedAt: new Date().toISOString(),
  };
  receipt.calls.push(observation);
  const child = spawn("pnpm", ["--silent", "openclaw", ...args], {
    cwd: source, env: cliEnv, detached: true, stdio: ["ignore", "pipe", "pipe"],
  });
  const owner = { child, observation, closed: undefined };
  owned.push(owner);
  observation.pid = child.pid;
  const capture = (stream, chunk) => {
    if (observation.overflow) return;
    observation[stream] += chunk.toString();
    if (observation[stream].length > 1_000_000 && !observation.overflow) {
      observation.overflow = true;
      receipt.errors.push(`${label}: output capture overflow`);
      signalGroup(owner, "SIGTERM");
    }
    signalEvents.emit("output");
  };
  child.stdout.on("data", (chunk) => capture("stdout", chunk));
  child.stderr.on("data", (chunk) => capture("stderr", chunk));
  owner.closed = new Promise((resolve) => {
    child.once("error", (error) => {
      observation.spawnError = error.message;
      signalEvents.emit("output");
    });
    child.once("close", (code, signal) => {
      observation.exit = { code, signal };
      observation.closedAt = new Date().toISOString();
      signalEvents.emit("output");
      resolve(observation.exit);
    });
  });
  return owner;
}
async function cli(args, label) {
  const owner = spawnCli(args, label);
  const exit = await bounded(owner.closed, 90_000, `${label}: CLI command timed out`);
  assert.ok(owner.child.pid, `${label}: child PID missing`);
  await joinGroup(owner.child.pid);
  owner.observation.processGroupGone = true;
  assert.equal(owner.observation.spawnError, undefined);
  assert.equal(owner.observation.overflow, undefined);
  assert.deepEqual(exit, { code: 0, signal: null }, `${label}: CLI exit failure`);
  assert.equal(owner.observation.stderr.trim(), "", `${label}: unexpected CLI stderr`);
  return owner.observation;
}
async function waitForSettlement(index) {
  if (receipt.settlements.length <= index) {
    await once(signalEvents, "settled", { signal: AbortSignal.timeout(10_000) });
  }
  assert.ok(receipt.settlements[index], "Missing actual confirm() settlement receipt");
  return receipt.settlements[index];
}
function dialogHint(call) {
  const line = call.stdout.split(/\r?\n/u).find((entry) => entry.includes("Use openclaw browser"));
  const command = line?.match(/Use (openclaw browser .+) to continue\./u)?.[1];
  const ids = [...(line?.matchAll(/"(d\d+)"/gu) ?? [])].map((match) => match[1]);
  assert.deepEqual(ids, ["d1"], "Real first dialog must be reported as d1");
  assert.ok(command?.includes("--accept or --dismiss"));
  assert.ok(command.includes("--dialog-id <id>"));
  return { line, command, id: ids[0] };
}
const cliEnv = {
  PATH: process.env.PATH, CI: "true", GITHUB_ACTIONS: "true", LANG: "C.UTF-8",
  NO_COLOR: "1", TERM: "dumb",
  HOME: root, OPENCLAW_HOME: root,
  XDG_CONFIG_HOME: path.join(root, "config"), XDG_CACHE_HOME: path.join(root, "cache"),
  OPENCLAW_STATE_DIR: path.join(root, "state"),
  OPENCLAW_CONFIG_PATH: path.join(root, "state", "openclaw.json"),
  OPENCLAW_SKIP_CHANNELS: "1", OPENCLAW_SKIP_PROVIDERS: "1",
  OPENCLAW_SKIP_GMAIL_WATCHER: "1", OPENCLAW_SKIP_CRON: "1", OPENCLAW_SKIP_CANVAS_HOST: "1",
};

try {
  fixture = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/settled") {
      const profile = url.searchParams.get("profile");
      const accepted = url.searchParams.get("accepted");
      if (request.method !== "GET" || !profiles.includes(profile) || !["true", "false"].includes(accepted)) {
        receipt.fixtureErrors.push(`Invalid confirm settlement: ${request.method} ${url.pathname}`);
        response.writeHead(400).end();
        return;
      }
      receipt.settlements.push({ profile, accepted: accepted === "true" });
      response.writeHead(204).end();
      signalEvents.emit("settled");
      return;
    }
    if (url.pathname === "/favicon.ico") { response.writeHead(204).end(); return; }
    if (request.method !== "GET" || url.pathname !== "/" || !profiles.includes(url.searchParams.get("profile"))) {
      receipt.fixtureErrors.push(`Unexpected page request: ${request.method} ${request.url}`);
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><meta charset="utf-8"><title>CLI profile dialog proof</title>
      <button id="confirm" style="position:fixed;left:0;top:0;width:200px;height:80px">Confirm</button>
      <output id="outcome">pending</output>
      <script>
        const profile = new URL(location.href).searchParams.get("profile");
        document.querySelector("#confirm").onclick = () => {
          const accepted = confirm("Confirm for " + profile);
          document.querySelector("#outcome").textContent = accepted ? "accepted" : "dismissed";
          void fetch("/settled?profile=" + profile + "&accepted=" + accepted);
        };
      </script>`);
  });
  fixturePort = await listen(fixture);
  const gatewayReservation = await reserve();
  gatewayPort = gatewayReservation.port;
  // The default extension relay derives Gateway+10. Reserve it, plus the sandbox
  // and browser-control neighbors, before startup; never evict an existing owner.
  assert.ok(gatewayPort < 65_435, "Gateway port leaves room for derived browser ports");
  for (const offset of [1, 2, 10]) await reserve(gatewayPort + offset);
  for (const profile of profiles) {
    const cdpReservation = await reserve();
    const cdpUrl = `http://127.0.0.1:${cdpReservation.port}`;
    await close(cdpReservation.server);
    const context = await chromium.launchPersistentContext(path.join(root, "chromium", profile), {
      headless: true, executablePath,
      args: [`--remote-debugging-port=${cdpReservation.port}`],
    });
    const row = { profile, cdpUrl, port: cdpReservation.port, context };
    contexts.push(row);
    const page = context.pages()[0] ?? await context.newPage();
    row.page = page;
    // This fixture client must observe and hold, never accept/dismiss. The actual
    // CLI through the actual Gateway is the only dialog settlement owner.
    page.on("dialog", (dialog) => receipt.dialogs.push({
      profile, type: dialog.type(), message: dialog.message(),
    }));
    page.on("pageerror", (error) => receipt.pageErrors.push(`${profile}: ${error.message}`));
    await page.goto(`http://127.0.0.1:${fixturePort}/?profile=${profile}`);
    const session = await context.newCDPSession(page);
    const { targetInfo } = await session.send("Target.getTargetInfo");
    row.targetId = targetInfo.targetId;
    await session.detach();
    receipt.profiles.push({ profile, cdpUrl, targetId: row.targetId, pageUrl: page.url() });
  }
  const config = {
    gateway: {
      mode: "local", bind: "loopback", port: gatewayPort,
      auth: { mode: "token", token }, controlUi: { enabled: false },
      nodes: { browser: { mode: "off" } },
    },
    agents: {
      ownership: "explicit", defaults: { systemAgent: { agentId: "main" } },
      entries: { main: { workspace: path.join(root, "workspace"), agentDir: path.join(root, "state", "agents", "main", "agent") } },
    },
    plugins: { enabled: true, allow: ["browser"], slots: { memory: "none" }, entries: { browser: { enabled: true } } },
    browser: {
      enabled: true, defaultProfile: "openclaw", tabCleanup: { enabled: false },
      ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
      profiles: Object.fromEntries(contexts.map(({ profile, cdpUrl }) => [profile, { cdpUrl, attachOnly: true }])),
    },
    skills: { load: { watch: false }, workshop: { autonomous: { mode: "off" } } },
    cron: { enabled: false }, discovery: { mdns: { mode: "off" } },
  };
  receipt.config = config;
  await fs.mkdir(path.dirname(cliEnv.OPENCLAW_CONFIG_PATH), { recursive: true });
  await fs.mkdir(path.join(root, "workspace"), { recursive: true });
  await fs.writeFile(cliEnv.OPENCLAW_CONFIG_PATH, JSON.stringify(config));
  for (const reservation of reservations) if (reservation.listening) await close(reservation);
  gateway = spawnCli(["gateway", "run", "--port", String(gatewayPort), "--bind", "loopback"], "gateway");
  await bounded((async () => {
    while (!/\[gateway\] ready(?:\r?\n|$)/u.test(`${gateway.observation.stdout}\n${gateway.observation.stderr}`)) {
      assert.equal(gateway.observation.exit, undefined, "Gateway exited before readiness");
      assert.equal(gateway.observation.spawnError, undefined);
      await once(signalEvents, "output", { signal: AbortSignal.timeout(120_000) });
    }
  })(), 120_000, "Gateway did not publish ready within startup budget");
  for (const endpoint of ["/readyz", "/startupz"]) {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}${endpoint}`, {
      headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5_000),
    });
    const raw = await response.text();
    const body = JSON.parse(raw);
    receipt.readiness.push({ endpoint, status: response.status, body });
    assert.equal(response.status, 200);
    if (endpoint === "/readyz") assert.equal(body.ready, true);
    else { assert.equal(body.ok, true); assert.equal(body.status, "started"); }
  }
  for (const { profile, targetId } of contexts) {
    const snapshot = await cli(["browser", "--browser-profile", profile, "--json", "snapshot", "--format", "ai", "--interactive"], `${profile}-snapshot`);
    const body = JSON.parse(snapshot.stdout);
    assert.equal(body.targetId, targetId);
    assert.equal(body.format, "ai");
  }
  const defaultClick = await cli(["browser", "--browser-profile", "openclaw", "click-coords", "40", "40"], "openclaw-click");
  receipt.defaultHint = dialogHint(defaultClick);
  const workClick = await cli(["browser", "--browser-profile", "work", "click-coords", "40", "40"], "work-click");
  receipt.workHint = dialogHint(workClick);
  assert.deepEqual(receipt.dialogs, [
    { profile: "openclaw", type: "confirm", message: "Confirm for openclaw" },
    { profile: "work", type: "confirm", message: "Confirm for work" },
  ]);
  assert.deepEqual(receipt.settlements, []);
  // Substitute only the action and ID choices requested in the printed hint.
  // Never append a browser profile, target, URL, token, or other routing repair.
  receipt.replayCommand = receipt.workHint.command.replace("--accept or --dismiss", "--accept")
    .replace("--dialog-id <id>", `--dialog-id ${receipt.workHint.id}`);
  const argv = receipt.replayCommand.split(/\s+/u);
  assert.equal(argv.shift(), "openclaw");
  assert.ok(argv.every((word) => /^[a-z0-9=-]+$/u.test(word)), "Synthetic printed argv must need no shell interpretation");
  await cli(argv, "literal-work-hint-replay");
  receipt.firstSettlement = await waitForSettlement(0);
  assert.equal(receipt.firstSettlement.accepted, true);
  assert.equal(receipt.settlements.length, 1);
  const remaining = receipt.firstSettlement.profile === "work" ? "openclaw" : "work";
  // Success on the still-pending d1 proves this profile was not already settled.
  await cli(["browser", "--browser-profile", remaining, "dialog", "--dismiss", "--dialog-id", "d1"], "explicit-remaining-dialog-control");
  receipt.secondSettlement = await waitForSettlement(1);
  assert.deepEqual(receipt.secondSettlement, { profile: remaining, accepted: false });
  assert.equal(receipt.settlements.length, 2);
  receipt.finalDom = Object.fromEntries(await Promise.all(contexts.map(async ({ profile, page }) => [
    profile, await page.locator("#outcome").textContent(),
  ])));
  assert.equal(receipt.finalDom[receipt.firstSettlement.profile], "accepted");
  assert.equal(receipt.finalDom[remaining], "dismissed");
  receipt.behaviorFailures = [
    receipt.firstSettlement.profile !== "work" && "printed-work-hint-accepted-default-dialog",
    receipt.secondSettlement.profile !== "openclaw" && "selected-work-dialog-remained-pending",
  ].filter(Boolean);
  if (mode === "baseline") {
    assert.deepEqual(receipt.behaviorFailures, [
      "printed-work-hint-accepted-default-dialog", "selected-work-dialog-remained-pending",
    ], "Baseline must reproduce the exact wrong-profile outcome");
    receipt.expectedBaselineReproduced = true;
  }
} catch (error) {
  receipt.errors.push(sanitize(error.stack ?? error));
} finally {
  // First let the Gateway's own service shutdown release its CDP connections.
  for (const owner of owned) {
    const label = owner.observation.label;
    if (!owner.child.pid) continue;
    try {
      if (!owner.observation.exit) {
        owner.observation.shutdownRequested = "SIGTERM";
        signalGroup(owner, "SIGTERM");
      }
      const exit = await bounded(owner.closed, 30_000, `${label}: shutdown did not join`);
      await joinGroup(owner.child.pid, 15_000);
      owner.observation.processGroupGone = true;
      if (label === "gateway") {
        assert.ok(exit.code === 0 && exit.signal === null || exit.signal === "SIGTERM" || exit.code === 143, `Unexpected Gateway exit ${JSON.stringify(exit)}`);
      }
    } catch (error) {
      receipt.errors.push(`${label} cleanup: ${error.message}`);
      owner.observation.forcedKill = true;
      try { signalGroup(owner, "SIGKILL"); await bounded(owner.closed, 5_000, `${label}: forced close did not join`); await joinGroup(owner.child.pid, 5_000); }
      catch (cleanupError) { receipt.errors.push(`${label} forced cleanup: ${cleanupError.message}`); }
    }
  }
  receipt.cleanup.chromiumContextsClosed = [];
  for (const row of contexts) {
    try { await bounded(row.context.close(), 15_000, `${row.profile}: Chromium close did not join`); receipt.cleanup.chromiumContextsClosed.push(row.profile); }
    catch (error) { receipt.errors.push(error.message); }
  }
  if (fixture?.listening) {
    try { fixture.closeAllConnections(); await close(fixture); receipt.cleanup.fixtureClosed = true; }
    catch (error) { receipt.errors.push(`Fixture close: ${error.message}`); }
  }
  for (const reservation of reservations) {
    if (!reservation.listening) continue;
    try { await close(reservation); }
    catch (error) { receipt.errors.push(`Port reservation cleanup: ${error.message}`); }
  }
  receipt.cleanup.portRebinds = [];
  for (const port of new Set([gatewayPort, gatewayPort && gatewayPort + 1, gatewayPort && gatewayPort + 2, gatewayPort && gatewayPort + 10, fixturePort, ...contexts.map((row) => row.port)].filter(Boolean))) {
    const probe = net.createServer();
    try { await listen(probe, port); await close(probe); receipt.cleanup.portRebinds.push({ port, passed: true }); }
    catch (error) { receipt.cleanup.portRebinds.push({ port, passed: false }); receipt.errors.push(`Port ${port} retained after owned cleanup: ${error.message}`); }
  }
  try {
    assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), sourceSha);
    assert.equal(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim(), "");
    for (const [file, expected] of Object.entries(sourceHashes)) assert.equal(hash(await fs.readFile(file)), expected, `Source/build custody changed: ${file}`);
    assert.equal(hash(await fs.readFile(fileURLToPath(import.meta.url))), driverSha256);
    receipt.finalSourceCustodyPassed = true;
  } catch (error) { receipt.errors.push(error.message); }
  if (gateway) {
    const unexpected = `${gateway.observation.stdout}\n${gateway.observation.stderr}`.split(/\r?\n/u)
      .filter((line) => /\b(?:ERROR|FATAL|uncaughtException|unhandledRejection)\b|Gateway failed to start|SyntaxError|TypeError|ReferenceError/u.test(line));
    if (unexpected.length) receipt.errors.push(`Gateway runtime errors: ${sanitize(unexpected.join("\n"))}`);
  }
  const allGroupsGone = owned.every((owner) => !owner.child.pid || !groupExists(owner.child.pid));
  receipt.cleanup.allOwnedProcessGroupsGone = allGroupsGone;
  if (!allGroupsGone) receipt.errors.push("An owned CLI/Gateway process group remains");
  const resourcesSettled = allGroupsGone && receipt.cleanup.chromiumContextsClosed.length === contexts.length
    && receipt.cleanup.portRebinds.every((entry) => entry.passed);
  if (resourcesSettled) {
    try {
      assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
      assert.ok(path.basename(root).startsWith("browser-dialog-cli-gateway-"));
      await fs.rm(root, { recursive: true });
      receipt.cleanup.isolatedStateRemoved = true;
    } catch (error) { receipt.errors.push(`Owned scratch cleanup: ${error.message}`); }
  } else receipt.cleanup.retainedIsolatedRoot = root;
  for (const [index, call] of receipt.calls.entries()) {
    await fs.writeFile(path.join(output, `cli-${index}-${call.label}.stdout.log`), sanitize(call.stdout));
    await fs.writeFile(path.join(output, `cli-${index}-${call.label}.stderr.log`), sanitize(call.stderr));
  }
  receipt.targetContractPassed = receipt.behaviorFailures?.length === 0 && receipt.errors.length === 0
    && receipt.pageErrors.length === 0 && receipt.fixtureErrors.length === 0;
  // Redact string values before JSON encoding. Redacting an already encoded log
  // could consume its escaped newlines and closing quote, corrupting the receipt.
  await fs.writeFile(path.join(output, "cli-dialog-profile-receipt.json"), JSON.stringify(
    receipt, (_key, value) => typeof value === "string" ? sanitize(value) : value, 2,
  ) + "\n");
}
assert.deepEqual(receipt.errors, [], "Harness, CLI, Gateway, or cleanup failures cannot count as product proof");
assert.deepEqual(receipt.pageErrors, [], "Real page runtime must stay clean");
assert.deepEqual(receipt.fixtureErrors, [], "Unexpected loopback I/O cannot count as proof");
assert.deepEqual(receipt.behaviorFailures, [], "Literal work-profile recovery must not settle the default dialog; baseline remains genuinely RED");
console.log(JSON.stringify({ mode, sourceSha, calls: receipt.calls.length, targetContractPassed: receipt.targetContractPassed, cleanup: receipt.cleanup }));

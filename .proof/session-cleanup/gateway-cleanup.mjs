import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
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
const root = await mkdtemp(path.join(os.tmpdir(), "session-cleanup-proof-"));
const token = randomUUID();
const pluginId = "session-cleanup-proof";
const pluginRoot = path.join(root, "fixture-plugin");
const callbackFile = path.join(output, "callback-events.jsonl");
const logFile = path.join(root, "gateway.log");
const receipt = { mode, sourceSha, buildStamp, entrySha256, calls: [], callbacks: [], warnings: {}, cleanup: {}, errors: [] };
const sanitize = (value) => String(value)
  .replaceAll(token, "[SYNTHETIC_TOKEN]")
  .replaceAll("127.0.0.1", "[LOOPBACK]")
  .replace(/\[gateway\] agent model:[^\r\n]*/gu, "[gateway] agent model: [NOT_INVOKED]");
await mkdir(pluginRoot, { recursive: true });
await writeFile(path.join(pluginRoot, "package.json"), JSON.stringify({
  name: "@proof/session-cleanup", version: "0.0.0", type: "module", openclaw: { extensions: ["./index.js"] },
}));
await writeFile(path.join(pluginRoot, "openclaw.plugin.json"), JSON.stringify({
  id: pluginId, name: "Synthetic session cleanup proof", activation: { onStartup: true },
  configSchema: { type: "object", properties: {}, additionalProperties: false },
}));
await writeFile(path.join(pluginRoot, "index.js"), `
import { appendFileSync } from "node:fs";
const record = (event) => appendFileSync(${JSON.stringify(callbackFile)}, JSON.stringify(event) + "\\n");
export default {
  id: ${JSON.stringify(pluginId)},
  register(api) {
    record({ hook: "registered", pluginId: api.id });
    for (const id of ["throwing", "sibling"]) {
      api.lifecycle.registerRuntimeLifecycle({ id, cleanup({ reason, sessionKey }) {
        if (!["reset", "delete"].includes(reason) || !sessionKey?.startsWith("agent:main:cleanup-proof-")) return;
        record({ hook: id, reason, sessionKey });
        if (id === "throwing" && sessionKey.endsWith("-fail")) {
          throw new Error("cleanup-proof " + reason + " " + sessionKey);
        }
      } });
    }
  }
};
`);
const reservation = createServer();
await new Promise((resolve, reject) => {
  reservation.once("error", reject);
  reservation.listen(0, "127.0.0.1", resolve);
});
const port = reservation.address().port;
const configPath = path.join(root, "state", "openclaw.json");
await mkdir(path.dirname(configPath), { recursive: true });
await mkdir(path.join(root, "workspace"), { recursive: true });
await writeFile(configPath, JSON.stringify({
  gateway: { mode: "local", bind: "loopback", port, auth: { mode: "token", token }, controlUi: { enabled: false } },
  logging: { file: logFile },
  agents: { defaults: { workspace: path.join(root, "workspace") }, entries: { main: {} } },
  plugins: { enabled: true, allow: [pluginId], load: { paths: [pluginRoot] }, entries: { [pluginId]: { enabled: true } }, slots: { memory: "none" } },
  cron: { enabled: false },
}));
const env = {
  PATH: process.env.PATH, CI: "true", GITHUB_ACTIONS: "true", LANG: "C.UTF-8", TERM: "dumb", NO_COLOR: "1",
  HOME: root, OPENCLAW_HOME: root, XDG_CONFIG_HOME: path.join(root, "config"), XDG_CACHE_HOME: path.join(root, "cache"),
  OPENCLAW_STATE_DIR: path.join(root, "state"), OPENCLAW_CONFIG_PATH: configPath,
  OPENCLAW_SKIP_CHANNELS: "1", OPENCLAW_SKIP_PROVIDERS: "1", OPENCLAW_SKIP_GMAIL_WATCHER: "1",
  OPENCLAW_SKIP_CRON: "1", OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1", OPENCLAW_SKIP_CANVAS_HOST: "1",
};
async function bounded(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); })]);
  } finally { clearTimeout(timer); }
}
async function joinGroup(pid, deadline) {
  while (true) {
    try { process.kill(-pid, 0); }
    catch (error) { if (error.code === "ESRCH") return; throw error; }
    if (Date.now() >= deadline) throw new Error("Gateway process group did not exit within shutdown budget");
    await new Promise((resolve) => setTimeout(resolve, Math.min(50, deadline - Date.now())));
  }
}
let stdout = "";
let stderr = "";
let child;
let closed;
async function call(method, sessionKey) {
  const cli = spawn("pnpm", ["--silent", "openclaw", "gateway", "call", method, "--params", JSON.stringify({ key: sessionKey }),
    "--url", `ws://127.0.0.1:${port}`, "--token", token, "--json"], { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let cliStdout = "";
  let cliStderr = "";
  cli.stdout.on("data", (chunk) => { cliStdout += chunk.toString(); });
  cli.stderr.on("data", (chunk) => { cliStderr += chunk.toString(); });
  const cliClosed = new Promise((resolve) => {
    cli.once("error", (error) => resolve({ error: error.message }));
    cli.once("close", (code, signal) => resolve({ code, signal }));
  });
  let result;
  let groupGone = false;
  try {
    result = await bounded(cliClosed, 90_000, `${method} command budget exhausted`);
    assert.equal(result.error, undefined);
    assert.equal(result.code, 0, sanitize(cliStderr));
    await joinGroup(cli.pid, Date.now() + 15_000);
    groupGone = true;
  }
  finally {
    if (!groupGone && cli.pid) {
      const deadline = Date.now() + 15_000;
      try {
        try { process.kill(-cli.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
        await bounded(cliClosed, Math.max(1, deadline - Date.now()), "CLI shutdown did not join");
        await joinGroup(cli.pid, deadline);
      }
      catch (error) {
        receipt.errors.push(error.message);
        receipt.cleanup.cliForcedKill = true;
        try { process.kill(-cli.pid, "SIGKILL"); } catch (killError) { if (killError.code !== "ESRCH") receipt.errors.push(killError.message); }
        try { await bounded(cliClosed, 5_000, "Forced CLI cleanup did not join"); } catch (joinError) { receipt.errors.push(joinError.message); }
      }
    }
    const redactOutput = (value) => sanitize(value).replace(/("(?:model|modelProvider)"\s*:\s*)"[^"]*"/gu, '$1"[NOT_INVOKED]"');
    await writeFile(path.join(output, `cli-${receipt.calls.length}.stdout.log`), redactOutput(cliStdout));
    await writeFile(path.join(output, `cli-${receipt.calls.length}.stderr.log`), redactOutput(cliStderr));
  }
  const body = JSON.parse(cliStdout.trim());
  assert.equal(body.ok, true, `${method} must succeed despite best-effort callback failure`);
  assert.equal(body.key, sessionKey);
  if (method === "sessions.delete") assert.equal(body.deleted, true);
  else assert.equal(typeof body.entry.sessionId, "string");
  receipt.calls.push({ method, key: body.key, ok: body.ok, deleted: body.deleted,
    sessionId: body.entry?.sessionId, lifecycleRevision: body.entry?.lifecycleRevision, cliProcessGroupGone: true });
  return body;
}
try {
  await new Promise((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
  let signalReady;
  const ready = new Promise((resolve) => { signalReady = resolve; });
  child = spawn("pnpm", ["openclaw", "gateway", "run", "--port", String(port), "--bind", "loopback"], {
    env, detached: true, stdio: ["ignore", "pipe", "pipe"],
  });
  for (const [name, stream] of [["stdout", child.stdout], ["stderr", child.stderr]]) {
    stream.on("data", (chunk) => {
      if (name === "stdout") stdout += chunk.toString(); else stderr += chunk.toString();
      if (/\[gateway\] ready(?:\r?\n|$)/u.test(`${stdout}\n${stderr}`)) signalReady();
    });
  }
  closed = new Promise((resolve) => {
    child.once("error", (error) => resolve({ error: error.message }));
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  await bounded(Promise.race([ready, closed.then((exit) => { throw new Error(`Gateway closed before readiness: ${JSON.stringify(exit)}`); })]), 120_000, "Gateway startup budget exhausted");
  const readiness = await fetch(`http://127.0.0.1:${port}/readyz`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5_000) });
  assert.equal(readiness.status, 200);
  assert.equal((await readiness.json()).ready, true);
  for (const suffix of ["fail", "good"]) {
    const key = `agent:main:cleanup-proof-${suffix}`;
    const initial = await call("sessions.reset", key);
    const reset = await call("sessions.reset", key);
    assert.equal(reset.entry.sessionId, initial.entry.sessionId);
    assert.equal(typeof reset.entry.lifecycleRevision, "string");
    assert.notEqual(reset.entry.lifecycleRevision, initial.entry.lifecycleRevision);
    await call("sessions.delete", key);
  }
  assert.equal(createHash("sha256").update(await readFile("dist/entry.js")).digest("hex"), entrySha256);
} catch (error) { receipt.errors.push(sanitize(error.stack ?? error)); }
finally {
  if (child?.pid && closed) {
    const deadline = Date.now() + 15_000;
    try {
      process.kill(-child.pid, "SIGTERM");
      receipt.cleanup.childExit = await bounded(closed, Math.max(1, deadline - Date.now()), "Gateway shutdown did not join");
      await joinGroup(child.pid, deadline);
      receipt.cleanup.processGroupGone = true;
    } catch (error) {
      receipt.errors.push(error.message);
      receipt.cleanup.forcedKill = true;
      try { process.kill(-child.pid, "SIGKILL"); } catch (killError) { if (killError.code !== "ESRCH") receipt.errors.push(killError.message); }
      try { receipt.cleanup.childExit = await bounded(closed, 5_000, "Forced cleanup did not join"); } catch (joinError) { receipt.errors.push(joinError.message); }
    }
    const exit = receipt.cleanup.childExit;
    if (exit?.error || !(exit?.signal === "SIGTERM" || [0, 143].includes(exit?.code))) receipt.errors.push(`Unexpected Gateway exit: ${JSON.stringify(exit)}`);
  }
  if (reservation.listening) await new Promise((resolve) => reservation.close(resolve));
  const probe = createServer();
  try {
    await new Promise((resolve, reject) => { probe.once("error", reject); probe.listen(port, "127.0.0.1", resolve); });
    await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
    receipt.cleanup.portRebindable = true;
  } catch (error) { receipt.errors.push(error.message); }
  await writeFile(path.join(output, "gateway.stdout.log"), sanitize(stdout));
  await writeFile(path.join(output, "gateway.stderr.log"), sanitize(stderr));
  try {
    const callbacks = (await readFile(callbackFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    receipt.callbacks = callbacks;
    assert.ok(callbacks.some((row) => row.hook === "registered" && row.pluginId === pluginId));
    const events = callbacks.filter((row) => row.hook !== "registered");
    assert.deepEqual(events, receipt.calls.flatMap(({ method, key }) => ["throwing", "sibling"].map((hook) => ({ hook, reason: method === "sessions.reset" ? "reset" : "delete", sessionKey: key }))));
    const rawLog = await readFile(logFile, "utf8");
    const records = rawLog.trim().split("\n").map((line) => JSON.parse(line));
    for (const reason of ["reset", "delete"]) {
      const message = `plugin host cleanup failed for ${pluginId}/runtime:throwing: Error: cleanup-proof ${reason} agent:main:cleanup-proof-fail`;
      receipt.warnings[reason] = records.filter((record) => record._meta?.logLevelName === "WARN" && Object.values(record).includes(message)).length;
    }
    assert.ok(!rawLog.includes("cleanup-proof reset agent:main:cleanup-proof-good"));
    assert.ok(!rawLog.includes("cleanup-proof delete agent:main:cleanup-proof-good"));
    const visibleLines = rawLog.split("\n").filter((line) => line.includes("plugin host cleanup failed for "));
    await writeFile(path.join(output, "cleanup-warning-records.log"), sanitize(visibleLines.join("\n") + "\n"));
  } catch (error) { receipt.errors.push(sanitize(error.stack ?? error)); }
  const missing = Object.entries({ reset: 2, delete: 1 }).filter(([reason, expected]) => receipt.warnings[reason] !== expected).map(([reason]) => reason);
  receipt.behaviorFailures = missing;
  if (mode === "baseline" && receipt.errors.length === 0) {
    try { assert.deepEqual(receipt.warnings, { reset: 0, delete: 0 }); assert.deepEqual(missing, ["reset", "delete"]); receipt.expectedBaselineReproduced = true; }
    catch (error) { receipt.errors.push(sanitize(error.stack ?? error)); }
  }
  await writeFile(path.join(output, "receipt.json"), JSON.stringify(receipt, null, 2));
}
assert.equal(receipt.errors.length, 0, JSON.stringify(receipt.errors));
assert.deepEqual(receipt.behaviorFailures, [], "Default logging hides reset/delete cleanup failures; baseline remains a real failed run");
console.log(JSON.stringify(receipt));

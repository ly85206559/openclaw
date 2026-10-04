import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const [mode, sourceSha, reportPath] = process.argv.slice(2);
assert.ok(mode === "red" || mode === "green", "mode must be red or green");
assert.match(sourceSha ?? "", /^[a-f0-9]{40}$/);
assert.ok(reportPath, "report path is required");
assert.equal(process.platform, "linux", "this proof requires Linux /proc");
const candidate = await fs.realpath(process.cwd());
assert.equal(execFileSync("git", ["-c", `safe.directory=${candidate}`, "rev-parse", "HEAD"],
  { cwd: candidate, encoding: "utf8" }).trim(), sourceSha, "candidate identity");
const taskRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cache-contract-"));
const installCwd = path.join(taskRoot, "installer");
await fs.mkdir(installCwd);
const playwrightRoot = await fs.realpath(path.join(candidate, "extensions/browser/node_modules/playwright-core"));
assert.equal(JSON.parse(await fs.readFile(path.join(playwrightRoot, "package.json"), "utf8")).version, "1.63.0");
const installer = path.join(playwrightRoot, "cli.js");
const baseEnv = {
  PATH: process.env.PATH, LANG: "C.UTF-8", CI: "1", NO_COLOR: "1", FORCE_COLOR: "0",
  HOME: path.join(taskRoot, "home"), XDG_CACHE_HOME: path.join(taskRoot, "empty-cache"),
  XDG_CONFIG_HOME: path.join(taskRoot, "xdg-config"),
  OPENCLAW_SKIP_CHANNELS: "1", OPENCLAW_SKIP_PROVIDERS: "1",
  // Isolated HOME must retain exact trust for this task-owned checkout, not host credentials.
  GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.directory", GIT_CONFIG_VALUE_0: candidate,
};
await fs.mkdir(baseEnv.HOME);
const report = { mode, sourceSha, playwrightVersion: "1.63.0", cases: [], passed: false };

async function command(executable, args, env, cwd = installCwd, timeoutMs = 180_000) {
  const child = spawn(executable, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    process.kill(-child.pid, "SIGTERM");
  }, timeoutMs);
  try {
    const [code, signal] = await once(child, "close");
    assert.equal(timedOut, false, `${executable} timed out: ${stderr}\n${stdout}`);
    return { code, signal, stdout, stderr };
  } finally { clearTimeout(timer); }
}

function requireSuccess(result, label) {
  assert.equal(result.code, 0, `${label}: ${result.stderr}\n${result.stdout}`);
  return result;
}

function parseCliJson(result, label) {
  requireSuccess(result, label);
  // pnpm prints its script header before the CLI's JSON response.
  const lines = result.stdout.split("\n");
  const first = lines.findIndex((line) => line.trimStart().startsWith("{"));
  assert.ok(first >= 0, `${label}: missing JSON response`);
  return JSON.parse(lines.slice(first).join("\n"));
}

async function freePorts() {
  const holders = [];
  try {
    for (let i = 0; i < 4; i++) {
      const holder = net.createServer();
      const gatewayPort = holders[0]?.address().port;
      holder.listen(i === 1 || i === 2 ? gatewayPort + i : 0, "127.0.0.1");
      await once(holder, "listening");
      holders.push(holder);
    }
    return [holders[0].address().port, holders[3].address().port];
  } finally { await Promise.all(holders.map((holder) => new Promise((resolve) => holder.close(resolve)))); }
}

async function jsonFetch(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(5_000) });
  assert.ok(response.ok, `${url}: HTTP ${response.status}`);
  return response.json();
}

async function until(label, predicate, timeoutMs = 30_000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (await predicate()) return;
    await delay(100);
  }
  throw new Error(`${label} did not complete within ${timeoutMs} ms`);
}

async function withDeadline(promise, label, timeoutMs) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

async function assertPortClosed(port) {
  await assert.rejects(new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => { socket.destroy(); resolve(); });
    socket.once("error", reject);
    socket.setTimeout(2_000, () => { socket.destroy(); reject(new Error("closure probe timed out")); });
  }), { code: "ECONNREFUSED" });
}

async function pidAlive(pid) {
  try { await fs.access(`/proc/${pid}`); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

async function gatewayIdentity(port, configPath) {
  const hexPort = port.toString(16).toUpperCase().padStart(4, "0");
  const table = await fs.readFile("/proc/net/tcp", "utf8");
  const inodes = new Set(table.split("\n").slice(1).flatMap((line) => {
    const fields = line.trim().split(/\s+/);
    return fields[1]?.endsWith(`:${hexPort}`) && fields[3] === "0A" ? [fields[9]] : [];
  }));
  for (const pid of (await fs.readdir("/proc")).filter((entry) => /^\d+$/.test(entry))) {
    try {
      const environment = (await fs.readFile(`/proc/${pid}/environ`, "utf8")).split("\0");
      if (!environment.includes(`OPENCLAW_CONFIG_PATH=${configPath}`)) continue;
      const descriptors = await fs.readdir(`/proc/${pid}/fd`);
      const links = await Promise.all(descriptors.map((fd) => fs.readlink(`/proc/${pid}/fd/${fd}`).catch(() => "")));
      if (!links.some((link) => inodes.has(/^socket:\[(\d+)\]$/.exec(link)?.[1]))) continue;
      const cwd = await fs.realpath(`/proc/${pid}/cwd`);
      const initCwd = environment.find((entry) => entry.startsWith("INIT_CWD="))?.slice(9);
      assert.equal(cwd, candidate, "Gateway working directory");
      assert.equal(initCwd, installCwd, "pnpm must preserve the actual invocation directory");
      return { pid: Number(pid), cwd, initCwd };
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "EACCES" || error.code === "ESRCH") continue;
      throw error;
    }
  }
  throw new Error("could not identify the task-owned Gateway listener");
}

async function cdpReadback(port, name) {
  const title = `cache-contract-${name}`, text = "Chromium launched through the OpenClaw CLI";
  const url = `data:text/html,${encodeURIComponent(`<title>${title}</title><body>${text}</body>`)}`;
  const target = await jsonFetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  try {
    await withDeadline(opened, "CDP WebSocket open", 10_000);
    let sequence = 0;
    const send = (method, params) => new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { cleanup(); reject(new Error(`CDP ${method} timed out`)); }, 10_000);
      const onMessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.id !== id) return;
        cleanup();
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.result);
      };
      const cleanup = () => { clearTimeout(timer); socket.removeEventListener("message", onMessage); };
      socket.addEventListener("message", onMessage);
      socket.send(JSON.stringify({ id, method, params }));
    });
    let observed;
    await until("data URL document", async () => {
      const result = await send("Runtime.evaluate", {
        expression: "JSON.stringify({title:document.title,text:document.body?.textContent})", returnByValue: true,
      });
      if (result.exceptionDetails) throw new Error("CDP evaluation exception");
      observed = JSON.parse(result.result.value);
      return observed.title === title && observed.text === text;
    });
    assert.deepEqual(observed, { title, text });
    return observed;
  } finally { socket.close(); }
}

async function cacheExecutable(cache) {
  for (const entry of (await fs.readdir(cache)).filter((entry) => /^chromium-\d+$/.test(entry))) {
    for (const layout of ["chrome-linux64", "chrome-linux"]) {
      const exe = path.join(cache, entry, layout, "chrome");
      try { await fs.access(exe); return await fs.realpath(exe); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }
  throw new Error(`the real Playwright installer did not produce Chromium in ${cache}`);
}

async function exercise(name, cache, locator, expectedMissing) {
  const [gatewayPort, cdpPort] = await freePorts();
  const state = path.join(taskRoot, `state-${name}`), configPath = path.join(state, "openclaw.json");
  await fs.mkdir(state);
  const token = "synthetic-cache-contract-proof-only";
  await fs.writeFile(configPath, JSON.stringify({
    gateway: { mode: "local", bind: "loopback", port: gatewayPort, auth: { mode: "token", token }, controlUi: { enabled: false } },
    plugins: { allow: ["browser"] },
    browser: { enabled: true, headless: true, noSandbox: true, defaultProfile: "openclaw", profiles: { openclaw: { cdpPort } } },
    agents: { defaults: { workspace: path.join(state, "workspace") } },
  }));
  const env = { ...baseEnv, ...locator, OPENCLAW_STATE_DIR: state, OPENCLAW_CONFIG_PATH: configPath };
  const cli = (args) => command("pnpm", ["--dir", candidate, "openclaw", ...args], env);
  const browser = (action) => cli(["browser", "--json", "--url", `ws://127.0.0.1:${gatewayPort}`, "--token", token, "--browser-profile", "openclaw", action]);
  const executable = await cacheExecutable(cache);
  const gateway = spawn("pnpm", ["--dir", candidate, "openclaw", "gateway", "run", "--bind", "loopback", "--port", String(gatewayPort)],
    { cwd: installCwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let logs = "";
  gateway.stdout.on("data", (chunk) => { logs += chunk; });
  gateway.stderr.on("data", (chunk) => { logs += chunk; });
  const closed = once(gateway, "close");
  let browserPid, gatewayPid, completed = false;
  const row = { name, expectedMissing, executable, gatewayPort, cdpPort };
  try {
    await until("Gateway readiness", async () => {
      assert.ok(gateway.exitCode === null && gateway.signalCode === null, `Gateway exited before readiness: ${logs}`);
      try { return (await jsonFetch(`http://127.0.0.1:${gatewayPort}/healthz`)).ok === true; }
      catch (error) { if (error instanceof TypeError || error.name === "TimeoutError") return false; throw error; }
    }, 300_000);
    row.gateway = await gatewayIdentity(gatewayPort, configPath);
    gatewayPid = row.gateway.pid;
    const before = parseCliJson(await browser("status"), `${name} pre-start status`);
    assert.equal(before.running, false);
    const started = await browser("start");
    if (expectedMissing) {
      assert.equal(before.detectedExecutablePath, null, "RED must not find an unrelated browser");
      assert.equal(started.code, 1, "RED must fail at executable discovery");
      assert.match(started.stderr + started.stdout, /No supported browser found \(Chrome\/Brave\/Edge\/Chromium on macOS, Linux, or Windows\)\./);
      const stopped = parseCliJson(await browser("status"), `${name} failed-start status`);
      assert.equal(stopped.running, false); assert.equal(stopped.cdpReady, false); assert.equal(stopped.pid, null);
      row.observed = "exact unsupported-browser discovery error";
    } else {
      const status = parseCliJson(started, `${name} start`);
      assert.equal(status.running, true); assert.equal(status.cdpReady, true);
      assert.equal(status.detectedExecutablePath, executable); assert.equal(status.cdpPort, cdpPort);
      assert.ok(Number.isSafeInteger(status.pid) && status.pid > 0);
      browserPid = status.pid;
      assert.equal(await fs.realpath(`/proc/${browserPid}/exe`), executable);
      row.browserPid = browserPid;
      row.readback = await cdpReadback(cdpPort, name);
      const stopped = parseCliJson(await browser("stop"), `${name} stop`);
      assert.equal(stopped.running, false); assert.equal(stopped.cdpReady, false);
      const after = parseCliJson(await browser("status"), `${name} post-stop status`);
      assert.equal(after.running, false); assert.equal(after.pid, null);
      await until("Chromium process exit", async () => !(await pidAlive(browserPid)));
      row.observed = "CLI launch, executable/PID, CDP readback and CLI stop verified";
    }
    await assertPortClosed(cdpPort);
    completed = true;
  } finally {
    let cleanupError;
    try {
      if (browserPid && await pidAlive(browserPid)) requireSuccess(await browser("stop"), `${name} failure cleanup`);
    } catch (error) {
      cleanupError = error;
    } finally {
      if (gateway.exitCode === null && gateway.signalCode === null) process.kill(-gateway.pid, "SIGTERM");
    }
    const [code, signal] = await withDeadline(closed, `Gateway shutdown: ${logs}`, 60_000);
    assert.ok(code === 0 || code === 143 || signal === "SIGTERM", `Gateway did not exit naturally after SIGTERM: ${code}/${signal}\n${logs}`);
    if (gatewayPid) await until("Gateway child exit", async () => !(await pidAlive(gatewayPid)));
    if (browserPid) await until("Chromium cleanup", async () => !(await pidAlive(browserPid)));
    await assertPortClosed(gatewayPort);
    row.gatewayStopped = true;
    if (cleanupError) throw cleanupError;
    if (completed) { report.cases.push(row); console.log(`BROWSER_CACHE_${mode.toUpperCase()} ${name}: ${row.observed}`); }
  }
}

try {
  let cache = path.join(taskRoot, "absolute-cache");
  requireSuccess(await command(process.execPath, [installer, "install", "chromium"], { ...baseEnv, PLAYWRIGHT_BROWSERS_PATH: cache }, installCwd, 300_000), "real Playwright install");
  await exercise("absolute-control", cache, { PLAYWRIGHT_BROWSERS_PATH: cache }, false);
  const relative = path.join(installCwd, "relative-browsers");
  await fs.rename(cache, relative); cache = relative;
  await exercise("relative-install-root", cache, { PLAYWRIGHT_BROWSERS_PATH: "relative-browsers" }, mode === "red");
  const alias = path.join(taskRoot, "npm-cache");
  await fs.rename(cache, alias); cache = alias;
  await exercise("npm-config-cache", cache, { npm_config_playwright_browsers_path: cache }, mode === "red");
  requireSuccess(await command(process.execPath, [installer, "install", "chromium"], { ...baseEnv, PLAYWRIGHT_BROWSERS_PATH: "0" }, installCwd, 300_000), "real hermetic Playwright install");
  await exercise("hermetic-zero", path.join(playwrightRoot, ".local-browsers"), { PLAYWRIGHT_BROWSERS_PATH: "0" }, mode === "red");
  assert.equal(report.cases.length, 4); report.passed = true;
} finally {
  await fs.mkdir(path.dirname(path.resolve(reportPath)), { recursive: true });
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
}

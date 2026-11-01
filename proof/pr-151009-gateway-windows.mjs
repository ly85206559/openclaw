import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const [source, npmCli, phase] = process.argv.slice(2);
const allowedPhases = new Set(["baseline", "candidate", "path-fallback"]);
let stage = "input";

class ProofFailure extends Error {}

function check(condition, message) {
  if (!condition) {
    throw new ProofFailure(message);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function bounded(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (result) => {
        clearTimeout(timeout);
        resolve(result);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  check(address && typeof address === "object", "Unable to reserve a loopback port.");
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function waitForPort(port, gateway) {
  const until = Date.now() + 150_000;
  while (Date.now() < until) {
    check(
      gateway.exitCode === null && gateway.signalCode === null,
      "Gateway exited before readiness.",
    );
    const connected = await new Promise((resolve) => {
      const probe = net.connect({ host: "127.0.0.1", port });
      const timeout = setTimeout(() => {
        probe.destroy();
        resolve(false);
      }, 1_000);
      const finish = (value) => {
        clearTimeout(timeout);
        probe.destroy();
        resolve(value);
      };
      probe.once("connect", () => finish(true));
      probe.once("error", () => finish(false));
    });
    if (connected) {
      return;
    }
    await delay(250);
  }
  throw new Error("Gateway did not become ready.");
}

function createWire(port) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  const events = [];
  const responses = new Map();
  let wireError;
  let sequence = 0;
  socket.addEventListener("message", (event) => {
    try {
      check(typeof event.data === "string" && event.data.length < 1_000_000, "Invalid frame.");
      const frame = JSON.parse(event.data);
      if (frame.type === "res" && typeof frame.id === "string") {
        responses.set(frame.id, frame);
      } else if (
        frame.type === "event" &&
        ["connect.challenge", "terminal.data", "terminal.exit"].includes(frame.event)
      ) {
        check(events.length < 2_048, "Event buffer limit exceeded.");
        events.push(frame);
      }
    } catch {
      wireError = new Error("Invalid Gateway frame.");
    }
  });
  socket.addEventListener("error", () => {
    wireError ??= new Error("Gateway WebSocket failed.");
  });
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("Gateway WebSocket failed.")), {
      once: true,
    });
  });
  const closed = new Promise((resolve) =>
    socket.addEventListener("close", resolve, { once: true }),
  );
  async function wait(predicate, message, ms = 45_000) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (wireError) {
        throw wireError;
      }
      const result = predicate();
      if (result) {
        return result;
      }
      await delay(50);
    }
    throw new Error(message);
  }
  async function request(method, params) {
    const id = `proof-${++sequence}`;
    socket.send(JSON.stringify({ type: "req", id, method, params }));
    return await wait(() => responses.get(id), "Gateway request timed out.");
  }
  return { socket, events, opened, closed, wait, request };
}

async function main() {
  check(process.platform === "win32", "Windows runner required.");
  check(path.isAbsolute(source) && path.isAbsolute(npmCli), "Absolute paths required.");
  check(allowedPhases.has(phase), "Unexpected phase.");
  check(/^v24\.22\.1$/.test(process.version), "Unexpected Node version.");
  const root = await mkdtemp(path.join(os.tmpdir(), "openclaw-gateway-proof-"));
  const runtimeDir = path.join(root, "runtime");
  const fallbackDir = path.join(root, "fallback");
  const fixtureDir = path.join(root, "fixture");
  const prefix = path.join(root, "npm-prefix");
  const state = path.join(root, "state");
  const nodeState = path.join(root, "node-state");
  const workspace = path.join(root, "workspace");
  const systemRoot = process.env.SystemRoot;
  check(systemRoot && path.isAbsolute(systemRoot), "SystemRoot unavailable.");
  const systemDir = path.join(systemRoot, "System32");
  const node24 = path.join(runtimeDir, "node24.exe");
  let gateway;
  let gatewayDone;
  let nodeHost;
  let nodeHostDone;
  let wire;
  let proofPassed = false;
  try {
    stage = "fixture";
    for (const dir of [runtimeDir, fallbackDir, fixtureDir, prefix, state, nodeState, workspace]) {
      await mkdir(dir, { recursive: true });
    }
    await copyFile(process.execPath, node24);
    if (phase === "path-fallback") {
      await copyFile(process.execPath, path.join(fallbackDir, "node.exe"));
    }
    await writeFile(
      path.join(fixtureDir, "package.json"),
      JSON.stringify({
        name: "openclaw-gateway-pty-proof",
        version: "1.0.0",
        bin: { codex: "cli.cjs" },
      }),
    );
    await writeFile(
      path.join(fixtureDir, "cli.cjs"),
      [
        "#!/usr/bin/env node",
        'const fs = require("node:fs");',
        'const path = require("node:path");',
        'const hasNode = (process.env.PATH || "").split(path.delimiter).filter(Boolean).some((dir) => fs.existsSync(path.join(dir, "node.exe")));',
        'console.log("GW_PTY=" + JSON.stringify([path.basename(process.execPath), process.argv.slice(2), process.env.OPENCLAW_TERMINAL === "1", hasNode]));',
      ].join("\n"),
    );
    const npmUserConfig = path.join(root, "npm-user.npmrc");
    const npmGlobalConfig = path.join(root, "npm-global.npmrc");
    await writeFile(npmUserConfig, "");
    await writeFile(npmGlobalConfig, "");
    const npmEnv = {
      SystemRoot: systemRoot,
      WINDIR: systemRoot,
      TEMP: root,
      TMP: root,
      PATH: process.env.PATH ?? "",
      npm_config_userconfig: npmUserConfig,
      npm_config_globalconfig: npmGlobalConfig,
      npm_config_cache: path.join(root, "npm-cache"),
    };
    const installed = spawnSync(
      process.execPath,
      [
        npmCli,
        "install",
        "--global",
        "--prefix",
        prefix,
        "--offline",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        fixtureDir,
      ],
      { env: npmEnv, cwd: root, stdio: "ignore", timeout: 60_000, windowsHide: true },
    );
    check(!installed.error && installed.status === 0, "Local npm fixture installation failed.");
    check(existsSync(path.join(prefix, "codex.cmd")), "npm did not create the Windows shim.");

    stage = "gateway-start";
    const pathEntries = [prefix, ...(phase === "path-fallback" ? [fallbackDir] : []), systemDir];
    const hasNode = pathEntries.some((entry) => existsSync(path.join(entry, "node.exe")));
    check(hasNode === (phase === "path-fallback"), "Unexpected node.exe PATH state.");
    check(!existsSync(path.join(source, "node.exe")), "Source cwd contains node.exe.");
    const token = randomBytes(32).toString("hex");
    const port = await freePort();
    const configFile = path.join(state, "openclaw.json");
    await writeFile(
      configFile,
      JSON.stringify({
        gateway: {
          mode: "local",
          bind: "loopback",
          auth: { mode: "token" },
          controlUi: { enabled: false },
          cliAgents: { enabled: true },
          terminal: { enabled: true },
        },
        agents: { defaults: { workspace } },
        plugins: {
          entries: { codex: { enabled: true, config: { sessionCatalog: { enabled: true } } } },
        },
      }),
    );
    const gatewayEnv = {
      SystemRoot: systemRoot,
      WINDIR: systemRoot,
      TEMP: root,
      TMP: root,
      COMSPEC: path.join(systemDir, "cmd.exe"),
      PATHEXT: ".EXE;.CMD;.BAT;.COM",
      PATH: pathEntries.join(path.delimiter),
      OPENCLAW_STATE_DIR: state,
      OPENCLAW_CONFIG_PATH: configFile,
      OPENCLAW_GATEWAY_TOKEN: token,
      OPENCLAW_DISABLE_BONJOUR: "1",
      OPENCLAW_EXEC_SHELL_SNAPSHOT: "0",
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_NO_RESPAWN: "1",
    };
    gateway = spawn(
      node24,
      [
        path.join(source, "openclaw.mjs"),
        "gateway",
        "--allow-unconfigured",
        "--bind",
        "loopback",
        "--port",
        String(port),
        "--auth",
        "token",
      ],
      {
        cwd: source,
        env: gatewayEnv,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    gateway.stdout.resume();
    gateway.stderr.resume();
    gatewayDone = new Promise((resolve) => {
      gateway.once("error", () => resolve({ spawnError: true }));
      gateway.once("close", (code, signal) => resolve({ code, signal }));
    });
    await waitForPort(port, gateway);

    stage = "gateway-connect";
    wire = createWire(port);
    await bounded(wire.opened, 15_000, "Gateway WebSocket open timed out.");
    await wire.wait(
      () => wire.events.find((event) => event.event === "connect.challenge"),
      "Gateway challenge timed out.",
    );
    const hello = await wire.request("connect", {
      minProtocol: 4,
      maxProtocol: 4,
      client: { id: "gateway-client", version: "1.0.0", platform: "win32", mode: "backend" },
      role: "operator",
      scopes: ["operator.admin", "operator.pairing"],
      caps: [],
      auth: { token },
    });
    check(
      hello.ok === true && hello.payload?.auth?.scopes?.includes("operator.admin"),
      "Gateway admin handshake failed.",
    );

    stage = "node-host-start";
    const nodeConfigFile = path.join(nodeState, "openclaw.json");
    await writeFile(
      nodeConfigFile,
      JSON.stringify({
        plugins: {
          entries: { codex: { enabled: true, config: { sessionCatalog: { enabled: true } } } },
        },
      }),
    );
    const displayName = `proof-${randomBytes(12).toString("hex")}`;
    nodeHost = spawn(
      node24,
      [
        path.join(source, "openclaw.mjs"),
        "node",
        "run",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--auth-from-env",
        "--display-name",
        displayName,
        "--commands",
        "codex.terminal.start.v1",
      ],
      {
        cwd: source,
        env: { ...gatewayEnv, OPENCLAW_STATE_DIR: nodeState, OPENCLAW_CONFIG_PATH: nodeConfigFile },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    nodeHost.stdout.resume();
    nodeHost.stderr.resume();
    nodeHostDone = new Promise((resolve) => {
      nodeHost.once("error", () => resolve({ spawnError: true }));
      nodeHost.once("close", (code, signal) => resolve({ code, signal }));
    });

    stage = "node-host-pairing";
    let deviceId;
    let nodeId;
    const pairingDeadline = Date.now() + 120_000;
    while (Date.now() < pairingDeadline) {
      check(
        nodeHost.exitCode === null && nodeHost.signalCode === null,
        "Node host exited during pairing.",
      );
      const devices = await wire.request("device.pair.list", {});
      check(
        devices.ok === true && Array.isArray(devices.payload?.pending),
        "Cannot inspect device pairing.",
      );
      const pendingDevices = devices.payload.pending;
      check(pendingDevices.length <= 1, "Unexpected concurrent device pairing request.");
      if (pendingDevices.length === 1) {
        const pending = pendingDevices[0];
        check(
          pending.displayName === displayName && typeof pending.deviceId === "string",
          "Unexpected device pairing identity.",
        );
        deviceId = pending.deviceId;
        nodeId = deviceId;
        const approved = await wire.request("device.pair.approve", {
          requestId: pending.requestId,
        });
        check(approved.ok === true, "Device pairing approval failed.");
      }
      const nodes = await wire.request("node.list", {});
      check(nodes.ok === true && Array.isArray(nodes.payload?.nodes), "Cannot inspect node list.");
      const matching = nodes.payload.nodes.filter((node) => node.displayName === displayName);
      check(matching.length <= 1, "Unexpected duplicate node identity.");
      if (matching.length === 1) {
        check(!deviceId || matching[0].nodeId === deviceId, "Node and device identities differ.");
        nodeId = matching[0].nodeId;
      }
      const requests = await wire.request("node.pair.list", {});
      check(
        requests.ok === true && Array.isArray(requests.payload?.pending),
        "Cannot inspect node pairing.",
      );
      check(requests.payload.pending.length <= 1, "Unexpected concurrent node pairing request.");
      if (requests.payload.pending.length === 1) {
        const pending = requests.payload.pending[0];
        check(
          typeof nodeId === "string" && pending.nodeId === nodeId,
          "Unexpected node pairing identity.",
        );
        const approved = await wire.request("node.pair.approve", { requestId: pending.requestId });
        check(approved.ok === true, "Node pairing approval failed.");
      }
      if (
        matching.length === 1 &&
        matching[0].connected === true &&
        matching[0].approvalState === "approved" &&
        matching[0].commands?.includes("codex.terminal.start.v1")
      ) {
        break;
      }
      await delay(500);
    }
    check(typeof nodeId === "string", "Node pairing timed out.");
    const ready = await wire.request("node.list", {});
    const activeNode = ready.payload?.nodes?.find((node) => node.nodeId === nodeId);
    check(
      ready.ok === true &&
        activeNode?.displayName === displayName &&
        activeNode.connected === true &&
        activeNode.approvalState === "approved" &&
        activeNode.commands?.includes("codex.terminal.start.v1"),
      "Node host has no approved terminal command.",
    );
    console.log("NODE_HOST=PAIRED_APPROVED");

    stage = "terminal-open";
    const response = await wire.request("sessions.catalog.startTerminal", {
      catalogId: "codex",
      agentId: "main",
      hostId: `node:${nodeId}`,
      cwd: workspace,
      initialMessage: "literal",
    });
    if (phase === "baseline" && response.ok === false) {
      check(
        response.ok === false &&
          typeof response.error?.message === "string" &&
          response.error.message.includes(
            "A Node executable is required to launch this Windows npm wrapper",
          ),
        "Baseline did not reject at the intended boundary.",
      );
      console.log("GATEWAY_BASELINE=EXPECTED_NODE_ERROR");
    } else {
      check(
        response.ok === true && typeof response.payload?.sessionId === "string",
        "Terminal RPC did not open.",
      );
      const sessionId = response.payload.sessionId;
      const exit = await wire.wait(
        () =>
          wire.events.find(
            (event) => event.event === "terminal.exit" && event.payload?.sessionId === sessionId,
          ),
        "Terminal exit event timed out.",
      );
      if (phase === "baseline") {
        check(
          exit.payload?.reason === "error" &&
            typeof exit.payload?.error === "string" &&
            exit.payload.error.includes(
              "A Node executable is required to launch this Windows npm wrapper",
            ),
          "Baseline did not reject at the intended node terminal boundary.",
        );
        console.log("GATEWAY_BASELINE=EXPECTED_NODE_ERROR");
      } else {
        check(
          exit.payload?.exitCode === 0 && exit.payload?.reason === "process_exit",
          "Terminal did not exit normally.",
        );
        const output = wire.events
          .filter(
            (event) => event.event === "terminal.data" && event.payload?.sessionId === sessionId,
          )
          .map((event) => event.payload.data)
          .join("");
        const match = output.match(/GW_PTY=(\[[^\r\n]+\])/);
        check(match, "Terminal receipt missing.");
        const receipt = JSON.parse(match[1]);
        check(
          Array.isArray(receipt) &&
            receipt[0].toLowerCase() === (phase === "candidate" ? "node24.exe" : "node.exe"),
          "Unexpected terminal executable.",
        );
        check(
          JSON.stringify(receipt[1]) === JSON.stringify(["--", "literal"]),
          "Terminal argv changed.",
        );
        check(
          receipt[2] === true && receipt[3] === (phase === "path-fallback"),
          "Terminal environment mismatch.",
        );
        console.log(`GATEWAY_TERMINAL_RECEIPT=${JSON.stringify(receipt)}`);
        console.log("GATEWAY_TERMINAL_EXIT=0");
      }
    }
    check(
      gateway.exitCode === null && gateway.signalCode === null,
      "Gateway exited before proof completed.",
    );
    check(
      nodeHost.exitCode === null && nodeHost.signalCode === null,
      "Node host exited before proof completed.",
    );
    proofPassed = true;
  } finally {
    stage = proofPassed ? "owned-gateway-cleanup" : stage;
    const failedCleanup = [];
    async function cleanup(name, action) {
      try {
        await action();
      } catch {
        failedCleanup.push(name);
      }
    }
    await cleanup("socket-close", async () => {
      if (wire && wire.socket.readyState < WebSocket.CLOSING) wire.socket.close();
    });
    await cleanup("node-host", async () => {
      if (nodeHost && nodeHost.exitCode === null && nodeHost.signalCode === null) {
        check(nodeHost.kill(), "Unable to terminate the runner-owned node host.");
        await bounded(nodeHostDone, 15_000, "Runner-owned node host did not stop.");
        console.log("NODE_HOST_CLEANUP=controller_terminated_owned_process");
      }
    });
    await cleanup("gateway", async () => {
      if (gateway && gateway.exitCode === null && gateway.signalCode === null) {
        check(gateway.kill(), "Unable to terminate the runner-owned Gateway.");
        await bounded(gatewayDone, 15_000, "Runner-owned Gateway did not stop.");
        console.log("GATEWAY_CLEANUP=controller_terminated_owned_process");
      }
    });
    await cleanup("socket-wait", async () => {
      if (wire) await bounded(wire.closed, 10_000, "Gateway WebSocket did not close.");
    });
    await cleanup("temp-directory", async () => await rm(root, { recursive: true, force: true }));
    if (failedCleanup.length) {
      console.error(`OWNED_CLEANUP_FAILED=${failedCleanup.join(",")}`);
      throw new ProofFailure("Runner-owned cleanup failed.");
    }
  }
  check(proofPassed, "Gateway proof did not complete.");
  console.log(`GATEWAY_PROOF_COMPLETE=${phase}`);
}

try {
  await main();
} catch (error) {
  console.error(`GATEWAY_PROOF_FAILED_STAGE=${stage}`);
  if (error instanceof ProofFailure) {
    console.error(`GATEWAY_PROOF_FAILURE=${error.message}`);
  }
  const code =
    error &&
    typeof error === "object" &&
    typeof error.code === "string" &&
    /^[A-Z0-9_]{1,32}$/.test(error.code)
      ? error.code
      : "UNKNOWN";
  console.error(`GATEWAY_PROOF_FAILURE_CODE=${code}`);
  process.exitCode = 1;
}

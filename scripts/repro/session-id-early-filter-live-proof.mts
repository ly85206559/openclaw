import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { applySessionStoreProjection } from "../../src/config/sessions/session-accessor.js";
import { resolveSessionStorePathCore } from "../../src/config/sessions.js";
import { callGatewayCli } from "../../src/gateway/call.js";

const PRODUCT_HEAD = "fc31b4d6f34af79bc1e58e6a55a1ae47f7008817";
const SESSION_COUNT = 5_001;
const TARGET_ID = "proof-target-session-id";
const TARGET_KEY = "agent:main:proof-target";

const repoRoot = process.cwd();
const artifactDir = path.join(repoRoot, ".artifacts", "session-id-early-filter-live");
const tempRoot = await mkdtemp(
  path.join(process.env.RUNNER_TEMP || os.tmpdir(), "openclaw-session-id-proof-"),
);
const proofHome = path.join(tempRoot, "home");
const stateDir = path.join(tempRoot, "state");
const configPath = path.join(stateDir, "openclaw.json");
const gatewayLogPath = path.join(artifactDir, "gateway.log");
const resultPath = path.join(artifactDir, "result.json");
const gatewayPort = 19_000 + (process.pid % 500);
const gatewayToken = "session-id-proof-token";

await mkdir(proofHome, { recursive: true });
await mkdir(stateDir, { recursive: true });
await mkdir(artifactDir, { recursive: true });

const proofEnv = {
  ...process.env,
  HOME: proofHome,
  OPENCLAW_CONFIG_PATH: configPath,
  OPENCLAW_DISABLE_BONJOUR: "1",
  OPENCLAW_GATEWAY_PORT: String(gatewayPort),
  OPENCLAW_GATEWAY_TOKEN: gatewayToken,
  OPENCLAW_HOME: proofHome,
  OPENCLAW_SKIP_CHANNELS: "1",
  OPENCLAW_SKIP_CRON: "1",
  OPENCLAW_STATE_DIR: stateDir,
};
Object.assign(process.env, proofEnv);

await writeFile(
  configPath,
  `${JSON.stringify(
    {
      agents: { defaults: { heartbeat: { every: "0m" } } },
      browser: { enabled: false },
      gateway: {
        auth: { mode: "token" },
        bind: "loopback",
        controlUi: { enabled: false },
        mode: "local",
        port: gatewayPort,
        tailscale: { mode: "off" },
      },
      plugins: { enabled: false },
      update: { checkOnStart: false },
    },
    null,
    2,
  )}\n`,
  "utf8",
);

const storePath = resolveSessionStorePathCore(undefined, { agentId: "main" });
await applySessionStoreProjection({
  agentId: "main",
  skipMaintenance: true,
  storePath,
  update: (store) => {
    for (let index = 0; index < SESSION_COUNT - 1; index += 1) {
      store[`agent:main:noise-${index}`] = {
        sessionId: `noise-session-${index}`,
        updatedAt: index + 1,
      };
    }
    store[TARGET_KEY] = {
      sessionId: TARGET_ID,
      updatedAt: SESSION_COUNT,
    };
    return { persist: true, result: undefined };
  },
});

const gatewayLogFd = openSync(gatewayLogPath, "w");
const gateway = spawn(
  process.execPath,
  [
    path.join(repoRoot, "dist", "entry.js"),
    "gateway",
    "run",
    "--bind",
    "loopback",
    "--port",
    String(gatewayPort),
    "--auth",
    "token",
    "--allow-unconfigured",
    "--force",
  ],
  {
    cwd: repoRoot,
    env: proofEnv,
    stdio: ["ignore", gatewayLogFd, gatewayLogFd],
  },
);

async function stopGateway(): Promise<void> {
  if (gateway.exitCode !== null) {
    return;
  }
  gateway.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => gateway.once("exit", () => resolve())),
    new Promise<void>((resolve) =>
      setTimeout(() => {
        gateway.kill("SIGKILL");
        resolve();
      }, 5_000),
    ),
  ]);
}

async function waitForGateway(): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (gateway.exitCode !== null) {
      throw new Error(`Gateway exited before readiness with code ${gateway.exitCode}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${gatewayPort}/healthz`);
      if (response.ok) {
        return;
      }
    } catch {
      // Startup connection failures are expected until the listener is ready.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for the proof Gateway");
}

try {
  await waitForGateway();
  const samples: number[] = [];
  let resolved: unknown;
  for (let index = 0; index < 12; index += 1) {
    const startedAt = performance.now();
    resolved = await callGatewayCli({
      method: "sessions.resolve",
      params: { agentId: "main", sessionId: TARGET_ID },
      skipImplicitAuth: true,
      timeoutMs: 20_000,
      token: gatewayToken,
      url: `ws://127.0.0.1:${gatewayPort}`,
      useStoredDeviceAuth: false,
    });
    const elapsedMs = performance.now() - startedAt;
    if (index >= 2) {
      samples.push(elapsedMs);
    }
    if (
      !resolved ||
      typeof resolved !== "object" ||
      !("ok" in resolved) ||
      resolved.ok !== true ||
      !("key" in resolved) ||
      resolved.key !== TARGET_KEY
    ) {
      throw new Error(`Unexpected sessions.resolve result: ${JSON.stringify(resolved)}`);
    }
  }

  const sorted = [...samples].sort((left, right) => left - right);
  const percentile = (ratio: number) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
  const result = {
    productHead: PRODUCT_HEAD,
    request: { agentId: "main", sessionId: TARGET_ID },
    response: resolved,
    samples: samples.length,
    sessionCount: SESSION_COUNT,
    timingMs: {
      median: Number(percentile(0.5).toFixed(3)),
      p95: Number(percentile(0.95).toFixed(3)),
    },
  };
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(result));
} catch (error) {
  const log = await readFile(gatewayLogPath, "utf8").catch(() => "");
  if (log) {
    console.error(log);
  }
  throw error;
} finally {
  await stopGateway();
  closeSync(gatewayLogFd);
  await rm(tempRoot, { recursive: true, force: true });
}

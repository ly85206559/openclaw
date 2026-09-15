#!/usr/bin/env node
// Real-behavior proof for managed Gateway launcher drain (#146956 / PR #147054).
// Current product path: packaged compile-cache respawn + 328s Gateway grace.
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runRespawnedChild } from "../../node-runtime-recovery.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLEANUP_MS = 3025;

async function waitForFile(filePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    try {
      return await fs.readFile(filePath, "utf8");
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`timed out waiting for ${filePath}`);
}

function proofUnitRegression() {
  const result = spawnSync(
    process.execPath,
    [
      path.join(repoRoot, "scripts", "run-vitest.mjs"),
      "run",
      "src/infra/node-runtime-recovery.test.ts",
      "-t",
      "runtime recovery child shutdown",
      "--reporter=verbose",
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: "600000" },
    },
  );
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  if (result.status !== 0) {
    throw new Error(`unit recovery shutdown proof failed with exit ${result.status ?? "unknown"}`);
  }
  console.log(
    "unit recovery shutdown proof: Gateway grace, non-Gateway short grace, and stuck-child force-kill passed",
  );
}

async function proofRecoveryChildGrace() {
  if (process.platform === "win32") {
    console.log("recovery child grace proof: skipped on win32 (SIGTERM child timing differs)");
    return;
  }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gateway-recovery-proof-"));
  const readyPath = path.join(dir, "ready.json");
  const stoppedPath = path.join(dir, "stopped.txt");
  const childScript = path.join(dir, "slow-sigterm-child.mjs");
  await fs.writeFile(
    childScript,
    [
      'import { writeFileSync } from "node:fs";',
      `const readyPath = ${JSON.stringify(readyPath)};`,
      `const stoppedPath = ${JSON.stringify(stoppedPath)};`,
      `const cleanupMs = ${CLEANUP_MS};`,
      "writeFileSync(readyPath, JSON.stringify({ pid: process.pid }));",
      'process.on("SIGTERM", () => {',
      "  setTimeout(() => {",
      '    writeFileSync(stoppedPath, "stopped");',
      "    process.exit(0);",
      "  }, cleanupMs);",
      "});",
      "setInterval(() => {}, 1000);",
    ].join("\n"),
    "utf8",
  );

  const previousArgv = process.argv;
  const previousExit = process.exit;
  process.argv = [process.execPath, path.join(repoRoot, "openclaw.mjs"), "gateway", "run"];
  const existingListeners = new Set(process.listeners("SIGTERM"));
  let exitCode;
  process.exit = (code) => {
    exitCode = code;
  };
  const startedAt = Date.now();
  try {
    runRespawnedChild(process.execPath, [childScript], process.env);
    await waitForFile(readyPath, 5000);
    const listener = process
      .listeners("SIGTERM")
      .find((candidate) => !existingListeners.has(candidate));
    if (!listener) {
      throw new Error("expected runRespawnedChild to register a SIGTERM listener");
    }
    listener("SIGTERM");
    await waitForFile(stoppedPath, 8000);
    const elapsedMs = Date.now() - startedAt;
    console.log(
      `recovery child grace proof: child finished cleanup in ${elapsedMs} ms (cleanup budget ${CLEANUP_MS} ms; old launcher cutoff ~2000 ms)`,
    );
    if (elapsedMs < CLEANUP_MS - 250) {
      throw new Error(`cleanup finished too quickly (${elapsedMs} ms)`);
    }
    if (elapsedMs < 2000) {
      throw new Error(`child was cut off at old ~2000 ms launcher deadline (${elapsedMs} ms)`);
    }
    const exitDeadline = Date.now() + 2000;
    while (exitCode === undefined && Date.now() <= exitDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (exitCode !== 0) {
      throw new Error(`expected wrapper process.exit(0), got ${String(exitCode)}`);
    }
  } finally {
    process.argv = previousArgv;
    process.exit = previousExit;
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

function proofPackagedLauncherE2e() {
  if (process.platform === "win32") {
    console.log("packaged launcher proof: skipped on win32 (e2e fixture is unix-only)");
    return;
  }
  const result = spawnSync(
    process.execPath,
    [
      path.join(repoRoot, "scripts", "run-vitest.mjs"),
      "run",
      "test/openclaw-launcher.e2e.test.ts",
      "-t",
      "preserves foreground Gateway shutdown grace with packaged compile cache",
      "--reporter=verbose",
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: "600000" },
    },
  );
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  if (result.status !== 0) {
    throw new Error(`packaged launcher e2e proof failed with exit ${result.status ?? "unknown"}`);
  }
  console.log(
    "packaged launcher proof: real openclaw.mjs fixture completed 3025 ms cleanup under SIGTERM",
  );
}

async function main() {
  proofUnitRegression();
  await proofRecoveryChildGrace();
  proofPackagedLauncherE2e();
  console.log("All gateway launcher drain proof checks passed.");
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});

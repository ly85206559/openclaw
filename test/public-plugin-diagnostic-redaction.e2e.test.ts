// Real CLI proof that a running Gateway health response redacts and bounds
// public plugin-verification diagnostics (#135420).
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isSupportedOpenClawNodeVersion } from "../node-version.mjs";
import type { OpenClawConfig } from "../src/config/types.js";
import {
  resolveCompatRegistryVersion,
  resolveInstalledPluginIndexPolicyHash,
} from "../src/plugins/installed-plugin-index-policy.js";
import { writePersistedInstalledPluginIndex } from "../src/plugins/installed-plugin-index-store-write.js";
import {
  INSTALLED_PLUGIN_INDEX_MIGRATION_VERSION,
  INSTALLED_PLUGIN_INDEX_VERSION,
} from "../src/plugins/installed-plugin-index-types.js";
import { resolveCompatibilityHostVersion } from "../src/version.js";

const PLUGIN_ID = "fixture-public-diagnostic";
const SYNTHETIC_SECRET = "fixture-only-public-diagnostic-value";
const SYNTHETIC_BEARER = `Bearer ${SYNTHETIC_SECRET}`;

function hideSyntheticSecret(text: string): string {
  return text.split(SYNTHETIC_SECRET).join("[synthetic-secret]");
}

function proofProcessEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, OPENCLAW_LOG_LEVEL: "info" };
  // A Vitest parent sets VITEST=true, which silences Gateway console logs.
  // This proof has to observe a normal CLI process.
  for (const key of Object.keys(env)) {
    if (key === "VITEST" || key.startsWith("VITEST_")) {
      delete env[key];
    }
  }
  return env;
}

async function reserveLoopbackPort(): Promise<number> {
  const port = await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("expected a loopback port"));
        return;
      }
      const reserved = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(reserved);
      });
    });
  });
  return port;
}

function stopProcessTree(child: ChildProcess | undefined): void {
  const pid = child?.pid;
  if (!pid || child.exitCode !== null) {
    return;
  }
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

async function waitForGatewayReady(child: ChildProcess, output: { text: string }): Promise<void> {
  const deadline = Date.now() + 3 * 60 * 1000;
  while (Date.now() <= deadline) {
    // Subsystem formatting drops the repeated "gateway" word, so the line is "[gateway] ready".
    if (output.text.includes("[gateway] ready")) {
      return;
    }
    if (output.text.includes("refusing to report the gateway ready")) {
      throw new Error(`gateway refused ready:\n${hideSyntheticSecret(output.text).slice(-4000)}`);
    }
    if (child.exitCode !== null) {
      const visible = hideSyntheticSecret(output.text).slice(-4000);
      throw new Error(`gateway exited ${child.exitCode} before ready:\n${visible}`);
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 250);
    });
  }
  throw new Error(
    `timed out waiting for gateway ready:\n${hideSyntheticSecret(output.text).slice(-4000)}`,
  );
}

function findPluginDiagnostic(value: unknown): { reason?: string; detail?: string } | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findPluginDiagnostic(entry);
      if (found) {
        return found;
      }
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const diagnostic = record.diagnostic;
  if (
    record.id === PLUGIN_ID &&
    diagnostic &&
    typeof diagnostic === "object" &&
    !Array.isArray(diagnostic)
  ) {
    const fields = diagnostic as { reason?: unknown; detail?: unknown };
    return {
      ...(typeof fields.reason === "string" ? { reason: fields.reason } : {}),
      ...(typeof fields.detail === "string" ? { detail: fields.detail } : {}),
    };
  }
  for (const entry of Object.values(record)) {
    const found = findPluginDiagnostic(entry);
    if (found) {
      return found;
    }
  }
  return undefined;
}

describe("public plugin diagnostic CLI proof", () => {
  it.runIf(isSupportedOpenClawNodeVersion(process.versions.node))(
    "redacts and bounds a synthetic verification diagnostic in gateway health JSON",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-public-diagnostic-"));
      const stateDir = path.join(root, "state");
      const pluginDir = path.join(root, "plugin");
      const configPath = path.join(stateDir, "openclaw.json");
      const oversizedMain = `${SYNTHETIC_BEARER} ${"x".repeat(1_200)}.js`;
      const port = await reserveLoopbackPort();
      const gatewayToken = "fixture-gateway-token";
      await fs.mkdir(pluginDir, { recursive: true });
      await fs.writeFile(
        path.join(pluginDir, "package.json"),
        `${JSON.stringify({ name: PLUGIN_ID, main: oversizedMain }, null, 2)}\n`,
        "utf8",
      );
      await fs.writeFile(
        path.join(pluginDir, "openclaw.plugin.json"),
        `${JSON.stringify({ id: PLUGIN_ID, configSchema: { type: "object" } }, null, 2)}\n`,
        "utf8",
      );
      await fs.writeFile(path.join(pluginDir, "index.js"), "export {}\n", "utf8");
      const config = {
        gateway: {
          mode: "local",
          bind: "loopback",
          port,
          auth: { mode: "token", token: gatewayToken },
        },
        memory: { search: { enabled: false } },
        plugins: {
          load: { paths: [pluginDir] },
          entries: { [PLUGIN_ID]: { enabled: true } },
        },
      } as OpenClawConfig;
      await fs.mkdir(stateDir, { recursive: true });
      await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
      const env = proofProcessEnv({
        ...process.env,
        HOME: root,
        USERPROFILE: root,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_SUPPRESS_NOTES: "1",
        OPENCLAW_GATEWAY_TOKEN: gatewayToken,
      });
      await writePersistedInstalledPluginIndex(
        {
          version: INSTALLED_PLUGIN_INDEX_VERSION,
          hostContractVersion: resolveCompatibilityHostVersion(env),
          compatRegistryVersion: resolveCompatRegistryVersion(),
          migrationVersion: INSTALLED_PLUGIN_INDEX_MIGRATION_VERSION,
          policyHash: resolveInstalledPluginIndexPolicyHash(config, env),
          generatedAtMs: Date.now(),
          installRecords: {
            [PLUGIN_ID]: {
              source: "npm",
              sourcePath: pluginDir,
              installPath: pluginDir,
              spec: PLUGIN_ID,
            },
          },
          plugins: [],
          diagnostics: [],
        },
        { env, stateDir },
      );

      const output = { text: "" };
      const gateway = spawn(
        process.execPath,
        [
          path.join(process.cwd(), "openclaw.mjs"),
          "gateway",
          "run",
          "--port",
          String(port),
          "--bind",
          "loopback",
          "--auth",
          "token",
          "--token",
          gatewayToken,
          "--force",
        ],
        {
          cwd: process.cwd(),
          env,
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        },
      );
      const append = (chunk: Buffer | string) => {
        output.text += chunk.toString();
      };
      gateway.stdout?.on("data", append);
      gateway.stderr?.on("data", append);
      try {
        await waitForGatewayReady(gateway, output);
        const health = spawnSync(
          process.execPath,
          [path.join(process.cwd(), "openclaw.mjs"), "health", "--json", "--timeout", "30000"],
          { cwd: process.cwd(), env, encoding: "utf8", timeout: 60_000 },
        );
        const healthStdout = health.stdout ?? "";
        const healthText = hideSyntheticSecret(`${healthStdout}\n${health.stderr ?? ""}`).slice(
          -4000,
        );
        if (health.status !== 0) {
          throw new Error(`openclaw health failed (${health.status ?? "unknown"}):\n${healthText}`);
        }
        const jsonStart = healthStdout.indexOf("{");
        const jsonEnd = healthStdout.lastIndexOf("}");
        if (jsonStart < 0 || jsonEnd < jsonStart) {
          throw new Error(`openclaw health did not return JSON:\n${healthText}`);
        }
        const parsed: unknown = JSON.parse(healthStdout.slice(jsonStart, jsonEnd + 1));
        const diagnostic = findPluginDiagnostic(parsed);
        if (!diagnostic) {
          throw new Error(
            `health JSON had no public diagnostic for ${PLUGIN_ID}:\n${hideSyntheticSecret(healthStdout).slice(-4000)}`,
          );
        }
        expect(diagnostic.reason).toBe("missing-main-entry");
        expect(diagnostic?.detail).toBeTypeOf("string");
        expect(diagnostic?.detail).not.toContain(SYNTHETIC_SECRET);
        expect(diagnostic?.detail?.length ?? 0).toBeLessThanOrEqual(1_000);
        expect(diagnostic?.detail?.length ?? 0).toBeGreaterThan(0);
        console.log(
          [
            "public plugin diagnostic CLI proof:",
            `detailLength=${diagnostic?.detail?.length}`,
            "containsSyntheticCredential=false",
            `reason=${diagnostic?.reason}`,
          ].join(" "),
        );
      } finally {
        stopProcessTree(gateway);
        await fs.rm(root, { recursive: true, force: true });
      }
    },
    10 * 60 * 1000,
  );
});

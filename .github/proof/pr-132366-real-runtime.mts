import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { createA2aHttpHandler } from "./extensions/a2a/src/http.ts";
import { A2aTaskStore } from "./extensions/a2a/src/task-store.ts";
import { loadWorkspaceBootstrapFiles } from "./src/agents/workspace.ts";
import {
  closeOpenClawStateDatabase,
  openOpenClawStateDatabase,
} from "./src/state/openclaw-state-db.ts";
import { createWorkerNodeEnrollmentManager } from "./src/gateway/worker-environments/node-enrollment.ts";
import { createWorkerEnvironmentStore } from "./src/gateway/worker-environments/store.ts";
import {
  createWorkerBootstrapArtifactTransferService,
} from "./src/gateway/worker-environments/worker-bootstrap-artifact-transfer-service.ts";

const label = process.argv[2] ?? "unknown";
const outputPath = process.env.PROOF_OUTPUT;

if (!outputPath) {
  throw new Error("PROOF_OUTPUT is required");
}

function hasDanglingSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true;
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function summarize(value: string) {
  const danglingSurrogate = hasDanglingSurrogate(value);
  const lastCodeUnit = value.length > 0 ? value.charCodeAt(value.length - 1) : undefined;
  return {
    length: value.length,
    wellFormed: !danglingSurrogate,
    danglingSurrogate,
    lastCodeUnit: lastCodeUnit === undefined ? null : `0x${lastCodeUnit.toString(16)}`,
  };
}

async function proveA2a() {
  const taskStore = new A2aTaskStore();
  const handler = createA2aHttpHandler({
    config: {},
    a2aConfig: {
      peers: { proof: { token: "proof-token" } },
      rateLimitPerMinute: 0,
      replyTimeoutMs: 5_000,
    },
    version: "proof",
    taskStore,
    dispatchInbound: async () => {
      throw new Error(`${"x".repeat(511)}😀tail`);
    },
  });
  const server = http.createServer((request, response) => {
    void handler(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("A2A proof server did not bind a TCP port");
    }
    const response = await fetch(`http://127.0.0.1:${address.port}/a2a/v1`, {
      method: "POST",
      headers: {
        authorization: "Bearer proof-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "proof-request",
        method: "SendMessage",
        params: {
          message: {
            messageId: "proof-message",
            role: "ROLE_USER",
            parts: [{ text: "exercise the real A2A HTTP task path" }],
          },
        },
      }),
    });
    const payload = (await response.json()) as {
      result?: {
        task?: {
          status?: { state?: string; message?: { parts?: Array<{ text?: string }> } };
        };
      };
    };
    const task = payload.result?.task;
    const text = task?.status?.message?.parts?.[0]?.text;
    if (typeof text !== "string") {
      throw new Error(`A2A proof did not return terminal status text: ${JSON.stringify(payload)}`);
    }
    return {
      transport: "real loopback HTTP POST /a2a/v1",
      httpStatus: response.status,
      taskState: task?.status?.state,
      text: summarize(text),
    };
  } finally {
    taskStore.stop();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

async function readErrorReason(directory: string): Promise<string> {
  try {
    await fs.readFile(path.join(directory, "AGENTS.md"), "utf8");
  } catch (error) {
    if (error instanceof Error) {
      return error.message;
    }
    throw error;
  }
  throw new Error("workspace proof path unexpectedly existed");
}

async function proveWorkspace() {
  const proofRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-proof-"));
  const protectedFiles: string[] = [];
  try {
    const fixedPrefix = path.join(proofRoot, "p".repeat(100));
    const createUnreadableFile = async (directory: string) => {
      await fs.mkdir(directory, { recursive: true });
      const filePath = path.join(directory, "AGENTS.md");
      await fs.writeFile(filePath, "proof", { mode: 0o600 });
      await fs.chmod(filePath, 0o000);
      protectedFiles.push(filePath);
    };

    const probeDirectory = path.join(fixedPrefix, "😀tail");
    await createUnreadableFile(probeDirectory);
    const probeReason = await readErrorReason(probeDirectory);
    const emojiIndex = probeReason.indexOf("😀");
    const repeatCount = 299 - emojiIndex;
    if (emojiIndex < 0 || repeatCount < 0 || repeatCount > 240) {
      throw new Error(
        `workspace proof could not tune boundary: ${JSON.stringify({ emojiIndex, repeatCount })}`,
      );
    }
    const directory = path.join(fixedPrefix, `${"x".repeat(repeatCount)}😀tail`);
    await createUnreadableFile(directory);
    const rawReason = await readErrorReason(directory);
    if (rawReason.charCodeAt(299) !== 0xd83d) {
      throw new Error(
        `workspace proof did not place the high surrogate at unit 299: 0x${rawReason.charCodeAt(299).toString(16)}`,
      );
    }
    const files = await loadWorkspaceBootstrapFiles(directory);
    const content = files.find((file) => file.name === "AGENTS.md")?.content;
    if (!content?.startsWith("[UNREADABLE: ") || !content.endsWith("]")) {
      throw new Error(`workspace proof did not return an unreadable diagnostic: ${content}`);
    }
    const boundedReason = content.slice("[UNREADABLE: ".length, -1);
    return {
      transport: "real fs.readFile EACCES through loadWorkspaceBootstrapFiles",
      rawReasonBoundaryCodeUnit: `0x${rawReason.charCodeAt(299).toString(16)}`,
      boundedReason: summarize(boundedReason),
    };
  } finally {
    await Promise.all(protectedFiles.map(async (filePath) => await fs.chmod(filePath, 0o600)));
    await fs.rm(proofRoot, { recursive: true, force: true });
  }
}

async function proveEnrollment() {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), `openclaw-enrollment-${label}-`));
  try {
    const artifactPath = path.join(stateDir, "node-runtime.tgz");
    await fs.writeFile(artifactPath, "x");
    const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } });
    const store = createWorkerEnvironmentStore({ database, now: () => 1_000 });
    const transfer = createWorkerBootstrapArtifactTransferService();
    const intent = store.createIntent({
      environmentId: `real-proof-${label}`,
      providerId: "proof-provider",
      profileId: `${"x".repeat(50)}😀tail`,
      profileSnapshot: { settings: {} },
      provisionOperationId: `provision:real-proof-${label}`,
    });
    const record = store.transition({
      environmentId: intent.environmentId,
      from: "requested",
      to: "provisioning",
      patch: { nodeDeviceId: `proof-device-${label}` },
    });
    const manager = createWorkerNodeEnrollmentManager({
      store,
      getConfig: () => ({
        gateway: {
          bind: "loopback",
          publicOrigin: "https://gateway.example.test",
          auth: { mode: "token", token: "proof-token" },
        },
      }),
      resolveAvailability: async () => ({ available: true }),
      prepareArtifact: async () => ({
        tarballPath: artifactPath,
        tarballSha256: "a".repeat(64),
        tarballBytes: 1,
        openclawVersion: "proof",
        buildId: "proof-build",
        enabledPluginIds: [],
      }),
      transfer,
    });
    const enrollment = await manager.begin(record);
    manager.stop();
    return {
      transport: "real SQLite state store through worker enrollment resume path",
      mode: enrollment.mode,
      displayName: summarize(enrollment.displayName),
    };
  } finally {
    closeOpenClawStateDatabase();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

const result = {
  label,
  sourceHead: process.env.PROOF_SOURCE_HEAD ?? null,
  checkoutHead: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  a2a: await proveA2a(),
  workspace: await proveWorkspace(),
  enrollment: await proveEnrollment(),
};

await fs.writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(`wrote ${label} real-runtime proof to ${outputPath}`);

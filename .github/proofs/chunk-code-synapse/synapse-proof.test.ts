// Fork-only transport proof. Copy to src/infra/outbound before running with the
// repository Vitest wrapper. skipQueue isolates custody, not the real sender.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { isMainThread } from "node:worker_threads";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { loadAndActivateRootPluginRegistry } from "../../plugins/loader.js";
import { disposePluginRegistryInstances } from "../../plugins/runtime.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db-cache.js";
import { sendMessage } from "./message.js";

const homeserver = "http://127.0.0.1:8008";
const pinnedSources = {
  red: "32e30e59d9a7fd1f5b3a9e9659427d45145779dd",
  green: "2725b3b8951af667b1367b1785efc2f721202790",
} as const;
const issuedTokens = new Set<string>();
const receivedEvents = new Set<string>();
type Account = { accessToken: string; userId: string; deviceId: string };

function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  assert.ok(typeof field === "string" && field.length > 0, `Missing Synapse ${key}`);
  return field;
}

function mask(value: string): void {
  console.log(`::add-mask::${value}`);
}

async function request(
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
  accessToken?: string,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${homeserver}/_matrix/client/v3${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  const data = record(await response.json());
  for (const key of ["access_token", "refresh_token", "user_id", "device_id"]) {
    const field = data[key];
    if (typeof field === "string") {
      mask(field);
      if (key === "access_token") {
        issuedTokens.add(field);
      }
    }
  }
  assert.ok(response.ok, `Synapse request failed with HTTP ${response.status}`);
  return data;
}

async function createAccount(role: string): Promise<Account> {
  const username = `unicode_${role}_${randomUUID().replaceAll("-", "")}`;
  const password = randomUUID();
  mask(username);
  mask(password);
  await request("POST", "/register", {
    username,
    password,
    inhibit_login: true,
    auth: { type: "m.login.dummy" },
  });
  const login = await request("POST", "/login", {
    type: "m.login.password",
    identifier: { type: "m.id.user", user: username },
    password,
  });
  return {
    accessToken: stringField(login, "access_token"),
    userId: stringField(login, "user_id"),
    deviceId: stringField(login, "device_id"),
  };
}

function jsonValid(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch (error) {
    if (error instanceof SyntaxError) {
      return false;
    }
    throw error;
  }
}

describe("real Synapse canonical Matrix Unicode proof", () => {
  let sender: Account;
  let receiver: Account;
  let roomId: string;
  let phase: keyof typeof pinnedSources;
  let source: string;

  beforeAll(async () => {
    const requestedPhase = process.env.PROOF_EXPECT;
    assert.ok(requestedPhase === "red" || requestedPhase === "green", "Missing proof phase");
    phase = requestedPhase;
    assert.equal(isMainThread, true, "Real shared-state owner requires the host main thread");
    source = pinnedSources[phase];
    assert.equal(process.env.SOURCE_SHA, source, "Proof phase/source mismatch");
    assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), source);
    mask(homeserver);
    sender = await createAccount("sender");
    receiver = await createAccount("receiver");
    const room = await request(
      "POST",
      "/createRoom",
      { visibility: "private", preset: "private_chat", invite: [receiver.userId] },
      sender.accessToken,
    );
    roomId = stringField(room, "room_id");
    mask(roomId);
    const joined = await request(
      "POST",
      `/join/${encodeURIComponent(roomId)}`,
      {},
      receiver.accessToken,
    );
    assert.equal(joined.room_id, roomId);
  }, 60_000);

  afterAll(async () => {
    const logouts = await Promise.allSettled(
      [...issuedTokens].map((token) => request("POST", "/logout", {}, token)),
    );
    clearRuntimeConfigSnapshot();
    const failures = logouts.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    try {
      await closeOpenClawStateDatabaseAsync();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "Task account or state-owner cleanup failed");
    }
    assert.equal(issuedTokens.size, 2);
    console.log(`SYNAPSE_CLEANUP_COMPLETE ${phase}`);
  }, 60_000);

  it.each(
    [
      { label: "U+2028", separator: "\u2028" },
      { label: "U+2029", separator: "\u2029" },
    ].flatMap((testCase) =>
      (["length", "newline"] as const).map((chunkMode) => ({ ...testCase, chunkMode })),
    ),
  )(
    "preserves literal $label in fenced JSON in $chunkMode mode",
    async ({ label, separator, chunkMode }) => {
      const codePayload = `{"separator":"first${separator}second"}`;
      const text = `\`\`\`json\n${codePayload}\n\`\`\``;
      const cfg: OpenClawConfig = {
        channels: {
          matrix: {
            enabled: true,
            homeserver,
            accessToken: sender.accessToken,
            userId: sender.userId,
            deviceId: sender.deviceId,
            encryption: false,
            network: { dangerouslyAllowPrivateNetwork: true },
            textChunkLimit: 4000,
            streaming: { chunkMode },
          },
        },
        plugins: { allow: ["matrix"], entries: { matrix: { enabled: true } } },
      };
      setRuntimeConfigSnapshot(cfg, cfg);
      // Shared Vitest setup resets registries after each row. Load the real
      // public channel artifact and its scoped runtime together for every send.
      const registry = await loadAndActivateRootPluginRegistry({
        config: cfg,
        onlyPluginIds: ["matrix"],
        preferBuiltPluginArtifacts: false,
        cache: false,
        throwOnLoadError: true,
      });
      try {
        expect(registry.plugins.filter((plugin) => plugin.status === "loaded")).toHaveLength(1);
        expect(registry.plugins.filter((plugin) => plugin.failedAt != null)).toHaveLength(0);
        expect(registry.plugins.find((plugin) => plugin.id === "matrix")).toMatchObject({
          status: "loaded",
          origin: "bundled",
        });
        expect(registry.channels).toHaveLength(1);
        expect(registry.channels[0]?.plugin.id).toBe("matrix");
        const delivery = await sendMessage({
          cfg,
          channel: "matrix",
          to: roomId,
          content: text,
          skipQueue: true,
        });
        expect(delivery.deliveryStatus).toBe("sent");
        const messageId = delivery.result?.messageId;
        assert.ok(typeof messageId === "string" && messageId.startsWith("$"));
        expect(receivedEvents.has(messageId)).toBe(false);
        receivedEvents.add(messageId);
        expect(delivery.result).toMatchObject({
          target: { kind: "room", id: roomId },
          receipt: {
            primaryPlatformMessageId: messageId,
            platformMessageIds: [messageId],
            parts: [{ platformMessageId: messageId, kind: "text", index: 0 }],
          },
        });
        const event = await request(
          "GET",
          `/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(messageId)}`,
          undefined,
          receiver.accessToken,
        );
        expect(event.event_id).toBe(messageId);
        expect(event.room_id).toBe(roomId);
        expect(event.sender).toBe(sender.userId);
        expect(event.type).toBe("m.room.message");
        const content = record(event.content);
        expect(content.msgtype).toBe("m.text");
        expect(content.format).toBe("org.matrix.custom.html");
        const formattedBody = stringField(content, "formatted_body");
        const body = stringField(content, "body");
        expect(body.startsWith("```json\n")).toBe(true);
        expect(body.endsWith("\n```")).toBe(true);
        const remoteCode = body.slice("```json\n".length, -"\n```".length);
        // This fixture contains only quotes requiring HTML escaping. Compare
        // the complete HTML code content, not just the opening code tag.
        expect(formattedBody).toBe(
          `<pre><code class="language-json">${remoteCode.replaceAll('"', "&quot;")}\n</code></pre>`,
        );
        console.log(
          `SYNAPSE_READBACK ${JSON.stringify({
            phase,
            source,
            label,
            mode: chunkMode,
            serverReceipt: messageId,
            bodyHash: createHash("sha256").update(body, "utf8").digest("hex"),
            htmlHash: createHash("sha256").update(formattedBody, "utf8").digest("hex"),
            codepoints: Array.from(remoteCode, (character) => character.codePointAt(0)),
            JSONvalid: jsonValid(remoteCode),
          })}`,
        );
        // RED must fail on JSON read back by another real room member, after all
        // setup, delivery, receipt and remote-event checks have already passed.
        let parsed: unknown;
        try {
          parsed = JSON.parse(remoteCode);
        } catch (error) {
          if (error instanceof SyntaxError) {
            throw new Error(`SYNAPSE_REMOTE_JSON_REGRESSION:${phase}:${label}:${chunkMode}`, {
              cause: error,
            });
          }
          throw error;
        }
        expect(parsed).toEqual({ separator: `first${separator}second` });
        expect(body).toBe(text);
      } finally {
        const cleanup = await disposePluginRegistryInstances(registry);
        expect(cleanup.failures).toEqual([]);
      }
    },
    60_000,
  );
});

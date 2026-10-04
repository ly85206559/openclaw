import "../src/test-utils/prepare-compiled-subprocesses.js";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveSessionStorePathCore } from "../src/config/sessions/paths.js";
import { upsertSessionEntryCore } from "../src/config/sessions/session-accessor.entry.js";
import { persistSessionTranscriptTurn } from "../src/config/sessions/session-accessor.transcript-turn.js";
import { readSessionTranscriptMessageByEventId } from "../src/config/sessions/session-accessor.transcript.js";
import { recordAssistantManagedMediaUrls } from "../src/config/sessions/transcript-assistant-delivery.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import {
  disconnectGatewayClient,
  startGatewayWithClient,
} from "../src/gateway/test-helpers.e2e.js";
import { splitMediaFromOutput } from "../src/media/parse.js";
import { closeOpenClawStateDatabaseAsync } from "../src/state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../src/test-utils/openclaw-test-state.js";

describe("subscribed WebSocket session.message MEDIA display", () => {
  let state: OpenClawTestState | undefined;
  let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
  let config: OpenClawConfig;
  const pending = new Map<string, (payload: Record<string, unknown>) => void>();
  const receivedFrames: Record<string, unknown>[] = [];

  beforeAll(async () => {
    state = await createOpenClawTestState({
      label: "media-websocket-proof",
      scenario: "minimal",
      env: {
        OPENCLAW_GATEWAY_TOKEN: undefined,
        OPENCLAW_GATEWAY_PASSWORD: undefined,
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      },
    });
    const emptyPlugins = state.path("empty-bundled-plugins");
    await fs.mkdir(emptyPlugins);
    state.envVars.OPENCLAW_BUNDLED_PLUGINS_DIR = emptyPlugins;
    state.applyEnv();
    const token = randomUUID();
    config = {
      agents: {
        defaults: { workspace: state.workspaceDir, skipBootstrap: true },
        entries: { main: {} },
      },
      gateway: { auth: { mode: "token", token } },
      logging: { level: "silent", consoleLevel: "silent", file: state.path("gateway.log") },
    };
    // The helper's listener spy only forwards the original transport constructor
    // with its real reserved HTTP listener; Gateway, auth, RPC, and WebSocket stay real.
    gateway = await startGatewayWithClient({
      cfg: config,
      configPath: state.configPath,
      token,
      clientName: "cli",
      mode: "cli",
      scopes: ["operator.read", "operator.sessions.read"],
      onEvent: (event) => {
        if (event.event !== "session.message") {
          return;
        }
        const payload = asOptionalRecord(event.payload);
        if (payload && typeof payload.sessionKey === "string") {
          receivedFrames.push(payload);
          pending.get(payload.sessionKey)?.(payload);
        }
      },
    });
    await gateway.server.startupSettled;
  });

  afterAll(async () => {
    if (gateway) {
      await disconnectGatewayClient(gateway.client);
      expect(gateway.client.connected).toBe(false);
      await gateway.server.close({ reason: "MEDIA WebSocket proof complete" });
    }
    await closeOpenClawStateDatabaseAsync();
    if (state) {
      await state.cleanup();
      await expect(fs.access(state.root)).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(pending.size).toBe(0);
    console.log("MEDIA_WEBSOCKET_CLEANUP_OK");
  });

  it.each([
    ["CR", "\r"],
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])("withholds managed relative directives across %s on a real subscription", async (name, separator) => {
    if (!gateway) {
      throw new Error("Gateway fixture did not start");
    }
    expect(gateway.client.connected).toBe(true);
    expect(gateway.client.getConnectionMetadata()).toMatchObject({
      clientName: "cli",
      mode: "cli",
      hasDeviceIdentity: true,
    });
    const sessionId = `media-websocket-proof-${name}`;
    const sessionKey = `agent:main:${sessionId}`;
    const scope = {
      agentId: "main",
      sessionId,
      sessionKey,
      storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
    };
    const entry = await upsertSessionEntryCore(scope, { sessionId, updatedAt: Date.now() });
    expect(entry?.sessionId).toBe(sessionId);
    const managedUrl = "./attachment-catalog-tiny/demo.jpg";
    const visibleLines = [
      "Prepared the mixed batch.",
      "MEDIA:https://cdn.example.test/legacy.jpg",
      "MEDIA:/media/legacy-audio.mp3",
    ];
    const sourceText = [...visibleLines, `MEDIA:${managedUrl}`].join(separator);
    const sourceBytes = Buffer.from(sourceText, "utf8");
    const parsed = splitMediaFromOutput(sourceText);
    expect(parsed.mediaUrls).toEqual([
      "https://cdn.example.test/legacy.jpg",
      "/media/legacy-audio.mp3",
      managedUrl,
    ]);
    const message = recordAssistantManagedMediaUrls(
      { role: "assistant", content: [{ type: "text", text: sourceText }] },
      parsed.mediaUrls,
    );
    const preparedSnapshot = structuredClone(message);
    expect(message).toMatchObject({ openclawDelivery: { mediaUrls: parsed.mediaUrls } });
    const delivery = Promise.withResolvers<Record<string, unknown>>();
    pending.set(sessionKey, delivery.resolve);
    let subscribed = false;
    try {
      const subscription = await gateway.client.request("sessions.messages.subscribe", {
        key: sessionKey,
        agentId: "main",
      });
      expect(subscription).toMatchObject({ subscribed: true, key: sessionKey, agentId: "main" });
      subscribed = true;
      // This existing owner commits the source and publishes the committed update.
      // The registered server handler rereads that row before projecting to WebSocket.
      const turn = await persistSessionTranscriptTurn(scope, {
        config,
        expectedSessionId: sessionId,
        touchSessionEntry: true,
        updateMode: "inline",
        messages: [{ message }],
      });
      expect(turn.rejectedReason).toBeUndefined();
      expect(turn.appendedCount).toBe(1);
      expect(turn.messages).toHaveLength(1);
      const receipt = turn.messages[0];
      expect(receipt.appended).toBe(true);
      const payload = await delivery.promise;
      expect(payload).toMatchObject({
        sessionKey,
        agentId: "main",
        messageId: receipt.messageId,
        messageSeq: 1,
      });
      expect(receivedFrames.filter((frame) => frame.sessionKey === sessionKey)).toHaveLength(1);
      const stored = readSessionTranscriptMessageByEventId(scope, receipt.messageId);
      expect(stored?.messageId).toBe(receipt.messageId);
      expect(stored?.message).toMatchObject(preparedSnapshot);
      const storedMessage = asOptionalRecord(stored?.message);
      const storedText = Array.isArray(storedMessage?.content)
        ? asOptionalRecord(storedMessage.content[0])?.text
        : undefined;
      expect(storedText).toBe(sourceText);
      if (typeof storedText !== "string") {
        throw new Error("Committed source text is missing");
      }
      expect(Buffer.from(storedText, "utf8")).toEqual(sourceBytes);
      expect(message).toEqual(preparedSnapshot);
      expect(Buffer.from(message.content[0].text, "utf8")).toEqual(sourceBytes);
      const unsubscribe = await gateway.client.request("sessions.messages.unsubscribe", {
        key: sessionKey,
        agentId: "main",
      });
      expect(unsubscribe).toMatchObject({ subscribed: false, key: sessionKey });
      subscribed = false;
      expect(gateway.client.connected).toBe(true);
      const receivedMessage = asOptionalRecord(payload.message);
      expect(receivedMessage?.role).toBe("assistant");
      expect(receivedMessage).not.toHaveProperty("openclawDelivery");
      console.log(
        "MEDIA_WEBSOCKET_TRACE",
        JSON.stringify({
          separator: name,
          subscribed: true,
          sourceBytesPreserved: true,
          producerMediaRefs: parsed.mediaUrls,
          received: { role: receivedMessage?.role, content: receivedMessage?.content },
          unsubscribed: true,
        }),
      );
      expect(receivedMessage?.content).toEqual([{ type: "text", text: visibleLines.join("\n") }]);
      expect(JSON.stringify(receivedMessage)).not.toContain("attachment-catalog-tiny");
      console.log(`MEDIA_WEBSOCKET_PASS ${name}`);
    } finally {
      pending.delete(sessionKey);
      if (subscribed) {
        await gateway.client.request("sessions.messages.unsubscribe", { key: sessionKey, agentId: "main" });
      }
    }
  });
});

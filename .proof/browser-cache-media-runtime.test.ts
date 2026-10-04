import { EventEmitter } from "node:events";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../src/config/runtime-snapshot.js";
import { recordAssistantManagedMediaUrls } from "../src/config/sessions/transcript-assistant-delivery.js";
import { createGatewayBroadcaster } from "../src/gateway/server-broadcast.js";
import {
  createSessionEventSubscriberRegistry,
  createSessionMessageSubscriberRegistry,
} from "../src/gateway/server-chat-state.js";
import { createTranscriptUpdateBroadcastHandler } from "../src/gateway/server-session-events.js";
import { GatewayClientRegistry } from "../src/gateway/server/client-registry.js";
import type { GatewayConnectionTransport } from "../src/gateway/server/connection-transport.js";
import type { GatewayWsClient } from "../src/gateway/server/ws-types.js";
import { splitMediaFromOutput } from "../src/media/parse.js";
import { closeOpenClawStateDatabaseAsync } from "../src/state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../src/test-utils/openclaw-test-state.js";

type SendCallback = (error?: Error) => void;

// The only substituted boundary is the physical transport after production JSON serialization.
class CaptureTransport extends EventEmitter implements GatewayConnectionTransport {
  readonly readyState = 1;
  readonly bufferedAmount = 0;
  readonly frames: string[] = [];

  send(frame: string, callback?: SendCallback): void;
  send(frame: Buffer, options: { binary: false }, callback?: SendCallback): void;
  send(
    frame: string | Buffer,
    options?: { binary: false } | SendCallback,
    callback?: SendCallback,
  ): void {
    this.frames.push(typeof frame === "string" ? frame : frame.toString("utf8"));
    (typeof options === "function" ? options : callback)?.();
  }

  close(code = 1000, reason = ""): void {
    this.emit("close", code, Buffer.from(reason));
  }

  terminate(): void {
    throw new Error("Unexpected transport retirement in MEDIA broadcast proof");
  }
}

describe("actual session.message MEDIA broadcast", () => {
  let state: OpenClawTestState;

  beforeAll(async () => {
    state = await createOpenClawTestState({ label: "media-display-proof", scenario: "minimal" });
    setRuntimeConfigSnapshot({});
  });

  afterAll(async () => {
    await closeOpenClawStateDatabaseAsync();
    await state?.cleanup();
  });

  it.each([
    ["CR", "\r"],
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])(
    "withholds managed relative directives across %s at the serialized boundary",
    async (name, separator) => {
      const sessionKey = "agent:main:media-display-proof";
      const managedUrl = "./attachment-catalog-tiny/demo.jpg";
      const visibleLines = [
        "Prepared the mixed batch.",
        "MEDIA:https://cdn.example.test/legacy.jpg",
        "MEDIA:/media/legacy-audio.mp3",
      ];
      const sourceText = [...visibleLines, `MEDIA:${managedUrl}`].join(separator);
      const source = {
        role: "assistant",
        content: [{ type: "text", text: sourceText }],
      };
      const sourceBytes = Buffer.from(sourceText, "utf8");
      const parsed = splitMediaFromOutput(sourceText);
      expect(parsed.mediaUrls).toEqual([
        "https://cdn.example.test/legacy.jpg",
        "/media/legacy-audio.mp3",
        managedUrl,
      ]);
      const message = recordAssistantManagedMediaUrls(source, parsed.mediaUrls);
      expect(message).toMatchObject({ openclawDelivery: { mediaUrls: parsed.mediaUrls } });
      expect(message.content[0].text).toBe(sourceText);
      const preparedSnapshot = structuredClone(message);

      const socket = new CaptureTransport();
      const client: GatewayWsClient = {
        connId: "media-display-client",
        socket,
        usesSharedGatewayAuth: false,
        connect: {
          minProtocol: 1,
          maxProtocol: 1,
          client: { id: "cli", version: "proof", platform: "linux", mode: "cli" },
          role: "operator",
          scopes: ["operator.read", "operator.sessions.read"],
        },
      };
      const clients = new GatewayClientRegistry([client]);
      const isActive = (connId: string) => clients.getByConnectionId(connId) !== undefined;
      const sessionEventSubscribers = createSessionEventSubscriberRegistry(isActive);
      const sessionMessageSubscribers = createSessionMessageSubscriberRegistry(isActive);
      sessionMessageSubscribers.subscribe(client.connId, sessionKey);
      const broadcaster = createGatewayBroadcaster({ clients, sessionMessageSubscribers });
      const handler = createTranscriptUpdateBroadcastHandler({
        broadcastToConnIds: broadcaster.broadcastToConnIds,
        sessionEventSubscribers,
        sessionMessageSubscribers,
        chatAbortControllers: new Map(),
      });
      try {
        await handler({
          target: { agentId: "main", sessionId: "media-display-proof", sessionKey },
          message,
          messageSeq: 7,
        });
        expect(socket.frames).toHaveLength(1);
        const frame: unknown = JSON.parse(socket.frames[0]);
        expect(frame).toMatchObject({
          type: "event",
          event: "session.message",
          seq: 1,
          payload: { sessionKey, agentId: "main", messageSeq: 7 },
        });
        expect(message).toEqual(preparedSnapshot);
        expect(Buffer.from(message.content[0].text, "utf8")).toEqual(sourceBytes);
        console.log(
          "MEDIA_BROADCAST_TRACE",
          JSON.stringify({
            separator: name,
            frames: socket.frames.length,
            sourceBytesPreserved: true,
            producerMediaRefs: parsed.mediaUrls,
            managedVisible: socket.frames[0].includes("attachment-catalog-tiny"),
          }),
        );
        expect(frame).toMatchObject({
          payload: { message: { content: [{ type: "text", text: visibleLines.join("\n") }] } },
        });
        expect(socket.frames[0]).not.toContain("attachment-catalog-tiny");
        expect(socket.frames[0]).not.toContain("openclawDelivery");
        console.log(`MEDIA_BROADCAST_PASS ${name}`);
      } finally {
        sessionMessageSubscribers.unsubscribeAll(client.connId);
        clients.delete(client);
      }
    },
  );
});

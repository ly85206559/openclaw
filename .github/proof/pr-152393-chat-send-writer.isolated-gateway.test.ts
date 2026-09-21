import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RawData, WebSocket } from "ws";
import type { ReplyDispatchRun } from "../../auto-reply/get-reply-options.types.js";
import {
  setReplyPayloadMetadata,
  type ReplyPayload,
  type SessionWriterDeliveryAuthority,
} from "../../auto-reply/reply-payload.js";
import { patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import {
  dispatchInboundMessageMock,
  installGatewayTestHooks,
  mockGetReplyFromConfigOnce,
  rpcReq,
  testState,
  writeSessionStore,
} from "../test-helpers.js";
import { installConnectedControlUiServerSuite } from "../test-with-server.js";

installGatewayTestHooks({ scope: "suite" });

const PRODUCT_HEAD = "035b709cf3ab247e70270d01000e386bc5331aef";
const MEDIA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

type Owner = "current" | "stale";

type ProofCase = {
  name: string;
  blockOwner: Owner;
  finalOwner: Owner;
  expectedAssistantRows: number;
  expectedContentFrames: number;
};

type ChatWirePayload = {
  runId?: string;
  state?: string;
  message?: unknown;
};

type ChatHistoryPayload = {
  messages?: unknown[];
};

type ChatSendPayload = {
  runId?: string;
  status?: string;
};

const proofCases: ProofCase[] = [
  {
    name: "current block then current final",
    blockOwner: "current",
    finalOwner: "current",
    expectedAssistantRows: 1,
    expectedContentFrames: 1,
  },
  {
    name: "stale block then stale final",
    blockOwner: "stale",
    finalOwner: "stale",
    expectedAssistantRows: 0,
    expectedContentFrames: 0,
  },
  {
    name: "stale block then current final",
    blockOwner: "stale",
    finalOwner: "current",
    expectedAssistantRows: 0,
    expectedContentFrames: 0,
  },
  // The block is independently deliverable after the replacement claim. The stale final must
  // not add a second content frame or transcript row when owner compatibility prevents folding.
  {
    name: "current block then stale final",
    blockOwner: "current",
    finalOwner: "stale",
    expectedAssistantRows: 1,
    expectedContentFrames: 1,
  },
];

let ws: WebSocket;
const tempDirs: string[] = [];

installConnectedControlUiServerSuite((started) => {
  ws = started.ws;
});

beforeEach(() => {
  dispatchInboundMessageMock.mockReset();
});

afterAll(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
  testState.sessionStorePath = undefined;
});

function visibleText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(visibleText).filter(Boolean).join(" ");
  }
  if (!value || typeof value !== "object") {
    return "";
  }
  const record = value as Record<string, unknown>;
  return [record.text, record.content].map(visibleText).filter(Boolean).join(" ");
}

function assistantRowsContaining(messages: readonly unknown[], text: string): unknown[] {
  return messages.filter((message) => {
    if (!message || typeof message !== "object") {
      return false;
    }
    const record = message as Record<string, unknown>;
    return record.role === "assistant" && visibleText(record).includes(text);
  });
}

function attachAuthority(
  payload: ReplyPayload,
  authority: SessionWriterDeliveryAuthority,
): ReplyPayload {
  return setReplyPayloadMetadata(payload, {
    sessionWriterDeliveryAuthority: authority,
  });
}

async function createSessionStorePath(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pr-152393-proof-"));
  tempDirs.push(dir);
  return path.join(dir, "sessions.json");
}

describe("PR #152393 registered chat.send writer-authority proof", () => {
  it.each(proofCases)(
    "$name",
    { timeout: 30_000 },
    async ({ name, blockOwner, finalOwner, expectedAssistantRows, expectedContentFrames }) => {
      const suffix = randomUUID();
      const sessionKey = `agent:main:pr-152393-${suffix}`;
      const sessionId = `session-${suffix}`;
      const sourceWriterRunId = `source-writer-${suffix}`;
      const replacementWriterRunId = `replacement-writer-${suffix}`;
      const clientRunId = `chat-send-${suffix}`;
      const replyText = `PR 152393 owner proof ${suffix}`;
      const storePath = await createSessionStorePath();
      testState.sessionStorePath = storePath;

      await writeSessionStore({
        entries: {
          [sessionKey]: {
            activeWriterRunId: sourceWriterRunId,
            sessionId,
            updatedAt: Date.now(),
          },
        },
        storePath,
      });

      const authorityFor = (owner: Owner): SessionWriterDeliveryAuthority => ({
        agentId: "main",
        expectedSessionId: sessionId,
        expectedWriterRunId: owner === "current" ? replacementWriterRunId : sourceWriterRunId,
        sessionKey,
        storePath,
      });
      const replyDispatchRun: ReplyDispatchRun = {
        completionSource: "reply-dispatch",
        getResult: () => ({}),
      };
      let resolverCalls = 0;

      mockGetReplyFromConfigOnce(async (_ctx, options) => {
        resolverCalls += 1;
        options?.onAgentRunStart?.(`agent-run-${suffix}`, undefined, replyDispatchRun);
        await options?.onBlockReply?.(
          attachAuthority({ text: replyText, mediaUrl: MEDIA_URL }, authorityFor(blockOwner)),
        );

        const replacement = await patchSessionEntryCore(
          { agentId: "main", sessionKey, storePath },
          () => ({ activeWriterRunId: replacementWriterRunId }),
          { preserveActivity: true, requireWriteSuccess: true },
        );
        expect(replacement?.activeWriterRunId).toBe(replacementWriterRunId);

        return attachAuthority(
          { text: replyText, mediaUrls: [MEDIA_URL] },
          authorityFor(finalOwner),
        );
      });

      const chatFrames: ChatWirePayload[] = [];
      const onMessage = (raw: RawData) => {
        try {
          const frame = JSON.parse(rawDataToString(raw)) as {
            type?: string;
            event?: string;
            payload?: ChatWirePayload;
          };
          if (
            frame.type === "event" &&
            frame.event === "chat" &&
            frame.payload?.runId === clientRunId
          ) {
            chatFrames.push(frame.payload);
          }
        } catch {
          // The shared socket can carry unrelated test-server frames.
        }
      };
      ws.on("message", onMessage);

      try {
        const sent = await rpcReq<ChatSendPayload>(
          ws,
          "chat.send",
          {
            idempotencyKey: clientRunId,
            message: `exercise ${name}`,
            sessionKey,
          },
          20_000,
        );
        expect(sent.ok).toBe(true);
        expect(sent.payload).toMatchObject({ runId: clientRunId, status: "started" });

        await vi.waitFor(
          () => {
            expect(chatFrames.some((frame) => frame.state === "final")).toBe(true);
          },
          { interval: 50, timeout: 15_000 },
        );

        const history = await rpcReq<ChatHistoryPayload>(
          ws,
          "chat.history",
          { limit: 50, sessionKey },
          10_000,
        );
        expect(history.ok).toBe(true);
        const historyMessages = history.payload?.messages ?? [];
        const assistantRows = assistantRowsContaining(historyMessages, replyText);
        const contentFrames = chatFrames.filter((frame) =>
          visibleText(frame.message).includes(replyText),
        );
        const terminalFrames = chatFrames.filter((frame) => frame.state === "final");

        expect(resolverCalls).toBe(1);
        expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
        expect(contentFrames).toHaveLength(expectedContentFrames);
        expect(assistantRows).toHaveLength(expectedAssistantRows);
        expect(terminalFrames.length).toBeGreaterThan(0);

        console.log(
          `PROOF_RECEIPT ${JSON.stringify({
            assistantRows: assistantRows.length,
            blockOwner,
            case: name,
            contentFrames: contentFrames.length,
            expectedAssistantRows,
            expectedContentFrames,
            finalOwner,
            productHead: process.env.PR_152393_PRODUCT_HEAD ?? PRODUCT_HEAD,
            proofHead: process.env.PR_152393_PROOF_HEAD ?? "unknown",
            terminalFrames: terminalFrames.length,
          })}`,
        );
      } finally {
        ws.off("message", onMessage);
      }
    },
  );
});

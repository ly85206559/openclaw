import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, test } from "vitest";
import type { WebSocket } from "ws";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  stageSessionPendingInput,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { installGatewayTestHooks, rpcReq, testState, writeSessionStore } from "../test-helpers.js";
import { installConnectedControlUiServerSuite } from "../test-with-server.js";

const EXACT_PR_HEAD = "56347bbdf88020dbda839be75188932acb45f864";
const DATA_URL = " \tDATA:image/png;BASE64,cGVuZGluZw==";
const NESTED_DATA_URL = "\n data:image/jpeg;base64,bmVzdGVk";
const SOURCE_URL = "  data:image/webp;base64,c291cmNl";
const SOURCE_DATA = "raw-source-data";
const REMOTE_URL = "https://example.test/history-image.png";
const SESSION_ID = "sess-pending-inline-media-proof";
const SESSION_KEY = "agent:main:main";
const proofDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "pr-99556-nested-history",
);

installGatewayTestHooks({ scope: "suite" });

let ws: WebSocket;
installConnectedControlUiServerSuite((started) => {
  ws = started.ws;
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function expectRedactedContent(content: unknown): void {
  expect(content).toEqual([
    {
      type: "input_image",
      omitted: true,
      bytes: Buffer.byteLength(DATA_URL, "utf8"),
    },
    {
      type: "input_image",
      omitted: true,
      bytes: Buffer.byteLength(NESTED_DATA_URL, "utf8"),
      image_url: { detail: "high" },
    },
    {
      type: "input_image",
      omitted: true,
      bytes: Buffer.byteLength(SOURCE_URL, "utf8"),
      source: { media_type: "image/webp" },
    },
    {
      type: "input_image",
      omitted: true,
      bytes: Buffer.byteLength(SOURCE_DATA, "utf8"),
      source: { media_type: "image/png" },
    },
    {
      type: "input_image",
      source: { media_type: "image/png", url: REMOTE_URL },
    },
  ]);
}

function expectNoInlinePayload(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const payload of [DATA_URL, NESTED_DATA_URL, SOURCE_URL, SOURCE_DATA]) {
    expect(serialized).not.toContain(payload);
  }
  expect(serialized).toContain(REMOTE_URL);
}

describe("pending inline media proof (real WS gateway)", () => {
  test("redacts pending history and single-message reads", async () => {
    const dir = tempDirs.make("openclaw-pending-inline-media-proof-");
    testState.sessionStorePath = path.join(dir, "sessions.json");
    const scope = {
      agentId: "main",
      sessionKey: SESSION_KEY,
      sessionId: SESSION_ID,
      storePath: testState.sessionStorePath,
    };
    try {
      await writeSessionStore({
        entries: {
          [SESSION_KEY]: { sessionId: SESSION_ID, updatedAt: Date.now() },
        },
      });
      await upsertSessionEntryCore(scope, { sessionId: SESSION_ID, updatedAt: Date.now() });
      const receipt = expectDefined(
        await stageSessionPendingInput(scope, {
          runId: "pending-image-proof-run",
          assertCurrent: () => {},
          message: {
            role: "user",
            content: [
              { type: "input_image", image_url: DATA_URL },
              { type: "input_image", image_url: { detail: "high", url: NESTED_DATA_URL } },
              { type: "input_image", source: { media_type: "image/webp", url: SOURCE_URL } },
              { type: "input_image", source: { data: SOURCE_DATA, media_type: "image/png" } },
              { type: "input_image", source: { media_type: "image/png", url: REMOTE_URL } },
            ],
            timestamp: Date.now(),
            idempotencyKey: "pending-image-proof:user",
          } as never,
        }),
        "pending proof receipt",
      );
      try {
        const history = await rpcReq<{
          pendingInputs?: { items?: Array<{ message?: Record<string, unknown> }> };
        }>(ws, "chat.history", { sessionKey: SESSION_KEY, limit: 10 }, 60_000);
        expect(history.ok).toBe(true);
        const pendingMessage = history.payload?.pendingInputs?.items?.[0]?.message;
        expectRedactedContent(pendingMessage?.content);
        expectNoInlinePayload(history.payload);

        const messageGet = await rpcReq<{
          ok?: boolean;
          message?: Record<string, unknown>;
        }>(
          ws,
          "chat.message.get",
          {
            sessionKey: SESSION_KEY,
            messageId: `pending:${receipt.inputId}`,
          },
          60_000,
        );
        expect(messageGet.ok).toBe(true);
        expect(messageGet.payload?.ok).toBe(true);
        expectRedactedContent(messageGet.payload?.message?.content);
        expectNoInlinePayload(messageGet.payload);

        await mkdir(proofDir, { recursive: true });
        await writeFile(
          path.join(proofDir, "pending-gateway-evidence.json"),
          `${JSON.stringify(
            {
              exactPrHead: EXACT_PR_HEAD,
              chatHistoryPendingContent: pendingMessage?.content,
              chatMessageGetContent: messageGet.payload?.message?.content,
              inlinePayloadPresent: false,
              remoteReferencePreserved: true,
            },
            null,
            2,
          )}\n`,
          "utf8",
        );
      } finally {
        receipt.finish("interrupted");
      }
    } finally {
      testState.sessionStorePath = undefined;
    }
  });
});

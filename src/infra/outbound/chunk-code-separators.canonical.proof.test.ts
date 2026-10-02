// Fork-only canonical send proof: real plugin/planner/adapter; deps.matrix captures
// the send boundary. skipQueue excludes custody, and no homeserver/API is contacted.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { matrixPlugin } from "../../../extensions/matrix/channel-plugin-api.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { sendMessage } from "./message.js";

describe("canonical Matrix sendMessage Unicode code proof", () => {
  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "matrix", plugin: matrixPlugin, source: "test" }]),
    );
  });

  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
  });

  it.each(
    [
      { label: "U+2028", separator: "\u2028" },
      { label: "U+2029", separator: "\u2029" },
    ].flatMap((testCase) =>
      (["length", "newline"] as const).map((chunkMode) => ({ ...testCase, chunkMode })),
    ),
  )("preserves literal $label in fenced JSON in $chunkMode mode", async ({ separator, chunkMode }) => {
    const to = "!unicode-proof:example.test";
    const messageId = "$canonical-unicode-proof";
    const text = `\`\`\`json\n{"separator":"first${separator}second"}\n\`\`\``;
    const cfg: OpenClawConfig = {
      channels: { matrix: { enabled: true, textChunkLimit: 4000, streaming: { chunkMode } } },
    };
    const sendMatrix = vi.fn(async (target: string, content: string) => ({
      messageId,
      roomId: target,
      content,
    }));

    const result = await sendMessage({
      cfg,
      channel: "matrix",
      to,
      content: text,
      skipQueue: true,
      deps: { matrix: sendMatrix },
    });

    expect(sendMatrix).toHaveBeenCalledTimes(1);
    const call = sendMatrix.mock.calls[0];
    if (!call) {
      throw new Error("Expected the canonical Matrix send dependency to be called");
    }
    const [sentTo, sentText] = call;
    expect(sentTo).toBe(to);
    expect(result).toMatchObject({
      channel: "matrix",
      via: "direct",
      deliveryStatus: "sent",
      result: {
        messageId,
        target: { kind: "room", id: to },
        receipt: {
          primaryPlatformMessageId: messageId,
          platformMessageIds: [messageId],
          parts: [{ platformMessageId: messageId, kind: "text", index: 0 }],
        },
      },
    });
    expect(JSON.parse(sentText.slice("```json\n".length, -"\n```".length))).toEqual({
      separator: `first${separator}second`,
    });
    expect(sentText).toBe(text);
  });
});

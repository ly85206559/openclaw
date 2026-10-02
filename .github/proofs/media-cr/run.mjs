import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const phase = process.env.PROOF_EXPECT;
assert.ok(phase === "red" || phase === "green");
const root = process.cwd();
const { buildReplyPayloads } = await import(pathToFileURL(path.join(root, "src/auto-reply/reply/agent-runner-payloads.ts")));
const { createBlockReplyDeliveryHandler } = await import(pathToFileURL(path.join(root, "src/auto-reply/reply/reply-delivery.ts")));
const { setBlockReplyDelivery } = await import(pathToFileURL(path.join(root, "src/auto-reply/reply/block-reply-delivery.ts")));
const { loadWebMediaRaw } = await import(pathToFileURL(path.join(root, "src/media/web-media.ts")));
const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "media-cr-proof-"));
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jM1sAAAAASUVORK5CYII=", "base64");
const file = path.join(fixtureDir, "image.png");
const secondFile = path.join(fixtureDir, "second.png");
await writeFile(file, png);
await writeFile(secondFile, png);

try {
  for (const newline of ["\n", "\r\n", "\r"]) {
    const { replyPayloads } = await buildReplyPayloads({
      payloads: [{ text: `MEDIA:${file}${newline}Caption` }],
      isHeartbeat: false,
      didLogHeartbeatStrip: false,
      blockStreamingEnabled: false,
      blockReplyPipeline: null,
      replyToMode: "off",
    });
    assert.equal(replyPayloads.length, 1);
    const reply = replyPayloads[0];
    const receipts = [];
    const consumed = [];
    const deliver = createBlockReplyDeliveryHandler({
      onBlockReply: async (payload) => {
        for (const url of payload.mediaUrls ?? []) {
          const media = await loadWebMediaRaw(url, { localRoots: [fixtureDir] });
          assert.deepEqual(media.buffer, png);
          assert.equal(media.contentType, "image/png");
          assert.equal(media.kind, "image");
          consumed.push({ fileName: media.fileName, sha256: createHash("sha256").update(media.buffer).digest("hex") });
        }
        assert.equal(payload.text, "Caption");
        setBlockReplyDelivery(Promise.resolve({ outcome: "delivered" }), payload);
      },
      normalizeStreamingText: (payload) => ({ text: payload.text, skip: false }),
      applyReplyToMode: (payload) => payload,
      typingSignals: { signalTextDelta: async () => {} },
      blockStreamingEnabled: false,
      blockReplyPipeline: null,
      directBlockDeliveries: receipts,
    });
    if (phase === "red" && newline === "\r") {
      assert.equal(reply.mediaUrls?.[0], `${file}\rCaption`);
      await assert.rejects(deliver(reply, { completed: true }), (error) => error.code === "not-found" && error.message.includes(`${file}\rCaption`));
      assert.equal(consumed.length, 0);
      assert.equal(receipts.length, 1);
      assert.equal(receipts[0].outcome, "failed-deliver");
      assert.equal(receipts[0].pending, false);
      assert.equal(receipts[0].terminalDeliveryConfirmed, undefined);
      console.log(JSON.stringify({ phase: "RED", source: process.env.SOURCE_SHA, newline, failure: "caption incorporated into nonexistent file path", settled: receipts[0].outcome }));
    } else {
      assert.deepEqual(reply.mediaUrls, [file]);
      assert.equal(reply.text, "Caption");
      await deliver(reply, { completed: true });
      assert.equal(consumed.length, 1);
      assert.equal(receipts.length, 1);
      assert.equal(receipts[0].outcome, "delivered");
      assert.equal(receipts[0].pending, false);
      assert.equal(receipts[0].terminalDeliveryConfirmed, true);
      console.log(JSON.stringify({ phase, source: process.env.SOURCE_SHA, newline, caption: reply.text, consumed, settled: receipts[0].outcome }));
    }
  }
  if (phase === "green") {
    const { replyPayloads } = await buildReplyPayloads({
      payloads: [{ text: `MEDIA:${file}\rMEDIA:${secondFile}\rCaption` }],
      isHeartbeat: false,
      didLogHeartbeatStrip: false,
      blockStreamingEnabled: false,
      blockReplyPipeline: null,
      replyToMode: "off",
    });
    assert.equal(replyPayloads.length, 1);
    assert.deepEqual(replyPayloads[0].mediaUrls, [file, secondFile]);
    assert.equal(replyPayloads[0].text, "Caption");
    for (const url of replyPayloads[0].mediaUrls) {
      assert.deepEqual((await loadWebMediaRaw(url, { localRoots: [fixtureDir] })).buffer, png);
    }
    console.log(JSON.stringify({ phase: "GREEN", source: process.env.SOURCE_SHA, consecutiveAttachments: 2, actualPngBytes: png.length }));
  }
} finally {
  await rm(fixtureDir, { recursive: true, force: false });
}

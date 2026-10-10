import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

const sourcePath = "src/auto-reply/reply/agent-runner-execution.test-support.ts";
const source = await fs.readFile(sourcePath, "utf8");
let support = source;
const changes = [
  [
    `vi.mock("../../config/sessions.js", () => ({
  resolveGroupSessionKey: vi.fn(() => null),
  resolveSessionTranscriptPath: vi.fn(),
  updateSessionStore: state.updateSessionStoreMock,
}));`,
    `vi.mock("../../config/sessions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/sessions.js")>()),
  updateSessionStore: state.updateSessionStoreMock,
}));`,
  ],
  [
    `vi.mock("../../runtime.js", () => ({
  defaultRuntime: {
    error: vi.fn(),
  },
}));`,
    "",
  ],
  [
    `vi.mock("../../utils/message-channel.js", async () => ({
  ...(await vi.importActual<typeof import("../../utils/message-channel.js")>(
    "../../utils/message-channel.js",
  )),
  isMarkdownCapableMessageChannel: () => true,
  resolveMessageChannel: () => "whatsapp",
  isInternalMessageChannel: (value: unknown) => state.isInternalMessageChannelMock(value),
}));`,
    "",
  ],
];
for (const [before, after] of changes) {
  assert.equal(support.split(before).length, 2, "Expected exactly one pinned unit-harness block");
  support = support.replace(before, after);
}
const outputDir = path.join(process.env.RUNNER_TEMP, "proof");
await fs.writeFile(path.join(outputDir, "registered-support.test-support.ts"), support);
await fs.writeFile(path.join(outputDir, "original-support.test-support.ts"), source);
console.info("REGISTERED_SUPPORT_RECEIPT", JSON.stringify({
  sourcePath,
  sourceSha256: createHash("sha256").update(source).digest("hex"),
  supportSha256: createHash("sha256").update(support).digest("hex"),
  changes: ["retain real session exports, isolate agent update", "retain real runtime", "retain real message-channel owner"],
}));

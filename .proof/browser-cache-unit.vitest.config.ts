import { createScopedVitestConfig } from "../test/vitest/vitest.scoped-config.ts";

const files = {
  browser: "extensions/browser/src/browser/chrome.default-browser.test.ts",
  media: "src/gateway/chat-display-projection.media.test.ts",
  nfc: "extensions/memory-core/src/memory/mmr.test.ts",
};
const lane = process.env.PROOF_LANE as keyof typeof files;
if (!Object.hasOwn(files, lane)) {
  throw new Error("Unknown proof lane");
}

export default createScopedVitestConfig([files[lane]], {
  pool: "forks",
  isolate: true,
  passWithNoTests: false,
  excludeUnitFastTests: false,
});

import { createScopedVitestConfig } from "../test/vitest/vitest.scoped-config.ts";

export default createScopedVitestConfig([".proof/browser-cache-media-websocket.test.ts"], {
  name: "media-websocket-proof",
  pool: "forks",
  isolate: true,
  passWithNoTests: false,
  excludeUnitFastTests: false,
});

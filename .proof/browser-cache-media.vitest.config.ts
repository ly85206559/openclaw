import { createScopedVitestConfig } from "../test/vitest/vitest.scoped-config.ts";

export default createScopedVitestConfig([".proof/browser-cache-media-runtime.test.ts"], {
  name: "media-broadcast-runtime-proof",
  pool: "forks",
  isolate: true,
  passWithNoTests: false,
  excludeUnitFastTests: false,
});

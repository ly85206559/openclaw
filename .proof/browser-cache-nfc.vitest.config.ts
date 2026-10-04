import { createScopedVitestConfig } from "../test/vitest/vitest.scoped-config.ts";

export default createScopedVitestConfig([".proof/browser-cache-nfc-runtime.test.ts"], {
  name: "nfc-runtime-proof",
  pool: "forks",
  isolate: true,
  passWithNoTests: false,
  excludeUnitFastTests: false,
});

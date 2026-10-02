// Fork-only real transport fixture, copied into test/vitest beside its owner.
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export default createScopedVitestConfig(
  ["src/infra/outbound/chunk-code-separators.synapse.proof.test.ts"],
  {
    name: "infra",
    isolate: true,
    pool: "forks",
    // This explicit transport fixture is not part of the auto-curated unit lanes.
    excludeUnitFastTests: false,
    passWithNoTests: false,
  },
);

import { writeFileSync } from "node:fs";

export default class ProofAuditReporter {
  onTestRunEnd(modules, errors, reason) {
    const suiteErrors = modules.flatMap((module) =>
      [module, ...module.children.allSuites()].flatMap((suite) =>
        suite.errors().map((error) => String(error)),
      ),
    );
    writeFileSync(
      `${process.env.RUNNER_TEMP}/proof/runner-audit.json`,
      JSON.stringify({ reason, errors: errors.map((error) => String(error)), suiteErrors }, null, 2),
    );
    console.log("PROOF_VITEST_TEST_RUN_ENDED");
  }
}

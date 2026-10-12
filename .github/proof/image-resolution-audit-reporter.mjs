import { writeFileSync } from "node:fs";

export default class AuditReporter {
  onTestRunEnd(modules, errors, reason) {
    const suiteErrors = modules
      .flatMap((module) => [module, ...module.children.allSuites()])
      .reduce((count, suite) => count + suite.errors().length, 0);
    writeFileSync(
      process.env.PROOF_AUDIT_PATH,
      JSON.stringify({ reason, moduleCount: modules.length, unhandledErrors: errors.length, suiteErrors }),
    );
  }
}

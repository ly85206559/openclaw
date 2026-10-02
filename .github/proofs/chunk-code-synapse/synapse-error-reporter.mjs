import fs from "node:fs";

// Vitest's JSON reporter omits unhandled errors and nested suite hook errors.
export default class SynapseErrorReporter {
  onUserConsoleLog(log) {
    process.stdout.write(log.content);
  }

  onTestRunEnd(modules, unhandledErrors, reason) {
    let suiteErrors = 0;
    function visit(task) {
      if (task.type === "suite") {
        suiteErrors += task.result?.errors?.length ?? 0;
        for (const child of task.tasks) visit(child);
      }
    }
    for (const module of modules) visit(module.task);
    fs.writeFileSync("/tmp/chunk-code-separators-synapse-runtime.json", JSON.stringify({
      unhandledErrors: unhandledErrors.length, suiteErrors, reason,
    }));
  }
}

import fs from "node:fs";

// The Vitest JSON reporter omits unhandled errors and nested suite hook errors.
export default class ContractErrorReporter {
  onUserConsoleLog(log) {
    process.stdout.write(log.content);
  }

  onTestRunEnd(modules, unhandledErrors, reason) {
    let suiteErrors = 0;
    let hookErrors = 0;
    function visit(task) {
      hookErrors += Object.values(task.result?.hooks ?? {}).filter(state => state !== "pass").length;
      if (task.type === "suite") {
        suiteErrors += task.result?.errors?.length ?? 0;
        for (const child of task.tasks) visit(child);
      }
    }
    for (const module of modules) visit(module.task);
    fs.writeFileSync(process.env.PROOF_RUNTIME_REPORT, JSON.stringify({
      unhandledErrors: unhandledErrors.length, suiteErrors, hookErrors, reason,
    }));
  }
}

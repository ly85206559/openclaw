import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";

const [reportPath, exitCodeText, mode, lane, destination] = process.argv.slice(2);
assert.equal(process.env.GITHUB_ACTIONS, "true", "secretless Actions only");
assert.ok(mode === "baseline" || mode === "candidate");
const report = JSON.parse(await readFile(reportPath, "utf8"));
const expectedFailures = {
  video: ["passes video generation parameters through to runtime"],
  teams: ["renders Graph read and search messages while preserving JSON results"],
  web: [
    "preserves literal code through HTTP text extraction for /markdown-tilde",
    "preserves literal code through HTTP text extraction for /markdown-long",
    "preserves literal code through HTTP text extraction for /markdown-false-close",
    "preserves literal code through HTTP text extraction for /markdown-unclosed",
  ],
}[lane];
assert.ok(expectedFailures, "known lane required");
const assertions = report.testResults.flatMap((suite) => suite.assertionResults);
assert.ok(assertions.length > expectedFailures.length, "original sibling controls must execute");
assert.equal(report.numTotalTests, assertions.length, "complete native test inventory required");
assert.equal(report.numPendingTests, 0, "no skips/todo");
assert.ok(report.testResults.length > 0, "native suite inventory required");
for (const suite of report.testResults) {
  assert.ok(suite.assertionResults.length > 0, "suite-load failures must not replace test execution");
  assert.equal(suite.status, suite.assertionResults.some((test) => test.status === "failed") ? "failed" : "passed");
}
assert.ok(assertions.every((test) => test.status === "passed" || test.status === "failed"));
for (const title of expectedFailures) {
  const matches = assertions.filter((test) => test.title === title);
  assert.equal(matches.length, 1, `regression must execute exactly once: ${title}`);
  assert.equal(matches[0].status, mode === "baseline" ? "failed" : "passed");
}
const failures = assertions.filter((test) => test.status === "failed");
assert.equal(report.numFailedTests, failures.length);
assert.equal(report.numPassedTests, assertions.length - failures.length);
assert.deepEqual(failures.map((test) => test.title).sort(), mode === "baseline" ? expectedFailures.toSorted() : []);
if (mode === "baseline") {
  assert.equal(Number(exitCodeText), 1, "baseline must fail normally, not timeout/crash");
  assert.equal(report.success, false);
  for (const failure of failures) {
    assert.ok(failure.failureMessages.length > 0);
    for (const message of failure.failureMessages) {
      assert.match(message, lane === "video" ? /expected undefined to deeply equal/u : /expected .* to contain/su,
        "failure must be the caller-visible missing output, not fixture/runner setup");
    }
  }
} else {
  assert.equal(Number(exitCodeText), 0);
  assert.equal(report.success, true);
}
const receipt = {
  lane, mode, rawExitCode: Number(exitCodeText), total: assertions.length,
  passed: assertions.filter((test) => test.status === "passed").length,
  failed: failures.length, skipped: 0, regressionGate: mode === "baseline" ? "RED" : "GREEN",
  failures: failures.map(({ title, failureMessages }) => ({ title, failureMessages })),
  runtimeErrors: "Native JSON has no runtime-error count; raw stdout/stderr require independent inspection.",
  note: "Expected baseline RED is diagnostic success, not product GREEN. Inspect raw logs for unhandled/cleanup errors too.",
};
await writeFile(destination, JSON.stringify(receipt, null, 2));
console.log(JSON.stringify(receipt));

import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const phase = process.env.PROOF_EXPECT;
assert.ok(phase === "red" || phase === "green");
const labels = ["U+2028", "U+2029"];
const plannerName = (label, code, mode) => `outbound message planning plans ${label} in ${code} in ${mode} mode with one implicit reply`;
const deliveryName = (label, mode) => `deliverOutboundPayloads preserves literal ${label} in raw fenced JSON in ${mode} mode`;
const cases = [
  {
    file: "src/infra/outbound/message-plan.test.ts",
    failures: labels.flatMap((label) => ["fenced JSON", "inline code"].map((code) => plannerName(label, code, "newline"))),
    controls: labels.flatMap((label) => ["fenced JSON", "inline code"].map((code) => plannerName(label, code, "length"))),
  },
  {
    file: "src/infra/outbound/deliver.test.ts",
    filter: "preserves literal U\\+202[89] in raw fenced JSON",
    failures: labels.map((label) => deliveryName(label, "newline")),
    controls: labels.map((label) => deliveryName(label, "length")),
  },
  {
    file: "src/auto-reply/chunk.test.ts",
    failures: [],
    controls: ["chunkByParagraph Unicode line/paragraph separators treats lone U+2029 as a standalone paragraph boundary", "chunkByParagraph Unicode line/paragraph separators treats lone U+2028 as a line break within one paragraph"],
  },
];

for (const [index, testCase] of cases.entries()) {
  const reportPath = `/tmp/chunk-code-separators-${index}.json`;
  const args = ["test", testCase.file, "--maxWorkers=1", "--reporter=json", `--outputFile=${reportPath}`];
  if (testCase.filter) args.push("-t", testCase.filter);
  const started = performance.now();
  const result = spawnSync("pnpm", args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  console.log(result.stdout);
  console.log(result.stderr);
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  assert.equal(report.testResults.length, 1);
  assert.ok(report.testResults[0].name.endsWith(`/${testCase.file}`));
  const assertions = report.testResults[0].assertionResults;
  const failures = assertions.filter((test) => test.status === "failed");
  const expectedFailures = phase === "red" ? testCase.failures : [];
  assert.equal(result.status, expectedFailures.length ? 1 : 0);
  assert.deepEqual(failures.map((test) => test.fullName).sort(), [...expectedFailures].sort());
  for (const control of testCase.controls) {
    assert.equal(assertions.find((test) => test.fullName === control)?.status, "passed");
  }
  for (const regression of testCase.failures) {
    assert.equal(assertions.find((test) => test.fullName === regression)?.status, phase === "red" ? "failed" : "passed");
  }
  assert.ok(failures.every((test) => /expected|Unexpected token|Bad control character|SyntaxError/.test(test.failureMessages.join("\n"))));
  if (testCase.filter) {
    assert.equal(assertions.filter((test) => test.status === "passed" || test.status === "failed").length, 4);
  } else {
    assert.ok(assertions.every((test) => test.status === "passed" || failures.includes(test)));
  }
  console.log(JSON.stringify({ phase, source: process.env.SOURCE_SHA, file: testCase.file, failed: failures.map((test) => test.fullName), passed: report.numPassedTests, skippedByExplicitFilter: testCase.filter ? report.numPendingTests : 0, wallSeconds: (performance.now() - started) / 1000, fileSeconds: (report.testResults[0].endTime - report.testResults[0].startTime) / 1000 }));
}

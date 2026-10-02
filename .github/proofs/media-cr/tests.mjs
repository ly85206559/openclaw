import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const phase = process.env.PROOF_EXPECT;
assert.ok(phase === "red" || phase === "green");
const reportPath = "/tmp/media-cr-tests.json";
const started = performance.now();
const result = spawnSync("pnpm", ["test", "src/media/parse.test.ts", "--maxWorkers=1", "--reporter=json", `--outputFile=${reportPath}`], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
console.log(result.stdout);
console.log(result.stderr);
const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
assert.equal(report.testResults.length, 1);
assert.ok(report.testResults[0].name.endsWith("/src/media/parse.test.ts"));
const assertions = report.testResults.flatMap((test) => test.assertionResults);
const failures = assertions.filter((test) => test.status === "failed");
if (phase === "red") {
  assert.equal(result.status, 1);
  const matrixNames = ["separates MEDIA directives", "keeps fenced MEDIA literal"];
  const expectedFailures = [
    ...matrixNames.map((name) => `splitMediaFromOutput ${name} across ${JSON.stringify("\r")} line endings`),
    "splitMediaFromOutput keeps mixed source separators around MEDIA directives",
  ];
  assert.deepEqual(failures.map((test) => test.fullName).sort(), expectedFailures.sort());
  for (const name of matrixNames) {
    for (const newline of ["\n", "\r\n"]) {
      const control = assertions.find((test) => test.fullName === `splitMediaFromOutput ${name} across ${JSON.stringify(newline)} line endings`);
      assert.equal(control?.status, "passed");
    }
  }
  assert.ok(failures.every((test) => /expected/.test(test.failureMessages.join("\n"))));
} else {
  assert.equal(result.status, 0);
  assert.equal(failures.length, 0);
}
assert.ok(assertions.every((test) => test.status === "passed" || failures.includes(test)));
console.log(JSON.stringify({ phase, source: process.env.SOURCE_SHA, failed: failures.map((test) => test.fullName), passed: report.numPassedTests, wallSeconds: (performance.now() - started) / 1000, fileSeconds: (report.testResults[0].endTime - report.testResults[0].startTime) / 1000 }));

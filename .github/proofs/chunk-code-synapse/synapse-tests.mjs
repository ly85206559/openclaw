import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const phase = process.env.PROOF_EXPECT;
assert.ok(phase === "red" || phase === "green");
assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), process.env.SOURCE_SHA);
const file = "src/infra/outbound/chunk-code-separators.synapse.proof.test.ts";
const reportPath = "/tmp/chunk-code-separators-synapse.json";
const started = performance.now();
const errorReporter = fileURLToPath(new URL("./synapse-error-reporter.mjs", import.meta.url));
const result = spawnSync(process.execPath, ["scripts/run-vitest.mjs", "run", "--config=test/vitest/vitest.chunk-code-synapse.proof.config.ts", file, "--pool=forks", "--maxWorkers=1", "--reporter=json", `--reporter=${errorReporter}`, `--outputFile=${reportPath}`], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
console.log(result.stdout);
console.log(result.stderr);
const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
const runtime = JSON.parse(fs.readFileSync("/tmp/chunk-code-separators-synapse-runtime.json", "utf8"));
console.log(JSON.stringify({ runtime, results: report.testResults.map((suite) => ({
  file: suite.name, suiteError: suite.message,
  tests: suite.assertionResults.map((test) => ({ name: test.fullName, status: test.status, failures: test.failureMessages })),
})) }));
assert.equal(runtime.unhandledErrors, 0);
assert.equal(runtime.suiteErrors, 0);
assert.equal(runtime.reason, phase === "red" ? "failed" : "passed");
assert.equal(report.testResults.length, 1);
assert.ok(report.testResults[0].name.endsWith(`/${file}`));
assert.equal(report.testResults[0].message, "");
const assertions = report.testResults[0].assertionResults;
assert.equal(assertions.length, 4);
assert.equal(report.numPendingTests, 0);
assert.equal(report.numTodoTests, 0);
const failures = assertions.filter((test) => test.status === "failed");
const expectedFailures = phase === "red" ? ["U+2028", "U+2029"].map((label) => `real Synapse canonical Matrix Unicode proof preserves literal ${label} in fenced JSON in newline mode`) : [];
assert.equal(result.status, expectedFailures.length ? 1 : 0);
assert.deepEqual(failures.map((test) => test.fullName).sort(), expectedFailures.sort());
assert.equal(report.numFailedTests, expectedFailures.length);
assert.equal(report.numPassedTests, 4 - expectedFailures.length);
assert.ok(assertions.every((test) => test.status === "passed" || test.status === "failed"));
for (const label of ["U+2028", "U+2029"]) {
  assert.equal(assertions.find((test) => test.fullName === `real Synapse canonical Matrix Unicode proof preserves literal ${label} in fenced JSON in length mode`)?.status, "passed");
}
for (const test of failures) {
  assert.equal(test.failureMessages.length, 1);
  const label = test.fullName.includes("U+2028") ? "U+2028" : "U+2029";
  assert.ok(test.failureMessages.join("\n").includes(`SYNAPSE_REMOTE_JSON_REGRESSION:red:${label}:newline`));
}
const output = `${result.stdout}\n${result.stderr}`;
const readbacks = [...output.matchAll(/SYNAPSE_READBACK (\{[^\n]*\})/g)].map((match) => JSON.parse(match[1]));
assert.equal(readbacks.length, 4);
assert.equal(new Set(readbacks.map((row) => row.serverReceipt)).size, 4);
assert.deepEqual(readbacks.map((row) => `${row.label}:${row.mode}`).sort(), ["U+2028:length", "U+2028:newline", "U+2029:length", "U+2029:newline"]);
for (const row of readbacks) {
  assert.equal(row.phase, phase);
  assert.equal(row.source, process.env.SOURCE_SHA);
  assert.ok(row.serverReceipt.startsWith("$"));
  assert.match(row.bodyHash, /^[a-f0-9]{64}$/);
  assert.match(row.htmlHash, /^[a-f0-9]{64}$/);
  assert.equal(row.JSONvalid, !(phase === "red" && row.mode === "newline"));
}
assert.ok(output.includes(`SYNAPSE_CLEANUP_COMPLETE ${phase}`));
console.log(JSON.stringify({ phase, source: process.env.SOURCE_SHA, server: "real task-owned Synapse", file, failed: failures.map((test) => test.fullName), passed: report.numPassedTests, wallSeconds: (performance.now() - started) / 1000, fileSeconds: (report.testResults[0].endTime - report.testResults[0].startTime) / 1000 }));

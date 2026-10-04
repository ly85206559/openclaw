import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const [phase, lane] = process.argv.slice(2);
assert.ok(phase === "red" || phase === "green");
assert.ok(lane === "media" || lane === "nfc");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), `openclaw-runtime-${lane}-`));
const output = path.join(directory, "report.json");
const runtimeOutput = path.join(directory, "runtime.json");
const started = performance.now();
const result = spawnSync(process.execPath, [
  "scripts/run-vitest.mjs", "run", `--config=.proof/browser-cache-${lane}.vitest.config.ts`,
  "--reporter=json", "--reporter=.proof/browser-cache-error-reporter.mjs", `--outputFile=${output}`,
], { env: { ...process.env, OPENCLAW_PROOF_PHASE: phase, PROOF_RUNTIME_REPORT: runtimeOutput },
  encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
console.log(result.stdout);
console.error(result.stderr);
assert.equal(result.error, undefined);
assert.equal(result.signal, null);
const redFailure = phase === "red" && lane === "media";
const report = JSON.parse(fs.readFileSync(output, "utf8"));
const runtime = JSON.parse(fs.readFileSync(runtimeOutput, "utf8"));
console.log(JSON.stringify({ source: process.env.SOURCE_SHA, phase, lane,
  observedAssertions: report.testResults.flatMap(suite => suite.assertionResults.map(test => ({
    fullName: test.fullName, status: test.status, messages: test.failureMessages,
  }))), runtime }));
assert.equal(result.status, redFailure ? 1 : 0);
assert.deepEqual(runtime, { unhandledErrors: 0, suiteErrors: 0, hookErrors: 0,
  reason: redFailure ? "failed" : "passed" });
assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /Unhandled Errors|unhandled rejection|unhandled exception/iu);
assert.equal(report.testResults.length, 1);
const suite = report.testResults[0];
assert.ok(suite.name.replaceAll("\\", "/").endsWith(`/.proof/browser-cache-${lane}-runtime.test.ts`));
assert.equal(suite.message ?? "", "");
const assertions = suite.assertionResults;
assert.equal(assertions.length, lane === "media" ? 3 : 4);
assert.ok(assertions.every(test => test.status === "passed" || test.status === "failed"));
const failures = assertions.filter(test => test.status === "failed");
assert.equal(report.numFailedTests, failures.length);
assert.equal(report.numPassedTests, assertions.length - failures.length);
console.log(JSON.stringify({ source: process.env.SOURCE_SHA, phase, lane,
  observedFailures: failures.map(test => ({ fullName: test.fullName, messages: test.failureMessages })), runtime }));
assert.equal(failures.length, redFailure ? 1 : 0);
if (redFailure) {
  assert.match(failures[0].fullName, /across CR at/u);
  assert.equal(failures[0].failureMessages.length, 1);
  assert.match(failures[0].failureMessages[0], /AssertionError/u);
  assert.match(failures[0].failureMessages[0], /browser-cache-media-runtime.test.ts/u);
}
if (lane === "media") {
  assert.equal((result.stdout.match(/MEDIA_BROADCAST_TRACE/g) ?? []).length, 3);
  assert.equal((result.stdout.match(/MEDIA_BROADCAST_PASS/g) ?? []).length, redFailure ? 2 : 3);
} else {
  assert.equal((result.stdout.match(/NFC_RUNTIME_CASE_OK/g) ?? []).length, 4);
  assert.equal((result.stdout.match(/NFC_RUNTIME_CLEANUP_OK/g) ?? []).length, 1);
}
console.log(JSON.stringify({ source: process.env.SOURCE_SHA, phase, lane, passed: report.numPassedTests,
  runtime, coldWallSeconds: (performance.now() - started) / 1000,
  testSeconds: (suite.endTime - suite.startTime) / 1000 }));

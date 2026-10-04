import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const [phase, lane] = process.argv.slice(2);
assert.ok(["RED", "GREEN"].includes(phase));
const files = {
  browser: "extensions/browser/src/browser/chrome.default-browser.test.ts",
  media: "src/gateway/chat-display-projection.media.test.ts",
  nfc: "extensions/memory-core/src/memory/mmr.test.ts",
};
assert.ok(Object.hasOwn(files, lane));
const directory = fs.mkdtempSync(path.join(os.tmpdir(), `openclaw-${lane}-report-`));
const output = path.join(directory, "report.json");
const runtimeOutput = path.join(directory, "runtime.json");
const started = performance.now();
const result = spawnSync(process.execPath, [
  "scripts/run-vitest.mjs", "run", "--config=.proof/browser-cache-unit.vitest.config.ts",
  "--reporter=json", "--reporter=.proof/browser-cache-error-reporter.mjs", `--outputFile=${output}`,
], { env: { ...process.env, PROOF_LANE: lane, PROOF_RUNTIME_REPORT: runtimeOutput }, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
console.log(result.stdout);
console.error(result.stderr);
assert.equal(result.error, undefined);
assert.equal(result.signal, null);
assert.equal(result.status, phase === "RED" ? 1 : 0);
const report = JSON.parse(fs.readFileSync(output, "utf8"));
const runtime = JSON.parse(fs.readFileSync(runtimeOutput, "utf8"));
assert.equal(runtime.unhandledErrors, 0);
assert.equal(runtime.suiteErrors, 0);
assert.equal(runtime.hookErrors, 0);
assert.equal(runtime.reason, phase === "RED" ? "failed" : "passed");
assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /Unhandled Errors|unhandled rejection|unhandled exception/iu);
assert.equal(report.testResults.length, 1);
const suite = report.testResults[0];
assert.ok(suite.name.replaceAll("\\", "/").endsWith(`/${files[lane]}`));
assert.equal(suite.message ?? "", "");
const assertions = suite.assertionResults;
assert.ok(assertions.length > 0);
assert.ok(assertions.every(test => test.status === "passed" || test.status === "failed"));
const failures = assertions.filter(test => test.status === "failed");
console.log(JSON.stringify({ source: process.env.SOURCE_SHA, phase, lane,
  assertions: assertions.length, observedFailures: failures.map(test => ({
    fullName: test.fullName, title: test.title, messages: test.failureMessages,
  })), runtime }));
assert.equal(report.numFailedTests, failures.length);
assert.equal(report.numPassedTests, assertions.length - failures.length);
if (phase === "RED") {
  const expected = JSON.parse(fs.readFileSync(`.proof/browser-cache-${lane}-failures.json`, "utf8"));
  assert.equal(failures.length, expected.length);
  for (const fragment of expected) {
    const matches = failures.filter(test => test.fullName.includes(fragment));
    assert.equal(matches.length, 1, `Missing or duplicate regression: ${fragment}`);
    assert.equal(matches[0].failureMessages.length, 1);
    const messages = matches[0].failureMessages.join("\n");
    assert.match(messages, /AssertionError/u);
    assert.ok(messages.includes(path.basename(files[lane])));
  }
} else {
  assert.equal(failures.length, 0);
}
console.log(JSON.stringify({ source: process.env.SOURCE_SHA, phase, lane,
  passed: report.numPassedTests, failed: failures.map(test => test.fullName), runtime,
  coldWallSeconds: (performance.now() - started) / 1000,
  testSeconds: (suite.endTime - suite.startTime) / 1000 }));

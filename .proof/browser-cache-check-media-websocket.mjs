import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const [phase] = process.argv.slice(2);
assert.ok(phase === "red" || phase === "green");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-media-websocket-"));
const output = path.join(directory, "report.json");
const runtimeOutput = path.join(directory, "runtime.json");
const started = performance.now();
const result = spawnSync(process.execPath, [
  "scripts/run-vitest.mjs", "run", "--config=.proof/browser-cache-media-websocket.vitest.config.ts",
  "--reporter=json", "--reporter=.proof/browser-cache-error-reporter.mjs", `--outputFile=${output}`,
], { env: { ...process.env, PROOF_RUNTIME_REPORT: runtimeOutput },
  encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
console.log(result.stdout);
console.error(result.stderr);
assert.equal(result.error, undefined);
assert.equal(result.signal, null);
const red = phase === "red";
const report = JSON.parse(fs.readFileSync(output, "utf8"));
const runtime = JSON.parse(fs.readFileSync(runtimeOutput, "utf8"));
assert.equal(result.status, red ? 1 : 0);
assert.deepEqual(runtime, { unhandledErrors: 0, suiteErrors: 0, hookErrors: 0,
  reason: red ? "failed" : "passed" });
assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /Unhandled Errors|unhandled rejection|unhandled exception/iu);
assert.equal(report.testResults.length, 1);
const suite = report.testResults[0];
assert.ok(suite.name.replaceAll("\\", "/").endsWith("/.proof/browser-cache-media-websocket.test.ts"));
assert.equal(suite.message ?? "", "");
const assertions = suite.assertionResults;
assert.equal(assertions.length, 3);
assert.ok(assertions.every(test => test.status === "passed" || test.status === "failed"));
const failures = assertions.filter(test => test.status === "failed");
console.log(JSON.stringify({ source: process.env.SOURCE_SHA, phase,
  failures: failures.map(test => ({ fullName: test.fullName, messages: test.failureMessages })), runtime }));
assert.equal(report.numFailedTests, failures.length);
assert.equal(report.numPassedTests, assertions.length - failures.length);
assert.equal(failures.length, red ? 1 : 0);
if (red) {
  assert.match(failures[0].fullName, /\bCR\b/u);
  assert.equal(failures[0].failureMessages.length, 1);
  assert.match(failures[0].failureMessages[0], /AssertionError/u);
  assert.match(failures[0].failureMessages[0], /browser-cache-media-websocket.test.ts/u);
  assert.match(failures[0].failureMessages[0], /attachment-catalog-tiny\/demo\.jpg/u);
  const testSource = fs.readFileSync(".proof/browser-cache-media-websocket.test.ts", "utf8");
  const displayAssertion = 'expect(receivedMessage?.content).toEqual([{ type: "text", text: visibleLines.join("\\n") }]);';
  const assertionLines = testSource.split(/\r?\n/u);
  assert.equal(assertionLines.filter(line => line.trim() === displayAssertion).length, 1);
  const assertionLine = assertionLines.findIndex(line => line.trim() === displayAssertion) + 1;
  assert.ok(failures[0].failureMessages[0].includes(`browser-cache-media-websocket.test.ts:${assertionLine}:`));
}
assert.equal((result.stdout.match(/MEDIA_WEBSOCKET_TRACE/g) ?? []).length, 3);
const traces = [...result.stdout.matchAll(/MEDIA_WEBSOCKET_TRACE (\{[^\r\n]+\})/gu)]
  .map(match => JSON.parse(match[1]));
assert.deepEqual(traces.map(trace => trace.separator).sort(), ["CR", "CRLF", "LF"]);
const visibleLines = ["Prepared the mixed batch.", "MEDIA:https://cdn.example.test/legacy.jpg",
  "MEDIA:/media/legacy-audio.mp3"];
const managedUrl = "./attachment-catalog-tiny/demo.jpg";
for (const trace of traces) {
  assert.equal(trace.subscribed, true);
  assert.equal(trace.unsubscribed, true);
  assert.equal(trace.sourceBytesPreserved, true);
  assert.deepEqual(trace.producerMediaRefs, ["https://cdn.example.test/legacy.jpg",
    "/media/legacy-audio.mp3", managedUrl]);
  const expectedText = red && trace.separator === "CR"
    ? [...visibleLines, `MEDIA:${managedUrl}`].join("\r") : visibleLines.join("\n");
  assert.deepEqual(trace.received, { role: "assistant", content: [{ type: "text", text: expectedText }] });
}
assert.equal((result.stdout.match(/MEDIA_WEBSOCKET_PASS/g) ?? []).length, red ? 2 : 3);
assert.equal((result.stdout.match(/MEDIA_WEBSOCKET_CLEANUP_OK/g) ?? []).length, 1);
console.log(JSON.stringify({ source: process.env.SOURCE_SHA, phase,
  passed: report.numPassedTests, runtime, coldWallSeconds: (performance.now() - started) / 1000,
  testSeconds: (suite.endTime - suite.startTime) / 1000 }));

import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const phase = process.env.PROOF_EXPECT;
assert.ok(phase === "red" || phase === "green");
const reportPath = "/tmp/discord-playback-clock.json";
const started = performance.now();
const result = spawnSync("pnpm", ["test", "extensions/discord/src/voice/realtime-playback.test.ts", "--maxWorkers=1", "--reporter=json", `--outputFile=${reportPath}`], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
console.log(result.stdout);
console.log(result.stderr);
const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
assert.equal(report.testResults.length, 1);
assert.ok(report.testResults[0].name.endsWith("/extensions/discord/src/voice/realtime-playback.test.ts"));
const assertions = report.testResults.flatMap((test) => test.assertionResults);
const failures = assertions.filter((test) => test.status === "failed");
const name = (shift) => `DiscordVoiceManager keeps the playback watchdog budget after a ${shift} ms wall-clock change`;
if (phase === "red") {
  assert.equal(result.status, 1);
  assert.deepEqual(failures.map((test) => test.fullName).sort(), [name(-60_000), name(60_000)].sort());
  assert.equal(assertions.find((test) => test.fullName === name(0))?.status, "passed");
  assert.equal(assertions.find((test) => test.fullName === "DiscordVoiceManager clears stale realtime playback when stream close and player idle do not fire")?.status, "passed");
  assert.ok(failures.every((test) => /expected|AssertionError/.test(test.failureMessages.join("\n"))));
} else {
  assert.equal(result.status, 0);
  assert.equal(failures.length, 0);
}
assert.ok(assertions.every((test) => test.status === "passed" || failures.includes(test)));
console.log(JSON.stringify({ phase, source: process.env.SOURCE_SHA, failed: failures.map((test) => test.fullName), passed: report.numPassedTests, wallSeconds: (performance.now() - started) / 1000, fileSeconds: (report.testResults[0].endTime - report.testResults[0].startTime) / 1000 }));

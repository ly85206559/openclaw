import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

const file = "ui/src/pages/chat/components/chat-transcript-invalidation.test.ts";
const title = "keeps settled history idle across unchanged rerenders";
const cell = process.env.CLOCK_CELL;
assert(["fixed", "crossed"].includes(cell));
const prefix = path.join(process.env.RUNNER_TEMP, "transcript-minute");
const start = `  it("${title}", async () => {\n`;
const clockSetup = '    let proofClock = 59_999;\n    vi.spyOn(Date, "now").mockImplementation(() => proofClock);\n';
const clockAdvance = "      proofClock = 60_000;\n";

function gitBlob(source) {
  return createHash("sha1").update(`blob ${Buffer.byteLength(source)}\0`).update(source).digest("hex");
}

if (process.argv[2] === "prepare") {
  const source = await readFile(file, "utf8");
  assert.equal(gitBlob(source), "5056efd85433c68786ccfb17554d6a48ed72d62f");
  const offset = source.indexOf(start);
  assert(offset >= 0 && source.indexOf(start, offset + start.length) === -1);
  const end = source.indexOf('\n  it("', offset + start.length);
  assert(end > offset);
  const original = source.slice(offset, end);
  const marker = '      const renderGroup = vi.spyOn(chatMessage, "renderMessageGroup");\n';
  assert.equal(original.split(marker).length, 2);
  let diagnostic = original.replace(start, start + clockSetup);
  if (cell === "crossed") diagnostic = diagnostic.replace(marker, marker + clockAdvance);
  assert.equal(diagnostic.replace(clockSetup, "").replace(clockAdvance, ""), original);
  const assertionLine = source.slice(0, offset).split("\n").length - 1 +
    diagnostic.slice(0, diagnostic.indexOf("expect(renderGroup).not.toHaveBeenCalled();")).split("\n").length;
  const overlay = source.slice(0, offset) + diagnostic + source.slice(end);
  await writeFile(file, overlay);
  await writeFile(`${prefix}-binding.json`, JSON.stringify({ cell, file, title, assertionLine,
    base: "0dc20916873149b6f6803d1eae711c8d44f3de9e", originalBlob: gitBlob(source),
    diagnosticBlob: gitBlob(overlay), assertionsChanged: false, originalTestOrder: true }));
} else {
  assert.equal(process.argv[2], "validate");
  const exitCode = Number(process.argv[3]);
  const binding = JSON.parse(await readFile(`${prefix}-binding.json`, "utf8"));
  const report = JSON.parse(await readFile(`${prefix}.json`, "utf8"));
  const audit = JSON.parse(await readFile(`${prefix}-audit.json`, "utf8"));
  const timeout = await readFile(`${prefix}-audit.json.process-timeout.json`, "utf8").catch((error) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  assert.equal(timeout, undefined);
  assert.equal(report.testResults.length, 1);
  assert.equal(audit.modules.length, 1);
  assert.deepEqual(audit.unhandledErrors, []);
  const module = audit.modules[0];
  const result = report.testResults[0];
  assert(result.name.replaceAll("\\", "/").endsWith(`/${file}`));
  assert.equal(module.name, result.name);
  assert.equal(result.message, "");
  assert.deepEqual(module.errors, []);
  for (const suite of module.suites) assert.deepEqual(suite.errors, []);
  assert(module.tests.length > 1);
  assert.equal(report.numTodoTests, 0);
  assert.equal(report.numPendingTests, 0);
  const failures = module.tests.filter((test) => test.state === "failed");
  const crossed = cell === "crossed";
  assert.equal(exitCode, crossed ? 1 : 0);
  assert.equal(report.success, !crossed);
  assert.equal(report.numFailedTests, crossed ? 1 : 0);
  assert.equal(report.numPassedTests, module.tests.length - failures.length);
  assert.equal(audit.reason, crossed ? "failed" : "passed");
  assert.deepEqual(failures.map((test) => test.title), crossed ? [title] : []);
  for (const test of module.tests) {
    assert(["passed", "failed"].includes(test.state));
    if (test.state !== "failed") assert.deepEqual(test.errors, []);
  }
  if (crossed) {
    assert.equal(failures[0].errors.length, 1);
    const error = failures[0].errors[0];
    assert.equal(error.name, "AssertionError");
    assert.match(error.message, /renderMessageGroup/);
    assert.match(error.message, /actually been called 4 times/);
    assert(error.stack.includes(`${file}:${binding.assertionLine}:`));
  }
  const summary = { ...binding, exitCode, tests: module.tests.map((test) => ({ title: test.title, state: test.state })),
    failed: failures.length, passed: report.numPassedTests, unhandled: 0, diagnosticOnly: true };
  await writeFile(`${prefix}-summary.json`, JSON.stringify(summary));
  console.log(JSON.stringify(summary));
}

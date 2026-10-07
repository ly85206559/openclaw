import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Vitest 5's JSON reporter omits unhandledErrors and reduces assertion errors to stacks.
// This proof-only reporter retains the public result() errors and run-end error channel.
const errors = (items) => Array.from(items ?? [], (error) => ({
  name: error.name,
  message: error.message,
  stack: error.stack,
  actual: error.actual,
  expected: error.expected,
}));

export default class WidgetMessageProofReporter {
  async onProcessTimeout() {
    assert(process.env.WIDGET_MESSAGE_AUDIT_PATH, "Missing proof audit output path");
    await writeFile(`${process.env.WIDGET_MESSAGE_AUDIT_PATH}.process-timeout.json`, "true", "utf8");
  }

  async onTestRunEnd(modules, unhandledErrors, reason) {
    assert(process.env.WIDGET_MESSAGE_AUDIT_PATH, "Missing proof audit output path");
    await writeFile(process.env.WIDGET_MESSAGE_AUDIT_PATH, JSON.stringify({
      reason,
      unhandledErrors: errors(unhandledErrors),
      modules: modules.map((module) => ({
        name: module.moduleId,
        errors: errors(module.errors()),
        suites: Array.from(module.children.allSuites(), (suite) => ({
          name: suite.fullName,
          errors: errors(suite.errors()),
        })),
        tests: Array.from(module.children.allTests(), (test) => ({
          title: test.name,
          fullName: test.fullName,
          state: test.result().state,
          errors: errors(test.result().errors),
        })),
      })),
    }), "utf8");
  }
}

async function validate(phase, jsonPath, auditPath) {
  const plans = {
    wrapper: {
      file: "src/canvas/wrap.test.ts",
      fixture: "wrap.test.ts",
      suite: "buildWidgetDocument",
      passed: 2,
      titles: ["reports bounded runtime errors with surrogate message and source boundaries before widget code, deduplicating and limiting reports"],
      marker: "expect(postMessage.mock.calls).toEqual([",
    },
    component: {
      file: "ui/src/components/canvas-widget-view.test.ts",
      fixture: "canvas-widget-view.test.ts",
      suite: "Canvas widget view",
      passed: 27,
      titles: [
        "shows a bounded script error and wakes only once with a surrogate message boundary",
        "shows a bounded script error and wakes only once with a stored dangling surrogate",
      ],
      marker: "expect(client.request).toHaveBeenLastCalledWith(",
      start: "async ({ label, title, expectedTitle, message: errorMessage, expectedMessage }) => {",
    },
    browser: {
      file: "ui/src/e2e/chat-widget-sandbox.e2e.test.ts",
      fixture: "chat-widget-sandbox.e2e.test.ts",
      suite: "Control UI authenticated widget sandbox",
      passed: 0,
      titles: ["preserves bounded widget error messages in current and stored wrappers"],
      marker: "expect(observation.message, observation.case).toBe(observation.expectedMessage);",
    },
  };
  const plan = plans[phase];
  assert(plan, `Unknown proof phase: ${phase}`);
  const report = JSON.parse(await readFile(jsonPath, "utf8"));
  const audit = JSON.parse(await readFile(auditPath, "utf8"));
  const processTimeout = await readFile(`${auditPath}.process-timeout.json`, "utf8").catch((error) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  assert.equal(processTimeout, undefined, "Worker/process timeout cannot count as expected red");
  assert.equal(report.success, false);
  assert.equal(report.numFailedTests, plan.titles.length);
  assert.equal(report.numPassedTests, plan.passed);
  assert.equal(report.numTodoTests, 0);
  assert.equal(audit.reason, "failed");
  assert.deepEqual(audit.unhandledErrors, []);
  assert.equal(report.testResults.length, 1);
  assert.equal(audit.modules.length, 1);
  const result = report.testResults[0];
  const module = audit.modules[0];
  assert(result.name.replaceAll("\\", "/").endsWith(`/${plan.file}`));
  assert.equal(module.name, result.name);
  assert.equal(result.message, "", "Collection/module errors cannot count as expected red");
  assert.deepEqual(module.errors, []);
  for (const suite of module.suites) {
    assert.deepEqual(suite.errors, [], `Suite/hook failure: ${suite.name}`);
  }
  const failures = result.assertionResults.filter((test) => test.status === "failed");
  assert.deepEqual(failures.map((test) => test.title).toSorted(), plan.titles.toSorted());
  assert.deepEqual(
    module.tests.filter((test) => test.state === "failed").map((test) => test.title).toSorted(),
    plan.titles.toSorted(),
  );
  for (const test of module.tests) {
    assert(["passed", "failed", "skipped"].includes(test.state), "Incomplete test execution");
    if (test.state !== "failed") assert.deepEqual(test.errors, []);
  }
  const fixture = await readFile(path.join(process.env.RUNNER_TEMP, plan.fixture), "utf8");
  const lines = fixture.split(/\r?\n/);
  const start = plan.start ? lines.findIndex((line) => line.includes(plan.start)) : 0;
  assert(start >= 0, "Intended regression fixture section missing");
  const marker = lines.findIndex((line, index) => index >= start && line.includes(plan.marker));
  assert(marker >= start, "Intended owning assertion missing");
  const hasBrokenBoundary = (value) => /\ud83d|\\ud83d/i.test(value);
  for (const failure of failures) {
    assert(failure.ancestorTitles.includes(plan.suite));
    const test = module.tests.find((entry) => entry.title === failure.title);
    assert.equal(test.fullName, `${plan.suite} > ${failure.title}`);
    assert.equal(test.errors.length, 1, "Extra test/hook errors cannot count as expected red");
    const error = test.errors[0];
    assert.equal(error.name, "AssertionError");
    assert.equal(typeof error.actual, "string");
    assert.equal(typeof error.expected, "string");
    assert(error.actual.includes("x".repeat(499)) && hasBrokenBoundary(error.actual));
    assert(error.expected.includes("x".repeat(499)) && !hasBrokenBoundary(error.expected));
    assert.equal(typeof error.stack, "string");
    assert(error.stack.includes(`${plan.file}:${marker + 1}:`), "Failure did not reach the intended comparison");
    assert.equal(failure.failureMessages.length, 1);
    assert.equal(failure.failureMessages[0], error.stack || error.message);
    if (phase === "wrapper") {
      assert(error.message.includes("to deeply equal"));
      assert(error.actual.includes("s".repeat(199)) && error.expected.includes("s".repeat(199)));
      assert(error.actual.includes("openclaw:widget-runtime-error"));
    } else if (phase === "component") {
      assert(/^expected last ".*" call to have been called with/.test(error.message));
      for (const payload of [error.actual, error.expected]) {
        assert(payload.includes("wake") && payload.includes("Inline widget") && payload.includes("Fix the script"));
      }
      if (failure.title.endsWith("stored dangling surrogate")) {
        assert(error.expected.includes("\ufffd") || error.expected.includes("\\ufffd"));
      }
    } else {
      assert(error.message.startsWith("current-boundary:"));
      assert.equal(error.actual, "x".repeat(499) + "\ud83d");
      assert.equal(error.expected, "x".repeat(499));
    }
  }
  console.log(JSON.stringify({ phase, expectedAssertionFailures: failures.map((test) => test.title) }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await validate(...process.argv.slice(2));
}

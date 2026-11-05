#!/usr/bin/env bash
# Review draft: execute only inside the secretless, disposable Actions runner.
set -euo pipefail
test "$(git rev-parse HEAD)" = "$SOURCE_SHA"
test "$(git show -s --format=%P HEAD)" = "$FIRST_PARENT $BASE_SHA"
test "$(git rev-parse HEAD^{tree})" = "$SOURCE_TREE"
test "$(git merge-base "$BASE_SHA" HEAD)" = "$BASE_SHA"
printf '%s\n' scripts/check-control-ui-performance-base.mts test/scripts/control-ui-performance.test.ts > "$RUNNER_TEMP/expected-paths"
git diff --name-only "$BASE_SHA"...HEAD > "$RUNNER_TEMP/actual-paths"
diff -u "$RUNNER_TEMP/expected-paths" "$RUNNER_TEMP/actual-paths"
git diff --exit-code "$BASE_SHA" HEAD -- package.json pnpm-lock.yaml scripts/tsx.mjs scripts/run-vitest.mjs

assert_clean() {
  git diff --quiet
  git diff --cached --quiet
  test -z "$(git ls-files --others --exclude-standard)"
  # Include ignored files in source locations; artifacts and node_modules are elsewhere.
  test -z "$(git ls-files --others -- scripts/ test/scripts/)"
}
assert_clean
pnpm exec oxfmt --check scripts/check-control-ui-performance-base.mts test/scripts/control-ui-performance.test.ts
pnpm exec oxlint scripts/check-control-ui-performance-base.mts test/scripts/control-ui-performance.test.ts

test_file=test/scripts/control-ui-performance.test.ts
printf 'Pinned test Bun: %s (%s)\n' "$(bun --version)" "$(bun --revision)"

git show "$SOURCE_SHA:$test_file" > "$RUNNER_TEMP/candidate-test.ts"
test "$(git hash-object "$RUNNER_TEMP/candidate-test.ts")" = "$(git rev-parse "$SOURCE_SHA:$test_file")"
git checkout --detach "$BASE_SHA"
test "$(git rev-parse HEAD)" = "$BASE_SHA"
assert_clean

# Run the candidate regression on exact frozen main. Check for the specific
# loader failure, not merely any nonzero test process or assertion failure.
cp -- "$RUNNER_TEMP/candidate-test.ts" "$test_file"
test "$(git hash-object "$test_file")" = "$(git rev-parse "$SOURCE_SHA:$test_file")"
set +e
OPENCLAW_VITEST_RUNTIME=node node scripts/run-vitest.mjs "$test_file" --maxWorkers=1 --retry=0 --testNamePattern='distinguishes failure from signal' --reporter=default --reporter=json --outputFile="$RUNNER_TEMP/main-test.json"
baseline_status=$?
set -e
test "$baseline_status" -ne 0
node --input-type=module - "$RUNNER_TEMP/main-test.json" <<'NODE'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const report = JSON.parse(readFileSync(process.argv[2], 'utf8'));
assert.equal(report.success, false);
assert.equal(report.numRuntimeErrorTestSuites ?? 0, 0);
assert.equal(report.numFailedTests, 1);
const failed = report.testResults.flatMap(file => file.assertionResults).filter(test => test.status === 'failed');
assert.equal(failed.length, 1);
assert.match(failed[0].fullName, /distinguishes failure from signal/);
assert.match(failed[0].failureMessages.join('\n'), /ERR_MODULE_NOT_FOUND/);
console.log('Baseline regression: expected loader resolution failure observed.');
NODE
test "$(git hash-object "$test_file")" = "$(git rev-parse "$SOURCE_SHA:$test_file")"
git restore --source="$BASE_SHA" -- "$test_file"
assert_clean
git checkout --detach "$SOURCE_SHA"
test "$(git rev-parse HEAD)" = "$SOURCE_SHA"
assert_clean

# Complete focused suite, including the main Settings/identical-input and
# source-changed rebuild controls. No retries and no skipped/todo tests.
for runtime in node bun; do
  OPENCLAW_VITEST_RUNTIME="$runtime" node scripts/run-vitest.mjs "$test_file" --maxWorkers=1 --retry=0 --reporter=default --reporter=json --outputFile="$RUNNER_TEMP/candidate-$runtime.json"
  node --input-type=module - "$RUNNER_TEMP/candidate-$runtime.json" "$runtime" <<'NODE'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const report = JSON.parse(readFileSync(process.argv[2], 'utf8'));
assert.equal(report.success, true);
assert.equal(report.numTotalTests, 46);
assert.equal(report.numPassedTests, report.numTotalTests);
assert.equal(report.numFailedTests, 0);
assert.equal(report.numPendingTests ?? 0, 0);
assert.equal(report.numTodoTests ?? 0, 0);
assert.equal(report.numRuntimeErrorTestSuites ?? 0, 0);
const tests = report.testResults.flatMap(file => file.assertionResults);
for (const name of [
  'compares archived source revisions',
  'distinguishes failure from signal',
  'reuses identical inputs but rebuilds source-specific Settings changes',
  'refuses symlinked output roots without mutating targets',
]) assert.ok(tests.some(test => test.fullName.includes(name) && test.status === 'passed'), name);
assert.ok(tests.every(test => test.status === 'passed'));
console.log(JSON.stringify({runtime: process.argv[3], total: report.numTotalTests, passed: report.numPassedTests}));
NODE
done

# A separate exact-candidate checkout at a literal %20 path runs the actual
# user entry in both cells. Keeping this harness outside the source checkout
# avoids Vitest/Vite's independently known hash-root limitation.
node ../carrier/.github/proof/pr-176094-cli.mjs
git diff --check "$BASE_SHA"...HEAD
assert_clean
printf 'SOURCE_SHA=%s BASE_SHA=%s carrier=%s\n' "$SOURCE_SHA" "$BASE_SHA" "$GITHUB_SHA"

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const report = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
assert.equal(report.numFailedTests, 1);
assert.equal(report.numPassedTests, 0);
assert(report.testResults.every((suite) => suite.message === ''));
const junit = await fs.readFile(path.join(path.dirname(process.argv[2]), 'regression.junit.xml'), 'utf8');
const rootAttributes = junit.match(/<testsuites\b([^>]*)>/)?.[1];
assert.equal(rootAttributes?.match(/\berrors="(\d+)"/)?.[1], '0');
assert.equal(rootAttributes?.match(/\bfailures="(\d+)"/)?.[1], '1');
assert.equal([...junit.matchAll(/<failure\b/g)].length, 1);
assert.equal([...junit.matchAll(/<error\b/g)].length, 0);
const assertions = report.testResults.flatMap((suite) => suite.assertionResults);
const failed = assertions.filter((test) => test.status === 'failed');
assert.equal(failed.length, 1);
assert.equal(failed[0].fullName, 'diffs tool preserves trailing patch whitespace in the viewer payload');
const message = failed[0].failureMessages.join('\n');
assert.match(message, /AssertionError: expected/);
assert.match(message, /deeply equal/);
assert.match(message, /new/);
const receipt = {
  phase: 'regression-on-original-production',
  originalHead: process.env.ORIGINAL_HEAD,
  candidateHead: process.env.SOURCE_HEAD,
  complete: true,
  productVerdict: 'fail',
  testName: failed[0].fullName,
  failedTests: report.numFailedTests,
  unhandledErrors: 0,
  junitFailures: 1,
  note: 'Other tests deliberately name-filtered; not a green baseline test suite.',
};
await fs.writeFile(path.join(path.dirname(process.argv[2]), 'regression-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify(receipt));

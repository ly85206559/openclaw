// Secretless-runner observation and receipt controller; not a product repair.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const here = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(path.join(here, "overlay.json"), "utf8"));
const [mode, sourceArg, outputArg] = process.argv.slice(2);
assert.ok(["apply", "verify", "collect"].includes(mode), "mode: apply | verify | collect");
assert.ok(sourceArg && outputArg, "source root and owned receipt directory required");
assert.equal(process.env.GITHUB_ACTIONS, "true", "never execute this controller on the local host");
assert.equal(process.env.GITHUB_REPOSITORY, "ly85206559/openclaw");
const sourceRoot = path.resolve(sourceArg);
const out = path.resolve(outputArg);
assert.notEqual(sourceRoot, out);
assert.ok(!out.startsWith(sourceRoot + path.sep), "receipts belong outside the source checkout");
const helper = "src/state/openclaw-state-lease-observer.proof.ts";
const git = (...args) => execFileSync("git", args, { cwd: sourceRoot, encoding: "utf8" }).trim();
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const blob = (bytes) =>
  createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const file = (relative) => {
  const result = path.resolve(sourceRoot, relative);
  assert.ok(result.startsWith(sourceRoot + path.sep));
  return result;
};
const identity = () => {
  assert.equal(git("rev-parse", "HEAD"), config.source);
  assert.equal(git("rev-parse", "HEAD^{tree}"), config.tree);
};
const manifestPath = path.join(out, "overlay-receipt.json");

if (mode === "apply") {
  identity();
  assert.equal(
    git("status", "--porcelain", "--untracked-files=normal"),
    "",
    "source must start clean",
  );
  assert.equal(existsSync(file(helper)), false, "refuse replacing a pre-existing helper");
  for (const [name, expected] of Object.entries(config.blobs)) {
    assert.equal(blob(readFileSync(file(name))), expected, `immutable blob mismatch: ${name}`);
  }
  const groups = gunzipSync(
    Buffer.from(process.env.OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64 ?? "", "base64"),
  );
  assert.equal(groups.length, 4435);
  assert.equal(sha256(groups), config.groupsSha256);
  const decoded = JSON.parse(groups);
  assert.deepEqual(
    decoded.map((group) => group.includePatterns.length),
    [9, 1, 26, 6, 6, 2],
  );
  assert.equal(decoded[2].includePatterns[2], "src/plugins/plugin-lifecycle-lease.test.ts");
  const pending = new Map();
  for (const [name, replacements] of Object.entries(config.edits)) {
    let text = readFileSync(file(name), "utf8");
    for (const { before, after } of replacements) {
      assert.equal(
        text.split(before).length - 1,
        1,
        `anchor mismatch: ${name} ${before.slice(0, 70)}`,
      );
      text = text.replace(before, after);
    }
    pending.set(name, text);
  }
  // Every source/hash/anchor check above completes before the first write.
  mkdirSync(out, { recursive: true });
  for (const [name, text] of pending) writeFileSync(file(name), text);
  copyFileSync(path.join(here, "observer.proof.ts"), file(helper));
  const after = Object.fromEntries(
    [...pending.keys(), helper].map((name) => [name, blob(readFileSync(file(name)))]),
  );
  const unchanged = Object.fromEntries(
    Object.entries(config.blobs).filter(([name]) => !pending.has(name)),
  );
  writeFileSync(path.join(out, "groups.json"), groups);
  writeFileSync(
    path.join(out, "overlay.patch"),
    git("diff", "--binary", "HEAD", "--", ...pending.keys()) + "\n",
  );
  writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        status: "OBSERVATION_NOT_CAUSAL_PROOF",
        source: config.source,
        tree: config.tree,
        workflow: process.env.GITHUB_SHA,
        controllerSha256: sha256(readFileSync(fileURLToPath(import.meta.url))),
        overlayConfigSha256: sha256(readFileSync(path.join(here, "overlay.json"))),
        after,
        unchanged,
        groupsSha256: config.groupsSha256,
      },
      null,
      2,
    ),
  );
}

if (mode === "verify" || mode === "collect") {
  identity();
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  for (const [name, expected] of Object.entries({ ...manifest.after, ...manifest.unchanged })) {
    assert.equal(blob(readFileSync(file(name))), expected, `post-run source drift: ${name}`);
  }
  assert.deepEqual(
    git("diff", "--name-only", "HEAD").split("\n").sort(),
    Object.keys(config.edits).sort(),
  );
  assert.equal(git("diff", "--cached", "--name-only"), "");
  assert.deepEqual(git("ls-files", "--others", "--exclude-standard").split("\n").filter(Boolean), [
    helper,
  ]);
  assert.equal(sha256(readFileSync(path.join(out, "groups.json"))), config.groupsSha256);
}

if (mode === "collect") {
  const log = readFileSync(path.join(out, "original.log"), "utf8");
  const exit = Number(readFileSync(path.join(out, "original.exit"), "utf8").trim());
  assert.ok(
    exit === 0 || exit === 1,
    "process/infrastructure failure is not completed attribution",
  );
  const completions = [...log.matchAll(/\[shard:completion\] (\{[^\n]+\})/g)];
  assert.equal(completions.length, 1, "missing original completion receipt");
  const completion = JSON.parse(completions[0][1]);
  assert.equal(completion.planned, 6);
  assert.equal(completion.completed, 6);
  assert.equal(completion.invocations, 6);
  assert.equal(exit === 0, completion.failedInvocations === 0);
  // Failure summaries may repeat the identical child payload; keep each synthetic role once.
  const observations = [
    ...new Set([...log.matchAll(/LEASE_OBS:(\{[^\r\n]+\})/g)].map((match) => match[1])),
  ].map((value) => JSON.parse(value));
  assert.ok(observations.length > 0, "no child observations: do not call this completed proof");
  for (const observation of observations) {
    assert.equal(observation.version, 1);
    assert.ok(["alpha", "beta"].includes(observation.role));
    assert.ok(observation.events.length <= 256 && observation.firstAborts.length <= 32);
  }
  const roles = observations.map((observation) => observation.role);
  const complete =
    ["alpha", "beta"].every((role) => roles.filter((item) => item === role).length === 1) &&
    observations.every((observation) => observation.dropped === 0);
  const receipt = {
    source: config.source,
    workflow: process.env.GITHUB_SHA,
    exit,
    completion,
    observationComplete: complete,
    observations,
    classification:
      exit === 0 ? "NON_REPRODUCING_NOT_A_REPAIR" : "FAILED_REQUIRES_CAUSAL_INSPECTION",
    limitation:
      "Instrumented original tested merge on a fresh hosted Linux runner, not historical Blacksmith. No root cause or original exact-head CI repair is established by a pass. Missing child/overflow makes observation partial.",
  };
  writeFileSync(path.join(out, "observation-receipt.json"), JSON.stringify(receipt, null, 2));
  console.log(
    JSON.stringify({ exit, observationComplete: complete, classification: receipt.classification }),
  );
}

// Disposable, secretless fork Actions proof. No product code is run locally.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const candidate = process.env.SOURCE_SHA;
const base = process.env.BASE_SHA;
assert.match(candidate ?? "", /^[0-9a-f]{40}$/u);
assert.match(base ?? "", /^[0-9a-f]{40}$/u);
const owner = "scripts/check-control-ui-performance-base.mts";
const installedRoot = fs.realpathSync(process.cwd());
const root = path.join(process.env.GITHUB_WORKSPACE, "source %20 space");
assert.match(root, /source %20 space$/u);
assert.equal(fs.existsSync(root), false, "proof worktree must be fresh");

function run(command, args, cwd = installedRoot) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.signal, null);
  return result;
}
function git(args, cwd = installedRoot) {
  const result = run("git", args, cwd);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
assert.equal(git(["rev-parse", "HEAD"]), candidate);
assert.equal(git(["status", "--porcelain", "--untracked-files=no"]), "");
git(["worktree", "add", "--detach", root, candidate]);
assert.equal(git(["rev-parse", "HEAD"], root), candidate);
assert.equal(git(["status", "--porcelain", "--untracked-files=no"], root), "");

// Share every existing workspace node_modules from this same exact candidate,
// as the previously successful proof did. Do not install in the second tree.
const workspaceRoots = ["", "ui"];
for (const parent of ["packages", "extensions"]) {
  for (const entry of fs.readdirSync(path.join(installedRoot, parent), { withFileTypes: true })) {
    if (entry.isDirectory()) workspaceRoots.push(path.join(parent, entry.name));
  }
}
const linkedDependencies = [];
for (const workspace of workspaceRoots) {
  const relative = path.join(workspace, "node_modules");
  const installed = path.join(installedRoot, relative);
  if (fs.existsSync(installed)) {
    const destination = path.join(root, relative);
    assert.equal(fs.existsSync(destination), false, `unexpected existing ${relative}`);
    fs.symlinkSync(installed, destination, "dir");
    assert.equal(fs.realpathSync(destination), fs.realpathSync(installed));
    linkedDependencies.push(relative);
  }
}
for (const required of ["node_modules", path.join("ui", "node_modules")]) {
  assert.ok(
    linkedDependencies.includes(required),
    `missing same-head dependency tree: ${required}`,
  );
}

const ownerPath = path.join(root, owner);
const pristine = fs.readFileSync(ownerPath);
const mainResult = spawnSync("git", ["show", `${base}:${owner}`], { cwd: root });
assert.equal(mainResult.error, undefined);
assert.equal(mainResult.status, 0, mainResult.stderr.toString());
const baseOwner = mainResult.stdout;
assert.equal(
  git(["hash-object", "--no-filters", owner], root),
  git(["rev-parse", `${candidate}:${owner}`], root),
);
const normalizedCandidate = pristine
  .toString("utf8")
  .replace(
    'import { fileURLToPath, pathToFileURL } from "node:url";',
    'import { fileURLToPath } from "node:url";',
  )
  .replace(
    'pathToFileURL(path.join(repoRoot, "scripts/tsx.mjs")).href',
    'path.join(repoRoot, "scripts/tsx.mjs")',
  );
assert.equal(
  normalizedCandidate,
  baseOwner.toString("utf8"),
  "control must differ only at the preload path boundary",
);

const receipt = {
  candidate,
  base,
  sourceTree: git(["rev-parse", "HEAD^{tree}"], root),
  node: process.version,
  sourceRoot: root,
  candidateOwnerHash: sha256(pristine),
  baseOwnerHash: sha256(baseOwner),
  dependencyCheckoutHead: git(["rev-parse", "HEAD"]),
  linkedDependencies,
  outcomes: [],
};
try {
  for (const [name, source] of [
    ["frozen-main-owner", baseOwner],
    ["candidate-owner", pristine],
  ]) {
    fs.writeFileSync(ownerPath, source);
    assert.equal(sha256(fs.readFileSync(ownerPath)), sha256(source));
    const changed = git(["diff", "--name-only"], root).split("\n").filter(Boolean);
    assert.deepEqual(changed, name === "frozen-main-owner" ? [owner] : []);
    const start = performance.now();
    const result = run("pnpm", ["ui:check-performance:base", base], root);
    const output = `${result.stdout}${result.stderr}`;
    fs.writeFileSync(path.join(process.env.RUNNER_TEMP, `pr176094-${name}.log`), output);
    console.log(
      `=== ${name}: exit=${result.status} wallMs=${Math.round(performance.now() - start)} ===`,
    );
    console.log(output);
    assert.match(output, /Control UI comparison: working-tree head/u);
    assert.match(output, /identical build inputs; reusing candidate as base\./u);
    if (name === "frozen-main-owner") {
      assert.notEqual(result.status, 0);
      assert.match(output, /ERR_MODULE_NOT_FOUND/u);
      assert.match(output, /tsx\.mjs/u);
    } else {
      assert.equal(result.status, 0, "candidate must pass the real user command and budgets");
      assert.match(output, /startup JS gzip vs base: \d+ B -> \d+ B \(\+0 B\)/u);
    }
    receipt.outcomes.push({
      name,
      exit: result.status,
      wallMs: Math.round(performance.now() - start),
      outputSha256: sha256(output),
    });
  }
} finally {
  fs.writeFileSync(ownerPath, pristine);
  receipt.ownerRestored = sha256(fs.readFileSync(ownerPath)) === receipt.candidateOwnerHash;
  fs.writeFileSync(
    path.join(process.env.RUNNER_TEMP, "pr176094-cli-receipt.json"),
    JSON.stringify(receipt, null, 2),
  );
  console.log(JSON.stringify(receipt, null, 2));
}
assert.equal(receipt.ownerRestored, true);
assert.equal(git(["status", "--porcelain", "--untracked-files=no"], root), "");

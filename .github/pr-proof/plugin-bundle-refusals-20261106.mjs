import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const source = path.resolve(process.argv[2]);
const output = path.resolve(process.argv[3]);
const fixed = process.argv[4] === "fixed";
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-refusals-"));
const project = path.join(fixture, "plugin");
fs.mkdirSync(output, { recursive: true });
fs.mkdirSync(path.join(fixture, "home"));
const env = {
  ...process.env,
  HOME: path.join(fixture, "home"),
  USERPROFILE: path.join(fixture, "home"),
  OPENCLAW_HOME: path.join(fixture, "home"),
  OPENCLAW_STATE_DIR: path.join(fixture, "state"),
  OPENCLAW_CONFIG_PATH: path.join(fixture, "state", "openclaw.json"),
};
const commands = [];
function cli(args, name) {
  const result = spawnSync("pnpm", ["openclaw", ...args], {
    cwd: source, env, encoding: "utf8", timeout: 180_000,
  });
  assert.ifError(result.error);
  const receipt = { args, status: result.status, stdout: result.stdout, stderr: result.stderr };
  commands.push(receipt);
  fs.writeFileSync(path.join(output, name + ".json"), JSON.stringify(receipt, null, 2));
  return receipt;
}
function inventory(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) return [[file, "symlink:" + fs.readlinkSync(file)]];
    return entry.isDirectory() ? inventory(file) : [[file, createHash("sha256").update(fs.readFileSync(file)).digest("hex")]];
  });
}
function ownerProbe(kind, id) {
  const file = kind === "pack" ? "plugins-feature-artifact.ts" : "plugins-authoring-command.ts";
  const method = kind === "pack" ? "runPluginsPackCommand" : "runPluginsBuildCommand";
  const params = { root: project, ...(kind === "pack" ? { out: path.join(fixture, id + "-probe.tgz") } : {}) };
  const code = "import { " + method + " as run } from " + JSON.stringify(pathToFileURL(path.join(source, "src/cli", file)).href) + ";\n" +
    "try { await run(" + JSON.stringify(params) + "); process.exitCode = 2; }\n" +
    "catch(error) { console.log(JSON.stringify({name:error.name,message:error.message,humanOutput:error.humanOutput??null,causeIds:error.cause?.errors?.map(value=>value.id)})); }";
  const result = spawnSync(process.execPath, [
    "--import", pathToFileURL(path.join(source, "scripts/tsx.mjs")).href,
    "--input-type=module", "--eval", code,
  ], { cwd: source, env, encoding: "utf8", timeout: 180_000 });
  fs.writeFileSync(path.join(output, id + "-owner.json"), JSON.stringify({
    status: result.status, stdout: result.stdout, stderr: result.stderr, error: result.error?.message,
  }, null, 2));
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim().split("\n").at(-1));
}
const version = cli(["--version"], "version");
assert.equal(version.status, 0, version.stderr);
const init = cli(["plugins", "init", "bundle-diagnostic", "--type", "feature", "--directory", project], "init");
assert.equal(init.status, 0, init.stderr);
const dependencies = path.join(project, "node_modules");
fs.symlinkSync(path.join(source, "node_modules"), dependencies, "dir");
const { build: compile, version: esbuildVersion } = createRequire(path.join(source, "package.json"))("esbuild");
await compile({
  absWorkingDir: project, entryPoints: ["src/index.ts"], outfile: "dist/index.js",
  bundle: true, platform: "node", format: "esm", external: ["openclaw/*"], logLevel: "silent",
});
const metadata = cli(["plugins", "build", "--root", project], "metadata-build");
assert.equal(metadata.status, 0, metadata.stderr);
const entry = path.join(project, "dist/index.js");
const original = fs.readFileSync(entry, "utf8");
const before = inventory(project);
const archive = path.join(fixture, "valid.tgz");
const packed = cli(["plugins", "pack", "--root", project, "--out", archive, "--json"], "valid-control");
assert.equal(packed.status, 0, packed.stderr);
const bytes = fs.readFileSync(archive);
assert.ok(bytes.length > 0);
const archiveSha256 = createHash("sha256").update(bytes).digest("hex");
assert.deepEqual(inventory(project), before);
const existing = cli(["plugins", "pack", "--root", project, "--out", archive], "overwrite-control");
assert.equal(existing.status, 1, existing.stderr);
assert.deepEqual(fs.readFileSync(archive), bytes);
const invalid = cli(["plugins", "pack", "--root", project, "--out", path.join(fixture, "invalid.zip")], "suffix-control");
assert.equal(invalid.status, 1, invalid.stderr);
assert.match(invalid.stderr, /must end in \.tgz or \.tar\.gz/);
assert.deepEqual(inventory(project), before);

const runtime = path.join(project, "dist/runtime");
fs.mkdirSync(runtime);
fs.writeFileSync(path.join(runtime, "helper.cjs"), "exports.value = 'dependency';");
const cases = [
  { id: "computed-import", entry: "\nexport const extra = specifier => import(specifier);", expected: "will not be bundled" },
  { id: "dynamic-require", loader: "exports.extra = name => require(name);", expected: "will not be bundled" },
  { id: "indirect-require", loader: "const load = require; exports.extra = () => load('./helper.cjs');", expected: "will not be bundled" },
  { id: "require-resolve", loader: "exports.extra = () => require.resolve('./helper.cjs');", expected: "module-relative runtime files" },
  { id: "module-location", entry: "\nexport const extra = () => new URL('./template.txt', import.meta.url);", expected: "module-relative runtime files" },
];
const refusals = [];
function checkRefusal(id, args, expected, kind) {
  const prior = inventory(project);
  const receipt = cli(args, id);
  assert.equal(receipt.status, 1, receipt.stderr);
  const failure = ownerProbe(kind, id);
  assert.ok(failure.message.includes(expected), JSON.stringify(failure));
  const visible = receipt.stderr.includes(expected);
  if (fixed) {
    assert.equal(visible, true, receipt.stderr);
    assert.doesNotMatch(receipt.stderr, /The CLI command failed\./);
    assert.ok(failure.humanOutput?.includes(expected), JSON.stringify(failure));
  } else if (!visible) {
    assert.match(receipt.stderr, /The CLI command failed\./);
    assert.equal(failure.humanOutput, null);
  }
  assert.deepEqual(inventory(project), prior);
  assert.equal(fs.existsSync(path.join(fixture, id + ".tgz")), false);
  assert.equal(fs.existsSync(path.join(fixture, id + "-probe.tgz")), false);
  refusals.push({ id, expected, visible, failure });
}
for (const test of cases) {
  if (test.loader) fs.writeFileSync(path.join(runtime, "loader.cjs"), test.loader);
  fs.writeFileSync(entry, original + (test.entry ?? "\nimport extraModule from './runtime/loader.cjs'; export const extra = extraModule.extra;"));
  checkRefusal(test.id, ["plugins", "pack", "--root", project, "--out", path.join(fixture, test.id + ".tgz")], test.expected, "pack");
}
fs.writeFileSync(entry, original);
const manifest = JSON.parse(fs.readFileSync(path.join(project, "package.json"), "utf8"));
const browserEntry = path.resolve(project, manifest.openclaw.controlUi);
const browserOriginal = fs.readFileSync(browserEntry, "utf8");
fs.writeFileSync(browserEntry, "export const load = () => import('https://example.invalid/remote.js');");
checkRefusal("browser-external", ["plugins", "build", "--root", project], "must bundle their browser dependencies", "build");
fs.writeFileSync(browserEntry, "export const broken = ;");
const invalidBefore = inventory(project);
const unexpected = cli(["plugins", "build", "--root", project], "unexpected-compile-control");
assert.equal(unexpected.status, 1, unexpected.stderr);
assert.match(unexpected.stderr, /The CLI command failed\./);
assert.deepEqual(inventory(project), invalidBefore);
fs.writeFileSync(browserEntry, browserOriginal);
fs.rmSync(runtime, { recursive: true });
assert.deepEqual(inventory(project), before);
if (!fixed) assert.ok(refusals.some(value => !value.visible), "No hidden refusal reproduced");
fs.writeFileSync(path.join(output, "summary.json"), JSON.stringify({
  fixture, node: process.version, esbuildVersion, fixed, archiveSha256, archiveBytes: bytes.length,
  projectUnchanged: true, refusals, commands,
}, null, 2));
console.log(JSON.stringify({ fixed, hidden: refusals.filter(value => !value.visible).map(value => value.id), archiveSha256 }));

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const source = path.resolve(process.argv[2]);
const output = path.resolve(process.argv[3]);
fs.mkdirSync(output, { recursive: true });
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-bundle-cli-proof-"));
const project = path.join(fixture, "plugin");
const env = {
  ...process.env,
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
  fs.writeFileSync(path.join(output, `${name}.json`), JSON.stringify(receipt, null, 2));
  return receipt;
}
function snapshot(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? snapshot(file) : [[file, createHash("sha256").update(fs.readFileSync(file)).digest("hex")]];
  });
}
const init = cli(["plugins", "init", "bundle-diagnostic", "--type", "feature", "--directory", project], "init");
assert.equal(init.status, 0, init.stderr);
// Match the native artifact fixture: compile the scaffold using the already
// locked toolchain, then retain its prebuilt browser assets without author tools.
fs.symlinkSync(path.join(source, "node_modules"), path.join(project, "node_modules"), "dir");
const { build: compile } = createRequire(path.join(source, "package.json"))("esbuild");
await compile({ absWorkingDir: project, entryPoints: ["src/index.ts"], outfile: "dist/index.js", bundle: true, platform: "node", format: "esm", external: ["openclaw/*"], logLevel: "silent" });
const build = cli(["plugins", "build", "--root", project], "metadata-build");
assert.equal(build.status, 0, build.stderr);
const packagePath = path.join(project, "package.json");
const manifest = JSON.parse(fs.readFileSync(packagePath, "utf8"));
delete manifest.openclaw.controlUi;
fs.writeFileSync(packagePath, JSON.stringify(manifest, null, 2) + "\n");
assert.equal(fs.lstatSync(path.join(project, "node_modules")).isSymbolicLink(), true);
fs.unlinkSync(path.join(project, "node_modules"));
const before = snapshot(project);
const invalid = cli(["plugins", "pack", "--root", project, "--out", path.join(fixture, "out.zip")], "invalid-suffix-control");
assert.equal(invalid.status, 1, invalid.stderr);
assert.match(invalid.stderr, /must end in \.tgz or \.tar\.gz/);
const refused = cli(["plugins", "pack", "--root", project, "--out", path.join(fixture, "out.tgz")], "missing-compiler");
assert.equal(refused.status, 1, refused.stderr);
assert.match(refused.stderr, /The CLI command failed\./);
assert.doesNotMatch(refused.stderr, /Install esbuild in this plugin/);
assert.deepEqual(snapshot(project), before);
assert.equal(fs.existsSync(path.join(fixture, "out.tgz")), false);

const owner = pathToFileURL(path.join(source, "src/cli/plugins-feature-artifact.ts")).href;
const probe = `import { runPluginsPackCommand } from ${JSON.stringify(owner)};
try { await runPluginsPackCommand(${JSON.stringify({ root: project, out: path.join(fixture, "owner.tgz") })}); process.exitCode=2; }
catch(error) { console.log(JSON.stringify({name:error.name,message:error.message,humanOutput:error.humanOutput??null})); }`;
const result = spawnSync(process.execPath, ["--import", pathToFileURL(path.join(source, "scripts/tsx.mjs")).href, "--input-type=module", "--eval", probe], {
  cwd: source, env, encoding: "utf8", timeout: 180_000,
});
fs.writeFileSync(path.join(output, "owner-probe.json"), JSON.stringify({ status: result.status, stdout: result.stdout, stderr: result.stderr, error: result.error?.message }, null, 2));
assert.ifError(result.error);
assert.equal(result.status, 0, result.stderr);
const failure = JSON.parse(result.stdout.trim());
assert.match(failure.message, /Install esbuild in this plugin's devDependencies/);
assert.equal(failure.humanOutput, null);
fs.writeFileSync(path.join(output, "summary.json"), JSON.stringify({ fixture, node: process.version, failure, projectUnchanged: true, commands }, null, 2));
console.log("BASELINE REPRODUCED: known missing-compiler reason hidden; suffix control visible; no project/output mutation.");

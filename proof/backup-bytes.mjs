import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const phase = process.env.PHASE;
assert.ok(phase === "baseline" || phase === "fixed");
const root = fs.mkdtempSync(path.join(os.tmpdir(), `backup-bytes-${phase}-`));
const env = {
  ...process.env,
  OPENCLAW_STATE_DIR: path.join(root, "state"),
  OPENCLAW_CONFIG_PATH: path.join(root, "state", "openclaw.json"),
  OPENCLAW_HOME: root,
  NO_COLOR: "1",
};
const cases = [
  ["0x10", 16, false],
  ["0b101", 5, false],
  ["0o17", 15, false],
  ["1e3", 1000, false],
  ["42", 42, true],
  ["0", 0, true],
  ["+5", 5, true],
  ["010", 10, true],
  [undefined, undefined, true],
];
const evidence = [];
for (const [token, expected, valid] of cases) {
  const args = ["--silent", "openclaw", "backup", "record", "--status", "ok", "--target", "synthetic-proof", "--json"];
  if (token !== undefined) args.push("--bytes", token);
  const result = spawnSync("pnpm", args, { env, encoding: "utf8", timeout: 240_000, maxBuffer: 8 * 1024 * 1024 });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  const success = valid || phase === "baseline";
  if (success) {
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout.trim());
    assert.equal(output.bytes, expected);
    assert.equal(output.target, "synthetic-proof");
  } else {
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /--bytes must be a nonnegative integer\./);
  }
  evidence.push({ token: token ?? "<omitted>", status: result.status, stdout: result.stdout, stderr: result.stderr });
  console.log(JSON.stringify({ phase, token: token ?? "<omitted>", status: result.status }));
}
fs.writeFileSync(path.join(process.env.RUNNER_TEMP, "backup-proof", "cli.json"), JSON.stringify({ phase, cases: evidence }, null, 2));
// CLI output establishes parsing, not persistence. The separate owner regression
// bootstraps a real SQLite fixture and verifies records through its reader.

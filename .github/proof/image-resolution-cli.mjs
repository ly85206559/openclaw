import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const mode = process.env.PROOF_MODE;
assert.ok(mode === "baseline" || mode === "candidate");
const root = path.join(process.env.RUNNER_TEMP, "image-resolution");
const state = path.join(root, "state");
fs.mkdirSync(state, { recursive: true });
const config = path.join(root, "config.json");
fs.writeFileSync(config, JSON.stringify({ gateway: { mode: "local" }, plugins: { enabled: false } }));
const input = path.join(root, "input.png");
fs.writeFileSync(input, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yf7kAAAAASUVORK5CYII=", "base64"));
const resolutions = [undefined, "1K", " 2k ", "4K", "1080p", "8K"];
const receipts = [];
for (const action of ["generate", "edit"]) {
  for (const [index, resolution] of resolutions.entries()) {
    const invalid = resolution === "1080p" || resolution === "8K";
    const args = ["openclaw", "infer", "image", action, "--prompt", "proof circle", "--model", "invalid-ref", "--json"];
    if (action === "edit") args.push("--file", input);
    if (resolution !== undefined) args.push("--resolution", resolution);
    const started = Date.now();
    const result = spawnSync("pnpm", args, {
      encoding: "utf8",
      timeout: 180_000,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, CI: "true", OPENCLAW_STATE_DIR: state, OPENCLAW_CONFIG_PATH: config },
    });
    const name = `${action}-${index}`;
    fs.writeFileSync(path.join(root, `${name}.stdout.txt`), result.stdout ?? "");
    fs.writeFileSync(path.join(root, `${name}.stderr.txt`), result.stderr ?? "");
    const expected = mode === "candidate" && invalid
      ? "--resolution must be one of 1K, 2K, or 4K"
      : "Model overrides must use the form <provider/model>.";
    const receipt = { action, resolution: resolution ?? "omitted", args, exit: result.status, signal: result.signal, elapsedMs: Date.now() - started, expected, spawnError: result.error?.message };
    receipts.push(receipt);
    fs.writeFileSync(path.join(root, "cli-receipts.json"), JSON.stringify(receipts, null, 2));
    assert.equal(result.error, undefined, `${name}: CLI failed to launch`);
    assert.equal(result.signal, null, `${name}: CLI was terminated`);
    assert.equal(result.status, 1, `${name}: unexpected CLI exit`);
    const envelope = JSON.parse(result.stdout);
    assert.deepEqual(envelope, { ok: false, error: { type: "cli_error", message: expected } }, `${name}: wrong CLI JSON validation result`);
  }
}
assert.equal(receipts.length, 12);
console.log(`${mode.toUpperCase()}_REAL_CLI`, JSON.stringify({ cases:12, invalidResolutionCases:4, nextGuardControls:8 }));

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const source = path.resolve(process.argv[2]);
const artifacts = path.resolve(process.argv[3]);
const expectedHead = "53f8d4f7f577aff93ca625c210185145a90ad81a";
const receipt = { phase: "feature-absent-baseline", head: expectedHead, complete: false, cleanup: false, exitCode: null, signal: null };
await fs.mkdir(artifacts, { recursive: true });
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-channel-follow-proof-"));
const configPath = path.join(scratch, "openclaw.json");
const logPath = path.join(scratch, "fixture.log");
const configBytes = JSON.stringify({ gateway: { mode: "local" }, logging: { file: logPath } }) + "\n";
const output = [[], []];
const failures = [];
let outputBytes = 0;
let overflow = false;
let managedCompleted = false;
const abort = new AbortController();
const git = (...args) => execFileSync("git", args, { cwd: source, encoding: "utf8", timeout: 10000 });
try {
  assert.equal(git("rev-parse", "HEAD").trim(), expectedHead);
  await fs.writeFile(configPath, configBytes);
  await fs.writeFile(logPath, JSON.stringify({ time: "2026-10-23T00:00:00.000Z", 0: "fixture message", _meta: { logLevelName: "INFO", name: JSON.stringify({ module: "gateway/channels/slack/send" }) } }) + "\n");
  const env = { ...process.env, HOME: scratch, USERPROFILE: scratch, XDG_CONFIG_HOME: path.join(scratch, "config"), XDG_STATE_HOME: path.join(scratch, "state"), OPENCLAW_STATE_DIR: path.join(scratch, "state"), OPENCLAW_CONFIG_PATH: configPath, NO_COLOR: "1" };
  delete env.OPENCLAW_PROFILE;
  const { runManagedCommand } = await import(pathToFileURL(path.join(source, "scripts/lib/managed-child-process.mts")).href);
  const status = await runManagedCommand({
    bin: "pnpm",
    args: ["--silent", "openclaw", "channels", "logs", "--channel", "slack", "--follow", "--interval", "50", "--json"],
    cwd: source,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    timeoutMs: 180000,
    requireProcessTreeExit: true,
    waitForCleanupRelease: true,
    signal: abort.signal,
    onReady(child) {
      receipt.pid = child.pid ?? null;
      child.once("exit", (code, signal) => {
        receipt.exitCode = code;
        receipt.signal = signal;
      });
      child.once("error", (error) => { receipt.spawnError = String(error); });
      for (const [index, stream] of [child.stdout, child.stderr].entries()) {
        stream.on("data", (chunk) => {
          outputBytes += chunk.length;
          if (outputBytes <= 4 * 1024 * 1024) output[index].push(Buffer.from(chunk));
          else {
            overflow = true;
            abort.abort(new Error("CLI output exceeded proof capture budget"));
          }
        });
      }
    },
  });
  managedCompleted = true;
  receipt.managedStatus = status;
  assert.equal(overflow, false, "CLI output capture must be complete");
  assert.equal(status, 1);
  assert.equal(receipt.exitCode, 1);
  assert.equal(receipt.signal, null);
  assert.match(Buffer.concat(output[1]).toString("utf8"), /unknown option '--follow'/);
  receipt.expectedRejection = "unknown option '--follow'";
  receipt.productVerdict = "feature-absent";
} catch (error) {
  failures.push(error);
} finally {
  // Preserve the observed inputs and check integrity even when launch/assertions fail.
  for (const [name, file] of [["config.json", configPath], ["fixture.log", logPath]]) {
    try { await fs.copyFile(file, path.join(artifacts, name)); }
    catch (error) { failures.push(error); }
  }
  try {
    receipt.configUnchanged = await fs.readFile(configPath, "utf8") === configBytes;
    assert.equal(receipt.configUnchanged, true);
  } catch (error) { failures.push(error); }
  try {
    receipt.sourceClean = git("status", "--porcelain", "--untracked-files=no") === "";
    assert.equal(receipt.sourceClean, true);
  } catch (error) { failures.push(error); }
  // Failed or interrupted owners retain their inputs; the controller never infers
  // detached-descendant extinction merely from pnpm's PID/group disappearing.
  if (failures.length === 0 && managedCompleted && !overflow) {
    try {
      assert.equal(path.dirname(scratch), os.tmpdir());
      assert.ok(path.basename(scratch).startsWith("openclaw-channel-follow-proof-"));
      await fs.rm(scratch, { recursive: true });
      receipt.cleanup = true;
    } catch (error) { failures.push(error); }
  } else receipt.retainedScratch = scratch;
  receipt.outputOverflow = overflow;
  receipt.complete = failures.length === 0 && receipt.cleanup;
  receipt.errors = failures.map(String);
  await fs.writeFile(path.join(artifacts, "cli.stdout.txt"), Buffer.concat(output[0]));
  await fs.writeFile(path.join(artifacts, "cli.stderr.txt"), Buffer.concat(output[1]));
  await fs.writeFile(path.join(artifacts, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
}
if (failures.length) throw new AggregateError(failures, "Channel follow baseline proof incomplete");

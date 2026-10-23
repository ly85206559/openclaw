import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const source = path.resolve(process.argv[2]);
const artifacts = path.resolve(process.argv[3]);
const expectedHead = process.argv[4];
const receipt = { head: expectedHead, complete: false, cleanup: false, commands: [], fixtures: [] };
const failures = [];
await fs.mkdir(artifacts, { recursive: true });
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-channel-follow-proof-"));
const configPath = path.join(scratch, "openclaw.json");
const logPath = path.join(scratch, "fixture.log");
const fixtureSecret = "follow-proof-secret-1234567890";
const configBytes = JSON.stringify({ gateway: { mode: "local" }, logging: { file: logPath, redactPatterns: [fixtureSecret] } }) + "\n";
const env = { ...process.env, HOME: scratch, USERPROFILE: scratch, XDG_CONFIG_HOME: path.join(scratch, "config"), XDG_STATE_HOME: path.join(scratch, "state"), OPENCLAW_STATE_DIR: path.join(scratch, "state"), OPENCLAW_CONFIG_PATH: configPath, NO_COLOR: "1" };
delete env.OPENCLAW_PROFILE;
const git = (...args) => execFileSync("git", args, { cwd: source, encoding: "utf8", timeout: 10000 });
const logLine = (message, module = "gateway/channels/slack/send") => JSON.stringify({ time: "2026-10-23T00:00:00.000Z", 0: message, _meta: { logLevelName: "INFO", name: JSON.stringify({ module }) } }) + "\n";
let runManagedCommand;

async function writeFixture(contents, append = false) {
  const name = `fixture-${receipt.fixtures.length + 1}`;
  await fs.writeFile(path.join(artifacts, `${name}.input.txt`), contents);
  receipt.fixtures.push({ name, operation: append ? "append" : "replace" });
  await (append ? fs.appendFile(logPath, contents) : fs.writeFile(logPath, contents));
  await fs.copyFile(logPath, path.join(artifacts, `${name}.snapshot.log`));
}

async function cli(name, args, interact) {
  const record = { name, args, complete: false, exitCode: null, signal: null };
  receipt.commands.push(record);
  const buffers = [[], []];
  const changes = new EventEmitter();
  const abort = new AbortController();
  let bytes = 0;
  let overflow = false;
  let pid;
  let outcome;
  const stdout = () => Buffer.concat(buffers[0]).toString("utf8");
  const waitFor = (predicate) => new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) {
        changes.off("change", check);
        resolve();
      } else if (outcome) {
        changes.off("change", check);
        reject(new Error(`${name}: CLI exited before expected output`));
      }
    };
    changes.on("change", check);
    check();
  });
  const managed = runManagedCommand({
    bin: "pnpm", args: ["--silent", "openclaw", "channels", "logs", ...args],
    cwd: source, env, stdio: ["ignore", "pipe", "pipe"], timeoutMs: 120000,
    requireProcessTreeExit: true, waitForCleanupRelease: true, signal: abort.signal,
    onReady(child) {
      record.pid = pid = child.pid;
      child.once("exit", (code, signal) => { record.exitCode = code; record.signal = signal; });
      child.once("error", (error) => { record.spawnError = String(error); });
      for (const [index, stream] of [child.stdout, child.stderr].entries()) {
        stream.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes <= 4 * 1024 * 1024) buffers[index].push(Buffer.from(chunk));
          else { overflow = true; abort.abort(new Error("CLI output exceeded proof budget")); }
          changes.emit("change");
        });
      }
      changes.emit("change");
    },
  }).then((status) => ({ status }), (error) => ({ error })).then((result) => {
    outcome = result;
    changes.emit("change");
    return result;
  });
  try {
    if (interact) await interact({ stdout, waitFor, interrupt: () => {
      assert.ok(pid, "real managed CLI must have started");
      process.kill(-pid, "SIGINT");
      record.sentSignal = "SIGINT";
    } });
    const result = await managed;
    if (result.error) throw result.error;
    record.managedStatus = result.status;
    assert.equal(overflow, false);
    assert.equal(result.status, interact ? 130 : 0);
    assert.ok(interact
      ? (record.exitCode === 130 && record.signal === null) || (record.exitCode === null && record.signal === "SIGINT")
      : record.exitCode === 0 && record.signal === null,
    "actual exit must match the conventional CLI status");
    assert.equal(Buffer.concat(buffers[1]).toString("utf8"), "", "actual CLI stderr must be empty");
    record.complete = true;
    return stdout();
  } finally {
    if (!outcome) abort.abort(new Error(`${name}: proof controller stopping incomplete command`));
    const result = await managed;
    if (result.error) record.managedError = String(result.error);
    record.outputOverflow = overflow;
    await fs.writeFile(path.join(artifacts, `${name}.stdout.txt`), Buffer.concat(buffers[0]));
    await fs.writeFile(path.join(artifacts, `${name}.stderr.txt`), Buffer.concat(buffers[1]));
  }
}

try {
  assert.equal(git("rev-parse", "HEAD").trim(), expectedHead);
  ({ runManagedCommand } = await import(pathToFileURL(path.join(source, "scripts/lib/managed-child-process.mts")).href));
  await fs.writeFile(configPath, configBytes);
  await writeFixture(logLine("old") + logLine("initial") + logLine("shadow", "gateway/channels/discord"));
  const snapshot = JSON.parse(await cli("snapshot-json", ["--channel", "slack", "--lines", "1", "--json"]));
  assert.deepEqual(Object.keys(snapshot).sort(), ["channel", "file", "lines", "truncated"]);
  assert.deepEqual(snapshot.lines.map((line) => line.message), ["initial"]);
  assert.equal(snapshot.channel, "slack");
  const text = await cli("snapshot-text", ["--channel", "slack", "--lines", "1"]);
  assert.ok(text.includes("info initial"));
  assert.ok(!text.includes("info old") && !text.includes("shadow"));

  const jsonOutput = await cli("follow-json", ["--channel", "slack", "--lines", "1", "--follow", "--interval", "50", "--json"], async ({ stdout, waitFor, interrupt }) => {
    await waitFor(() => stdout().includes('"message":"initial"'));
    await writeFixture(logLine("wrong channel", "gateway/channels/discord") + logLine(`appended é ${fixtureSecret}`) + logLine("partial").trimEnd(), true);
    await waitFor(() => stdout().includes('"message":"appended é '));
    // Real-command timing proof: leave the record incomplete across several
    // 50ms polls; deterministic owner tests separately control the polling clock.
    await delay(150);
    assert.ok(!stdout().includes('"message":"partial"'));
    await writeFixture("\n" + logLine("batch one") + logLine("batch two"), true);
    await waitFor(() => stdout().includes('"message":"batch two"'));
    await writeFixture(logLine("rotated"));
    await waitFor(() => stdout().includes('"message":"rotated"'));
    interrupt();
  });
  const records = jsonOutput.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(records.filter((line) => line.type === "meta"), [{ type: "meta", file: logPath, channel: "slack" }]);
  const messages = records.filter((line) => line.type === "log").map((line) => line.message);
  assert.deepEqual(messages.slice(0, 1), ["initial"]);
  assert.ok(messages[1].startsWith("appended é ") && !messages[1].includes(fixtureSecret));
  assert.deepEqual(messages.slice(2), ["partial", "batch one", "batch two", "rotated"]);
  assert.ok(records.some((line) => line.type === "notice" && line.message.includes("cursor reset")));
  assert.ok(!jsonOutput.includes(fixtureSecret) && !jsonOutput.includes("wrong channel"));

  await writeFixture(logLine("text initial"));
  const followedText = await cli("follow-text", ["--channel", "slack", "--follow", "--interval", "50"], async ({ stdout, waitFor, interrupt }) => {
    await waitFor(() => stdout().includes("info text initial"));
    await writeFixture(logLine("text wrong", "gateway/channels/discord") + logLine("text appended"), true);
    await waitFor(() => stdout().includes("info text appended"));
    interrupt();
  });
  assert.equal(followedText.split("info text initial").length - 1, 1);
  assert.equal(followedText.split("info text appended").length - 1, 1);
  assert.ok(followedText.includes("Channel: slack") && !followedText.includes("text wrong"));
} catch (error) {
  failures.push(error);
} finally {
  for (const [name, file] of [["config.json", configPath], ["fixture.log", logPath]]) {
    try { await fs.copyFile(file, path.join(artifacts, name)); } catch (error) { failures.push(error); }
  }
  try { receipt.configUnchanged = await fs.readFile(configPath, "utf8") === configBytes; assert.equal(receipt.configUnchanged, true); } catch (error) { failures.push(error); }
  try { receipt.sourceClean = git("status", "--porcelain", "--untracked-files=no") === ""; assert.equal(receipt.sourceClean, true); } catch (error) { failures.push(error); }
  if (!failures.length && receipt.commands.length === 4 && receipt.commands.every((command) => command.complete)) {
    try {
      assert.equal(path.dirname(scratch), os.tmpdir());
      assert.ok(path.basename(scratch).startsWith("openclaw-channel-follow-proof-"));
      await fs.rm(scratch, { recursive: true });
      receipt.cleanup = true;
    } catch (error) { failures.push(error); }
  } else receipt.retainedScratch = scratch;
  receipt.complete = !failures.length && receipt.cleanup;
  receipt.errors = failures.map(String);
  await fs.writeFile(path.join(artifacts, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
}
if (failures.length) throw new AggregateError(failures, "Channel logs actual CLI proof incomplete");

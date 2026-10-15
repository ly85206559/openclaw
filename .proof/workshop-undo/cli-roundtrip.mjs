import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

assert.equal(process.env.GITHUB_ACTIONS, "true");
assert.equal(process.platform, "linux");
const source = process.cwd();
const output = process.env.PROOF_OUTPUT_DIR;
const mode = process.env.PROOF_MODE;
assert.ok(output && ["baseline", "candidate"].includes(mode));
const stamp = JSON.parse(await fs.readFile("dist/.buildstamp", "utf8"));
assert.equal(stamp.head, process.env.SOURCE_SHA);
assert.equal(stamp.inputsClean, true);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const entryHash = hash(await fs.readFile("dist/entry.js"));
const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "workshop-undo-"));
const state = path.join(fixture, "state");
const configPath = path.join(fixture, "openclaw.json");
const receipt = { mode, sourceSha: stamp.head, buildStamp: stamp, entryHash, calls: [], errors: [] };
const roots = Object.fromEntries(["main", "writer"].map((id) => [id, path.join(fixture, id, "agent")]));
const skillPath = (id) => path.join(roots[id], "workshop-skills", "release-notes", "SKILL.md");
const supportPath = (id) => path.join(roots[id], "workshop-skills", "release-notes", "references", "notes.md");
const content = Object.fromEntries(["main", "writer"].map((id) => [id,
  `---\nname: release-notes\ndescription: Draft synthetic release notes.\n---\n\n${id.toUpperCase()} ORIGINAL SKILL\n`,
]));
const exists = async (file) => fs.stat(file).then(() => true, (error) => {
  if (error.code === "ENOENT") return false;
  throw error;
});
const groupExists = (pid) => {
  try { process.kill(-pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
};
async function joinGroup(pid, budgetMs = 15_000) {
  const deadline = Date.now() + budgetMs;
  while (groupExists(pid) && Date.now() < deadline) await delay(50);
  assert.equal(groupExists(pid), false, "CLI process group must terminate naturally");
}

async function cli(args) {
  const index = receipt.calls.length;
  const call = { args, processGroupGone: false };
  receipt.calls.push(call);
  const started = Date.now();
  const child = spawn("pnpm", ["--silent", "openclaw", ...args], {
    cwd: source, detached: true, stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH, HOME: fixture, OPENCLAW_HOME: fixture,
      OPENCLAW_STATE_DIR: state, OPENCLAW_CONFIG_PATH: configPath,
      CI: "true", NO_COLOR: "1", FORCE_COLOR: "0", TERM: "dumb",
      OPENCLAW_SKIP_CHANNELS: "1", OPENCLAW_DISABLE_BACKGROUND_TASKS: "1",
    },
  });
  let stdout = "", stderr = "", timedOut = false, overflow = false;
  const stop = () => { if (child.pid && groupExists(child.pid)) process.kill(-child.pid, "SIGTERM"); };
  child.stdout.on("data", (chunk) => { stdout += chunk; if (stdout.length > 512_000) { overflow = true; stop(); } });
  child.stderr.on("data", (chunk) => { stderr += chunk; if (stderr.length > 512_000) { overflow = true; stop(); } });
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  let killTimer;
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
    killTimer = setTimeout(() => {
      if (child.pid && groupExists(child.pid)) process.kill(-child.pid, "SIGKILL");
    }, 5_000);
  }, 90_000);
  try {
    call.exit = await closed;
    assert.ok(child.pid);
    await joinGroup(child.pid);
    call.processGroupGone = true;
    assert.equal(timedOut, false, "CLI timeout is a harness failure");
    assert.equal(overflow, false, "CLI capture overflow is a harness failure");
    assert.deepEqual(call.exit, { code: 0, signal: null });
    return stdout;
  } catch (error) {
    clearTimeout(timer);
    clearTimeout(killTimer);
    if (child.pid && groupExists(child.pid)) {
      stop();
      const deadline = Date.now() + 5_000;
      while (groupExists(child.pid) && Date.now() < deadline) await delay(50);
      const forcedKill = groupExists(child.pid);
      if (forcedKill) process.kill(-child.pid, "SIGKILL");
      try {
        await joinGroup(child.pid, 5_000);
        call.failureCleanup = { forcedKill, processGroupGone: true };
      } catch (cleanupError) {
        receipt.errors.push({ name: "FailureCleanupError", message: cleanupError.message });
      }
    }
    throw error;
  } finally {
    clearTimeout(timer);
    clearTimeout(killTimer);
    call.wallMs = Date.now() - started;
    await fs.writeFile(path.join(output, `cli-${index}.stdout.log`), stdout);
    await fs.writeFile(path.join(output, `cli-${index}.stderr.log`), stderr);
  }
}

try {
  await fs.mkdir(state, { recursive: true });
  for (const id of ["main", "writer"]) {
    await fs.mkdir(path.dirname(supportPath(id)), { recursive: true });
    await fs.writeFile(skillPath(id), content[id]);
    await fs.writeFile(supportPath(id), `${id.toUpperCase()} SUPPORT\n`);
  }
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await fs.writeFile(configPath, JSON.stringify({
    gateway: { mode: "local", port },
    plugins: { enabled: false, slots: { memory: "none" } },
    skills: { load: { watch: false }, workshop: { autonomous: { mode: "off" } } },
    agents: { entries: {
      main: { workspace: source, agentDir: roots.main },
      writer: { workspace: path.join(fixture, "writer-workspace"), agentDir: roots.writer },
    } },
  }));
  const mainArchive = JSON.parse(await cli(["skills", "workshop", "archive", "release-notes", "--agent", "main", "--json"]));
  assert.equal(mainArchive.change.agentId, "main");
  assert.equal(mainArchive.change.actor, "user");
  assert.ok(mainArchive.change.versionId);
  const mainVersion = path.join(roots.main, "workshop-skills", ".archive", "release-notes", mainArchive.change.versionId);
  assert.equal(await fs.readFile(path.join(mainVersion, "SKILL.md"), "utf8"), content.main);
  assert.equal(await exists(skillPath("main")), false);

  const archived = await cli(["skills", "workshop", "archive", "release-notes", "--agent", "writer"]);
  const match = /^Archived release-notes\. Undo with: (openclaw [^\r\n]+)$/m.exec(archived);
  assert.ok(match, "archive must produce a recovery command");
  receipt.undoCommand = match[1];
  assert.equal(await exists(skillPath("writer")), false);
  const writerArchiveRoot = path.join(roots.writer, "workshop-skills", ".archive", "release-notes");
  const versions = await fs.readdir(writerArchiveRoot);
  assert.equal(versions.length, 1);
  assert.equal(await fs.readFile(path.join(writerArchiveRoot, versions[0], "SKILL.md"), "utf8"), content.writer);

  const argv = receipt.undoCommand.split(" ");
  assert.equal(argv.shift(), "openclaw");
  assert.ok(argv.every((word) => /^[a-z0-9_-]+$/.test(word)), "synthetic recovery argv must be shell-safe");
  await cli(argv);
  receipt.afterUndo = {
    writerRestored: await exists(skillPath("writer")),
    mainRestored: await exists(skillPath("main")),
  };
  if (receipt.afterUndo.writerRestored) {
    assert.equal(await fs.readFile(skillPath("writer"), "utf8"), content.writer);
    assert.equal(await fs.readFile(supportPath("writer"), "utf8"), "WRITER SUPPORT\n");
  }
  if (receipt.afterUndo.mainRestored) {
    assert.equal(await fs.readFile(skillPath("main"), "utf8"), content.main);
  }
  receipt.behaviorFailures = [
    !receipt.afterUndo.writerRestored && "selected-writer-remains-archived",
    receipt.afterUndo.mainRestored && "unselected-main-restored-instead",
  ].filter(Boolean);
  for (const id of ["writer", "main"]) {
    const control = JSON.parse(await cli(["skills", "workshop", "restore", "release-notes", "--agent", id, "--json"]));
    assert.equal(control.change.agentId, id);
    assert.equal(control.change.actor, "user");
    assert.equal(await fs.readFile(skillPath(id), "utf8"), content[id]);
    assert.equal(await fs.readFile(supportPath(id), "utf8"), `${id.toUpperCase()} SUPPORT\n`);
  }
  receipt.explicitRestoreControls = "both original skills and support files restored byte-for-byte";
  assert.equal(hash(await fs.readFile("dist/entry.js")), entryHash);
  if (mode === "baseline") {
    assert.deepEqual(receipt.behaviorFailures, [
      "selected-writer-remains-archived", "unselected-main-restored-instead",
    ], "baseline must reproduce the exact wrong-agent outcome");
    receipt.expectedBaselineReproduced = true;
  }
} catch (error) {
  receipt.errors.push({ name: error.name, message: error.message });
} finally {
  await fs.writeFile(path.join(output, "receipt.json"), JSON.stringify(receipt, null, 2));
}
assert.deepEqual(receipt.errors, [], "proof must not contain harness, fixture, CLI, or cleanup errors");
assert.deepEqual(receipt.behaviorFailures, [], "printed undo must restore only the selected agent");
console.log("PASS: printed undo restored writer; main remained archived; explicit controls and natural process exit passed");

// Manual, secretless CI proof. Copy to the exact checkout root as .proof-runtime.mts.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createLocalMeetingRealtimeAudioTransport } from "./src/meeting-bot/realtime-local-audio-transport.js";
import { createMeetingRealtimeOutputQueue } from "./src/meeting-bot/realtime-output-owner.js";

const expectFixed = process.env.PROOF_EXPECT_FIXED === "1";
assert.match(process.env.PROOF_EXPECT_FIXED ?? "", /^[01]$/);
const exactSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
assert.equal(exactSha, process.env.PROOF_EXACT_SHA);
assert.equal(process.platform, "linux", "This proof uses real Ubuntu child processes");
const realDateNow = Date.now;
const started = performance.now();
const startedAt = new Date().toISOString();
const report: Record<string, unknown> = {
  pr: 155850,
  exactSha,
  expectFixed,
  startedAt,
  node: process.version,
  platform: process.platform,
  boundary: "Production native child-process audio transport and realtime output queue",
  limitations: [
    "Synthetic PCM source and sink commands replace audio hardware",
    "No provider session or full meeting-engine lifecycle is claimed",
    "Only this process's Date.now is shifted; host clock and real timers are unchanged",
  ],
  cases: [],
};

// These are actual child programs, launched by the transport's default spawn path.
// A loopback control socket coordinates their PCM pipes without replacing production IO.
const childSource = String.raw`
const { createServer } = require("node:net");
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { createHash } = require("node:crypto");
const role = process.argv[1];
const directory = process.argv[2];
let receivedBytes = 0;
let emittedBytes = 0;
let emissions = 0;
const received = [];
const snapshot = () => ({
  role, pid: process.pid, receivedBytes, emittedBytes, emissions,
  sha256: createHash("sha256").update(Buffer.concat(received)).digest("hex"),
});
if (role === "output") {
  process.stdin.on("data", (chunk) => {
    receivedBytes += chunk.length;
    received.push(chunk);
  });
}
const server = createServer((socket) => {
  let text = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    text += chunk;
    if (!text.includes("\n")) return;
    const command = JSON.parse(text.slice(0, text.indexOf("\n")));
    if (command.action === "emit" && role !== "output") {
      const audio = Buffer.alloc(960);
      for (let i = 0; i < audio.length; i += 2) audio.writeInt16LE(i % 4 ? -2048 : 2048, i);
      process.stdout.write(audio, () => {
        emittedBytes += audio.length;
        emissions += 1;
        socket.end(JSON.stringify(snapshot()) + "\n");
      });
    } else {
      socket.end(JSON.stringify(snapshot()) + "\n");
    }
  });
  socket.on("error", () => {});
});
server.listen(0, "127.0.0.1", () => {
  writeFileSync(join(directory, role + ".ready.json"), JSON.stringify({
    role, pid: process.pid, port: server.address().port,
  }));
});
process.on("SIGTERM", () => {
  writeFileSync(join(directory, role + ".exit.json"), JSON.stringify({
    ...snapshot(), stoppedBy: "SIGTERM",
  }));
  process.exit(0);
});
`;

type Child = { role: string; pid: number; port: number };
type ChildSnapshot = Child & {
  receivedBytes: number;
  emittedBytes: number;
  emissions: number;
  sha256: string;
};

async function waitUntil(predicate: () => boolean, label: string, budgetMs = 10_000) {
  const deadline = performance.now() + budgetMs;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, `Timed out: ${label}`);
    await delay(10);
  }
}

async function command(child: Child, action: "emit" | "snapshot"): Promise<ChildSnapshot> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port: child.port });
    let text = "";
    socket.setEncoding("utf8");
    socket.setTimeout(5_000, () => socket.destroy(new Error(`${child.role} control timeout`)));
    socket.on("connect", () => socket.write(`${JSON.stringify({ action })}\n`));
    socket.on("data", (chunk) => {
      text += chunk;
    });
    socket.on("error", reject);
    socket.on("end", () => {
      try {
        resolve(JSON.parse(text));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function processExists(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

async function runCase(shiftMs: number) {
  // openclaw-temp-dir: allow manual standalone proof owns real process control artifacts
  const directory = mkdtempSync(join(tmpdir(), "openclaw-native-clock-proof-"));
  const caseStarted = performance.now();
  const caseWallStarted = realDateNow();
  const warnings: string[] = [];
  const failures: string[] = [];
  const bargeIns: Array<{ atMs: number; bytes: number }> = [];
  let inputBytes = 0;
  const inputHash = createHash("sha256");
  const children: Child[] = [];
  const row: Record<string, unknown> = { shiftMs };
  const childCommand = (role: string) => [process.execPath, "-e", childSource, role, directory];
  const transport = createLocalMeetingRealtimeAudioTransport({
    inputCommand: childCommand("input"),
    outputCommand: childCommand("output"),
    bargeInInputCommand: childCommand("barge"),
    bargeInRmsThreshold: 100,
    bargeInPeakThreshold: 100,
    bargeInCooldownMs: 1_800,
    audioFormat: "pcm16-24khz",
    logger: {
      info: () => {},
      warn: (message) => warnings.push(message),
      error: (message) => warnings.push(message),
    },
    logScope: "[native-clock-proof]",
  });
  const queue = createMeetingRealtimeOutputQueue({
    transport,
    bytesPerMs: 48,
    onFailure: (source, error) => failures.push(`${source}: ${String(error)}`),
  });
  transport.onFatal(() => failures.push("fatal transport failure"));
  transport.startInput((audio) => {
    inputBytes += audio.length;
    inputHash.update(audio);
  });
  transport.startBargeInMonitor?.((audio) => {
    bargeIns.push({ atMs: performance.now() - caseStarted, bytes: audio.length });
    return true;
  });

  try {
    for (const role of ["input", "output", "barge"]) {
      const path = join(directory, `${role}.ready.json`);
      await waitUntil(() => existsSync(path), `${role} child ready`);
      children.push(JSON.parse(readFileSync(path, "utf8")));
    }
    const [input, output, barge] = children;
    assert.ok(input && output && barge);
    await command(input, "emit");
    await waitUntil(() => inputBytes === 960, "real child input delivered through transport");
    const expectedInput = Buffer.alloc(960);
    for (let i = 0; i < expectedInput.length; i += 2) {
      expectedInput.writeInt16LE(i % 4 ? -2048 : 2048, i);
    }
    assert.equal(inputHash.digest("hex"), createHash("sha256").update(expectedInput).digest("hex"));

    await command(barge, "emit");
    await waitUntil(() => bargeIns.length === 1, "first barge-in accepted");
    const firstBargeInAt = performance.now();
    const pcm = Buffer.alloc(48 * 1_200);
    for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(i % 4 ? -2048 : 2048, i);
    assert.equal(queue.enqueue(pcm, true, true), true);
    await waitUntil(() => queue.pending().pendingFrames === 0, "native output write settled");
    let sink = await command(output, "snapshot");
    const sinkDeadline = performance.now() + 5_000;
    while (sink.receivedBytes < pcm.length) {
      assert.ok(performance.now() < sinkDeadline, "PCM did not arrive at output child stdin");
      await delay(10);
      sink = await command(output, "snapshot");
    }
    assert.equal(sink.receivedBytes, pcm.length);
    assert.equal(sink.sha256, createHash("sha256").update(pcm).digest("hex"));
    assert.equal(queue.hasUnplayedAudibleAudio(), true);

    Date.now = () => realDateNow() + shiftMs;
    const audibleImmediatelyAfterShift = queue.hasUnplayedAudibleAudio();
    await command(barge, "emit");
    await delay(100);
    assert.ok(performance.now() - firstBargeInAt < 1_800, "Fixture missed cooldown window");
    const bargeInsWithinCooldown = bargeIns.length;
    await delay(Math.max(0, firstBargeInAt + 2_100 - performance.now()));
    const audibleAfterPlaybackDuration = queue.hasUnplayedAudibleAudio();
    await command(barge, "emit");
    await delay(100);
    const finalBargeSnapshot = await command(barge, "snapshot");
    assert.equal(finalBargeSnapshot.emissions, 3);
    assert.equal(finalBargeSnapshot.emittedBytes, 2_880);

    Object.assign(row, {
      inputBytes,
      sinkBytes: sink.receivedBytes,
      sinkSha256: sink.sha256,
      playbackDurationMs: 1_200,
      cooldownMs: 1_800,
      audibleImmediatelyAfterShift,
      audibleAfterPlaybackDuration,
      bargeInsWithinCooldown,
      bargeInsAfterCooldown: bargeIns.length,
      bargeIns,
      bargeSource: finalBargeSnapshot,
      elapsedSinceFirstBargeInMs: Math.round(performance.now() - firstBargeInAt),
    });
    assert.equal(audibleImmediatelyAfterShift, expectFixed || shiftMs < 0);
    assert.equal(audibleAfterPlaybackDuration, !expectFixed && shiftMs < 0);
    assert.equal(bargeInsWithinCooldown, !expectFixed && shiftMs > 0 ? 2 : 1);
    assert.equal(bargeIns.length, expectFixed ? 2 : shiftMs > 0 ? 3 : 1);
    assert.deepEqual(failures, []);
    assert.deepEqual(warnings, []);
    row.expectedOutcomeObserved = true;
  } finally {
    Date.now = realDateNow;
    queue.stop();
    await transport.stop();
    await transport.dispose();
    row.children = children.map((child) => ({
      ...child,
      exited: !processExists(child.pid),
      exitRecord: existsSync(join(directory, `${child.role}.exit.json`))
        ? JSON.parse(readFileSync(join(directory, `${child.role}.exit.json`), "utf8"))
        : null,
    }));
    for (const child of children) {
      assert.equal(processExists(child.pid), false, `${child.role} child did not settle`);
      assert.ok(
        existsSync(join(directory, `${child.role}.exit.json`)),
        `${child.role} missed SIGTERM`,
      );
    }
    row.durationMs = Math.round(performance.now() - caseStarted);
    row.realWallElapsedMs = realDateNow() - caseWallStarted;
    row.warnings = warnings;
    row.failures = failures;
    (report.cases as unknown[]).push(row);
    // Only this fresh proof-owned directory is removed after all children have exited.
    rmSync(directory, { recursive: true });
  }
}

try {
  for (const shiftMs of [60_000, -60_000]) await runCase(shiftMs);
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = error instanceof Error ? error.stack : String(error);
  process.exitCode = 1;
} finally {
  Date.now = realDateNow;
  report.durationMs = Math.round(performance.now() - started);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  process.stdout.write(json);
  const output = process.env.PROOF_OUTPUT;
  if (output) {
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, json);
  }
}

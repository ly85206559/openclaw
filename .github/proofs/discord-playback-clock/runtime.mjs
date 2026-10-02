// Fork-only media-client trace, not connected Discord or audible playback proof.
// Run from the clean SOURCE_SHA checkout with node --import ./scripts/tsx.mjs.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const sources = {
  red: "32e30e59d9a7fd1f5b3a9e9659427d45145779dd",
  green: "b61076e6faf38c353c016a9739935e11d41f157e",
};
const phase = process.env.PROOF_EXPECT;
assert.ok(phase === "red" || phase === "green", "PROOF_EXPECT must be red or green");
assert.equal(process.env.SOURCE_SHA, sources[phase]);
const git = (...args) => execFileSync("git", args, {
  encoding: "utf8",
  timeout: 5_000,
  env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
}).trim();
assert.equal(git("rev-parse", "HEAD"), sources[phase]);
assert.equal(git("status", "--porcelain"), "", "Proof must import an unmodified source checkout");

const sourceUrl = (file) => pathToFileURL(path.resolve(process.cwd(), file));
const pluginRequire = createRequire(sourceUrl("extensions/discord/src/voice/audio.ts"));
function installedPackage(name) {
  for (const base of pluginRequire.resolve.paths(name)) {
    const directory = path.join(base, name);
    try {
      const manifest = JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8"));
      assert.equal(manifest.name, name);
      return { directory, manifest };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  throw new Error(`Cannot locate installed ${name} manifest`);
}
const voicePackage = installedPackage("@discordjs/voice");
const libopusPackage = installedPackage("libopus-wasm");
const versions = {
  node: process.version,
  voice: voicePackage.manifest.version,
  libopus: libopusPackage.manifest.version,
};
assert.equal(versions.voice, "0.19.2");
assert.equal(versions.libopus, "0.4.1");

const hardDeadline = setTimeout(() => {
  console.error(JSON.stringify({ phase, source: sources[phase], failure: "45s runtime trace deadline" }));
  process.exit(1);
}, 45_000);
const originalDateNow = Date.now;

async function bounded(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => { timer = setTimeout(() => resolve(undefined), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

try {
  const { DiscordRealtimeOutput } = await import(sourceUrl("extensions/discord/src/voice/realtime-output.runtime.ts"));
  const { DiscordRealtimePlayer } = await import(sourceUrl("extensions/discord/src/voice/realtime-player.runtime.ts"));
  const { loadDiscordVoiceSdk } = await import(sourceUrl("extensions/discord/src/voice/sdk-runtime.ts"));
  const {
    DISCORD_AUDIO_CLOCK_BYTES,
    DISCORD_AUDIO_PLAYED_BYTES,
    DISCORD_AUDIO_STARTED,
    DiscordAudioOutputStatus,
    getDiscordAudioOutputStatus,
  } = await import(sourceUrl("extensions/discord/src/voice/audio-worker-protocol.ts"));
  // libopus-wasm is import-only; require.resolve() has no matching export condition.
  const libopusEntry = libopusPackage.manifest.exports["."].import;
  assert.equal(typeof libopusEntry, "string");
  const { createDecoder } = await import(pathToFileURL(path.resolve(libopusPackage.directory, libopusEntry)));
  const voice = loadDiscordVoiceSdk();
  // Decode the real first packet, and initialize WASM before the timed owner flow.
  const decoder = await createDecoder({ channels: 2, sampleRate: 48_000 });
  const pcm = Buffer.alloc(24_000 * 2);
  for (let sample = 0; sample < 24_000; sample += 1) {
    pcm.writeInt16LE(Math.round(6_000 * Math.sin(2 * Math.PI * 440 * sample / 24_000)), sample * 2);
  }
  const rows = [];
  try {
    for (const shiftMs of [0, 60_000, -60_000]) {
      const createdAt = performance.now();
      // The baseline tracker captures Date.now at construction, so keep identity
      // stable and change only this process-local wrapper's returned offset.
      let wallShiftMs = 0;
      const wallClock = () => originalDateNow() + wallShiftMs;
      Date.now = wallClock;
      const clock = new BigInt64Array(new SharedArrayBuffer(DISCORD_AUDIO_CLOCK_BYTES));
      const sdkPlayer = voice.createAudioPlayer();
      assert.ok(sdkPlayer instanceof voice.AudioPlayer);
      const player = new DiscordRealtimePlayer(sdkPlayer);
      const errors = [];
      const states = [];
      let startedAt;
      let startedWall;
      let closes = 0;
      let closeRecord;
      let resource;
      let resourceClosed;
      let resolveClose;
      const closed = new Promise((resolve) => { resolveClose = resolve; });
      const onError = (error) => errors.push(String(error));
      sdkPlayer.on("error", onError);
      sdkPlayer.on("stateChange", (previous, next) => {
        states.push({ from: previous.status, to: next.status, atMs: Math.round(performance.now() - createdAt) });
      });
      const output = new DiscordRealtimeOutput({
        player,
        clock,
        continuous: false,
        logContext: `fork-real-client-proof shiftMs=${shiftMs}`,
        onStart: () => {
          assert.equal(startedAt, undefined);
          startedAt = performance.now();
          startedWall = originalDateNow();
        },
        onClose: (_output, reason) => {
          closes += 1;
          closeRecord = {
            reason,
            monotonicElapsedMs: performance.now() - startedAt,
            shiftedWallElapsedMs: Date.now() - startedWall,
            ownerElapsedMs: output.activity.elapsedPlaybackMs(),
            sdkStateBeforeCancel: sdkPlayer.state.status,
          };
          resolveClose(closeRecord);
        },
        onError,
      });
      try {
        output.append(pcm, true);
        assert.equal(Atomics.load(clock, DISCORD_AUDIO_STARTED), 1n);
        // Real SDK default Pause; no fake connection or player state assignment.
        await voice.entersState(sdkPlayer, voice.AudioPlayerStatus.AutoPaused, 2_500);
        assert.equal(closeRecord, undefined, "Natural Idle must not retire the output");
        assert.equal(sdkPlayer.playable.length, 0);
        resource = sdkPlayer.state.resource;
        assert.ok(resource instanceof voice.AudioResource);
        assert.equal(resource.audioPlayer, sdkPlayer);
        resourceClosed = new Promise((resolve) => { resource.playStream.once("close", () => resolve(true)); });
        const packet = resource.read();
        assert.ok(Buffer.isBuffer(packet) && packet.length > 0, "Read one real encoded Opus packet");
        assert.equal(resource.silenceRemaining, -1, "Packet must not be SDK-generated silence");
        const decoded = decoder.decode(packet, { maxFrameSize: 5_760 });
        assert.equal(decoded.length, 1_920);
        assert.ok(decoded.some((sample) => sample !== 0), "Real codec must decode the synthetic tone");
        assert.equal(Atomics.load(clock, DISCORD_AUDIO_PLAYED_BYTES), 3_840n);
        assert.equal(resource.playbackDuration, 20);
        assert.ok(output.pendingBytes() > 0);
        const activity = output.activity.snapshot();
        assert.equal(activity.audioMs, 1_000);
        assert.equal(activity.sourceAudioBytes, 48_000);
        assert.equal(activity.sinkAudioBytes, 192_000);

        const finishAt = performance.now();
        const setupElapsedMs = finishAt - startedAt;
        // A setup over half the one-second audio budget cannot distinguish 3s/4s.
        assert.ok(setupElapsedMs < 500, `Inconclusive slow setup: ${setupElapsedMs}ms`);
        wallShiftMs = shiftMs;
        assert.equal(Date.now, wallClock);
        output.finish("fork-real-client-proof-response-done", true);
        const observedClose = await bounded(closed, 6_500);
        const stateAtDeadline = sdkPlayer.state.status;
        const pendingAtDeadline = output.pendingBytes();
        const elapsedAtDeadlineMs = performance.now() - startedAt;
        const ownerElapsedAtDeadlineMs = output.activity.elapsedPlaybackMs();
        const timedOut = observedClose === undefined;
        if (timedOut) output.close("proof-bounded-cleanup");
        assert.equal(sdkPlayer.state.status, voice.AudioPlayerStatus.Idle);
        assert.equal(resource.audioPlayer, undefined);
        assert.equal(resource.playStream.destroyed, true);
        assert.equal(await bounded(resourceClosed, 2_500), true, "Real Opus stream must close after SDK cancellation");
        assert.equal(getDiscordAudioOutputStatus(clock), DiscordAudioOutputStatus.Closed);
        assert.equal(closes, 1);
        assert.deepEqual(errors, []);
        const row = {
          phase,
          source: sources[phase],
          versions,
          scope: "production-output/player + real voice SDK/resource/libopus; no VoiceConnection or delivered audio",
          shiftMs,
          wallClockWrapperInstalledBeforeOutput: true,
          monotonicClockModified: false,
          setupElapsedMs,
          emittedAudioMs: activity.audioMs,
          sourcePcmBytes: activity.sourceAudioBytes,
          sinkPcmBytes: activity.sinkAudioBytes,
          manuallyReadEncodedPackets: 1,
          packetBytes: packet.length,
          packetSha256: createHash("sha256").update(packet).digest("hex"),
          decodedSamples: decoded.length,
          ownerReadPcmBytes: Number(Atomics.load(clock, DISCORD_AUDIO_PLAYED_BYTES)),
          timedOut,
          stateAtDeadline,
          pendingAtDeadline,
          elapsedAtDeadlineMs,
          ownerElapsedAtDeadlineMs,
          close: closeRecord,
          sdkStateAfterCancel: sdkPlayer.state.status,
          resourceDestroyed: resource.playStream.destroyed,
          states,
        };
        console.log(JSON.stringify(row));
        rows.push(row);
        if (phase === "green" || shiftMs === 0) {
          assert.equal(timedOut, false);
          assert.equal(closeRecord.reason, "playback-watchdog");
          assert.equal(closeRecord.sdkStateBeforeCancel, voice.AudioPlayerStatus.AutoPaused);
          assert.ok(Math.abs(closeRecord.monotonicElapsedMs - 4_000) < 500, "Watchdog must keep the real ~4s budget");
          assert.ok(Math.abs(closeRecord.ownerElapsedMs - closeRecord.monotonicElapsedMs) < 50);
        } else if (shiftMs > 0) {
          assert.equal(timedOut, false);
          assert.equal(closeRecord.reason, "playback-watchdog");
          assert.ok(closeRecord.monotonicElapsedMs < 3_500, "Baseline positive jump must cut off the 4s budget");
          assert.ok(closeRecord.monotonicElapsedMs - setupElapsedMs >= 2_950);
          assert.ok(closeRecord.ownerElapsedMs > 60_000);
        } else {
          assert.equal(timedOut, true, "Baseline negative jump must remain unretired beyond the 4s budget");
          assert.equal(stateAtDeadline, voice.AudioPlayerStatus.AutoPaused);
          assert.ok(pendingAtDeadline > 0);
          assert.ok(elapsedAtDeadlineMs >= 6_500);
          assert.ok(ownerElapsedAtDeadlineMs < -50_000);
          assert.equal(closeRecord.reason, "proof-bounded-cleanup");
        }
      } finally {
        Date.now = originalDateNow;
        output.close("proof-finally-cleanup");
        player.close();
      }
    }
    assert.equal(rows.length, 3);
    console.log(JSON.stringify({ phase, source: sources[phase], realClientRows: rows.length, outcome: "expected observations verified", liveDiscord: false }));
  } finally {
    decoder.free();
  }
} finally {
  Date.now = originalDateNow;
  clearTimeout(hardDeadline);
}

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { chromium, type Page } from "playwright";

// One-off secretless Chromium proof. This is not a per-PR test or a live vendor meeting.
const started = performance.now();
const expectedFixed = process.env.PROOF_EXPECT_FIXED === "1";
assert.ok(["0", "1"].includes(process.env.PROOF_EXPECT_FIXED ?? ""));
const exactSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
assert.equal(exactSha, process.env.PROOF_EXACT_SHA);
const ownerPath = "src/meeting-bot/browser-audio-capture-source.ts";
const ownerSha256 = createHash("sha256")
  .update(await readFile(ownerPath))
  .digest("hex");
const { createMeetingBrowserAudioCaptureSource } = await import(
  pathToFileURL(resolve(ownerPath)).href
);
const { createBrowserMeetingRealtimeAudioTransport } = await import(
  pathToFileURL(resolve("src/meeting-bot/realtime-browser-audio-transport.ts")).href
);

function deferred<T>() {
  let resolveValue!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolveValue = resolvePromise;
  });
  return { promise, resolve: resolveValue };
}

async function bounded<T>(promise: Promise<T>, label: string, timeoutMs = 5_000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html" });
  response.end(
    "<!doctype html><title>Synthetic meeting audio boundary</title><audio id='remote' autoplay></audio>",
  );
});
await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const address = server.address();
assert.ok(address && typeof address === "object");
const origin = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({
  headless: true,
  args: ["--autoplay-policy=no-user-gesture-required", "--no-sandbox"],
});

async function setupPage(page: Page) {
  // tsx may preserve function names with this helper inside serialized callbacks.
  await page.addInitScript("globalThis.__name = (target) => target;");
  await page.goto(origin);
  await page.evaluate(async () => {
    const remote = document.querySelector<HTMLAudioElement>("#remote")!;
    const sourceContext = new AudioContext({ sampleRate: 24_000 });
    const oscillator = sourceContext.createOscillator();
    oscillator.frequency.value = 440;
    const gain = sourceContext.createGain();
    gain.gain.value = 0.2;
    const destination = sourceContext.createMediaStreamDestination();
    oscillator.connect(gain);
    gain.connect(destination);
    remote.srcObject = destination.stream;
    oscillator.start();
    await sourceContext.resume();
    await remote.play();
    const state = {
      sessionId: "proof-session",
      sourceContext,
      oscillator,
      remote,
      captureContext: undefined as AudioContext | undefined,
      closes: [] as { atMs: number; state: string }[],
      nativeDateNow: Date.now.bind(Date),
      offsetMs: 0,
    };
    Object.assign(window, { proof: state });
    // Observe native objects and forward all calls without changing their behavior.
    const originalCreate = AudioContext.prototype.createScriptProcessor;
    AudioContext.prototype.createScriptProcessor = function (...args) {
      state.captureContext = this;
      return originalCreate.apply(this, args);
    };
    const originalClose = AudioContext.prototype.close;
    AudioContext.prototype.close = async function () {
      await originalClose.call(this);
      if (this === state.captureContext) {
        state.closes.push({ atMs: performance.now(), state: this.state });
      }
    };
    Date.now = () => state.nativeDateNow() + state.offsetMs;
  });
}

async function snapshot(page: Page) {
  return await page.evaluate(() => {
    const state = (
      window as unknown as {
        proof: {
          captureContext?: AudioContext;
          remote: HTMLAudioElement;
          closes: { atMs: number; state: string }[];
        };
      }
    ).proof;
    const capture = (
      window as unknown as { __openclawMeetingRemoteAudio?: { chunks: Uint8Array[] } }
    ).__openclawMeetingRemoteAudio;
    return {
      atMs: performance.now(),
      active: Boolean(capture),
      muted: state.remote.muted,
      contextState: state.captureContext?.state,
      queuedBytes: capture?.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0) ?? 0,
      sourceTrackState: (state.remote.srcObject as MediaStream).getAudioTracks()[0]?.readyState,
      closes: [...state.closes],
    };
  });
}

async function shiftPageClock(page: Page, deltaMs: number) {
  return await page.evaluate((delta) => {
    const state = (window as unknown as { proof: { offsetMs: number } }).proof;
    const before = { epochMs: Date.now(), monotonicMs: performance.now() };
    state.offsetMs += delta;
    return {
      before,
      after: { epochMs: Date.now(), monotonicMs: performance.now() },
      deltaMs: delta,
    };
  }, deltaMs);
}

async function runCase(deltaMs: number) {
  const caseStarted = performance.now();
  const page = await browser.newPage();
  await setupPage(page);
  const sourceActions = new Map<string, string>();
  let nextGate: ReturnType<typeof deferred<void>> | undefined;
  let enteredGate: ReturnType<typeof deferred<void>> | undefined;
  let releaseCurrent: (() => void) | undefined;
  let audibleWaiter: ReturnType<typeof deferred<{ bytes: number; peak: number }>> | undefined;
  let deliveredBytes = 0;
  let fatalCount = 0;
  const fatalSignal = deferred<void>();
  let nativeStopCount = 0;
  const warnings: string[] = [];
  const transport = await createBrowserMeetingRealtimeAudioTransport({
    nativeTransport: {
      onFatal() {},
      startInput() {},
      async stop() {
        nativeStopCount++;
      },
      async dispose() {},
      async writeOutput() {},
      async clearOutput() {},
    },
    hasConfiguredInputCommand: false,
    callBrowser: async (request: { body?: unknown }) => {
      const body = request.body as { fn: string };
      if (sourceActions.get(body.fn) === "pull" && nextGate) {
        // Fault injection models an unresponsive host after tab-lock acquisition.
        // The production lock's 5s deadline bounds acquisition, not operation execution.
        const gate = nextGate;
        nextGate = undefined;
        releaseCurrent = () => gate.resolve();
        enteredGate?.resolve();
        await gate.promise;
        releaseCurrent = undefined;
      }
      return { result: await page.evaluate(`(${body.fn})()`) };
    },
    buildCaptureScript: (request: {
      action: "start" | "pull" | "stop";
      captureId: string;
      meetingSessionId: string;
      meetingUrl: string;
    }) => {
      const source = createMeetingBrowserAudioCaptureSource({
        ...request,
        ownershipSource: "return window.proof.sessionId === sessionId;",
      });
      sourceActions.set(source, request.action);
      return source;
    },
    meetingSessionId: "proof-session",
    meetingUrl: origin,
    targetId: `proof-tab-${deltaMs}`,
    audioFormat: "pcm16-24khz",
    logger: { warn: (message: string) => warnings.push(message), info() {}, error() {} },
  });
  transport.onFatal(() => {
    fatalCount++;
    fatalSignal.resolve();
  });
  const waitForAudible = () => {
    audibleWaiter = deferred<{ bytes: number; peak: number }>();
    return bounded(audibleWaiter.promise, "native Chromium PCM at transport input");
  };
  const pauseNextPull = async () => {
    nextGate = deferred<void>();
    enteredGate = deferred<void>();
    await bounded(enteredGate.promise, "pause next browser pull");
    return await snapshot(page);
  };
  try {
    const initialAudio = waitForAudible();
    transport.startInput((audio: Buffer) => {
      deliveredBytes += audio.length;
      let peak = 0;
      for (let index = 0; index + 1 < audio.length; index += 2) {
        peak = Math.max(peak, Math.abs(audio.readInt16LE(index)));
      }
      if (peak > 100 && audibleWaiter) {
        audibleWaiter.resolve({ bytes: audio.length, peak });
        audibleWaiter = undefined;
      }
    });
    const beforeAudio = await initialAudio;
    const firstPause = await pauseNextPull();
    const survivalJump = await shiftPageClock(page, deltaMs);
    await delay(300);
    const afterJump = await snapshot(page);
    let afterAudio: { bytes: number; peak: number } | undefined;
    let expirationJump: Awaited<ReturnType<typeof shiftPageClock>> | undefined;
    let idleStart = firstPause;
    if (afterJump.active) {
      const followingAudio = waitForAudible();
      releaseCurrent?.();
      afterAudio = await followingAudio;
      idleStart = await pauseNextPull();
      // A fresh wall-clock jump after the final heartbeat tests idle expiry separately
      // from recovery and delivered PCM after the first jump.
      expirationJump = await shiftPageClock(page, deltaMs);
      await delay(10_400);
    }
    const idleEnd = await snapshot(page);
    assert.equal(fatalCount, 0, "browser expiry must precede host transport failure handling");
    assert.equal(nativeStopCount, 0, "host cleanup must not cause the observed browser expiry");
    if (expectedFixed) {
      assert.equal(afterJump.active, true, "clock correction must not close active capture");
      assert.ok(afterAudio && afterAudio.peak > 100, "real PCM must arrive after clock correction");
      assert.equal(idleEnd.active, false, "unpulled capture must expire after real 10s budget");
      assert.equal(idleEnd.contextState, "closed");
      assert.equal(idleEnd.muted, false, "capture teardown restores remote playback mute");
      assert.equal(idleEnd.queuedBytes, 0);
      assert.equal(idleEnd.closes.length, 1);
      const elapsedToCloseMs = idleEnd.closes[0].atMs - idleStart.atMs;
      assert.ok(
        elapsedToCloseMs >= 9_700 && elapsedToCloseMs <= 10_400,
        `real close interval ${elapsedToCloseMs}ms does not match 10s heartbeat`,
      );
    } else if (deltaMs > 0) {
      assert.equal(afterJump.active, false, "base must reproduce premature forward-clock expiry");
      assert.equal(afterJump.contextState, "closed");
    } else {
      assert.equal(afterJump.active, true);
      assert.equal(idleEnd.active, true, "base must reproduce backward-clock idle leak");
      assert.equal(idleEnd.contextState, "running");
      assert.equal(idleEnd.muted, true);
    }
    assert.equal(idleEnd.sourceTrackState, "live", "teardown must preserve source track ownership");
    releaseCurrent?.();
    if (expectedFixed || deltaMs > 0) {
      await bounded(
        fatalSignal.promise,
        "expired capture reaches production transport fatal handler",
      );
      await transport.stop();
      assert.equal(fatalCount, 1, "resumed production transport must report expired capture");
      assert.equal(nativeStopCount, 1, "production transport must settle native cleanup once");
    }
    await transport.stop();
    const final = await snapshot(page);
    assert.equal(final.active, false);
    assert.equal(final.contextState, "closed");
    assert.equal(final.muted, false);
    assert.equal(final.closes.length, 1);
    return {
      deltaMs,
      beforeAudio,
      afterAudio,
      deliveredBytes,
      survivalJump,
      expirationJump,
      firstPause,
      afterJump,
      idleStart,
      idleEnd,
      final,
      fatalCount,
      nativeStopCount,
      warnings,
      wallMs: Math.round(performance.now() - caseStarted),
    };
  } finally {
    releaseCurrent?.();
    await transport.stop();
    await page.close();
  }
}

try {
  const cases = [];
  for (const deltaMs of [60_000, -60_000]) cases.push(await runCase(deltaMs));
  const receipt = {
    pr: 155848,
    exactSha,
    ownerSha256,
    expectedFixed,
    browser: browser.version(),
    platform: process.platform,
    node: process.version,
    boundary:
      "production browser transport -> generated shared capture -> real Chromium WebAudio -> PCM input",
    fixture:
      "localhost synthetic meeting; native 440Hz oscillator and MediaStream; no vendor session or credentials",
    clock:
      "only page Date.now changed; browser and host performance.now and native timers untouched",
    cases,
    wallMs: Math.round(performance.now() - started),
    outcome: "pass",
  };
  const output = resolve(process.env.PROOF_OUTPUT ?? "proof-runtime.json");
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(JSON.stringify(receipt));
} finally {
  await browser.close();
  await new Promise<void>((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose())),
  );
}

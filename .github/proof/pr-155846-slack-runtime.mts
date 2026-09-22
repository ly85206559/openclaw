import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

for (const key of [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "SLACK_API_URL",
]) {
  delete process.env[key];
}
const { createSlackStartupAuthClient } = await import(
  pathToFileURL(path.join(process.cwd(), "extensions/slack/src/client.ts")).href
);
const fixed = process.env.PROOF_EXPECT_FIXED === "1";
const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
assert.equal(sha, process.env.PROOF_EXACT_SHA);
const sourceHash = createHash("sha256")
  .update(await readFile("extensions/slack/src/client.ts"))
  .digest("hex");
const originalNow = Date.now;
const started = performance.now();
const receipts = [];

for (const shiftMs of [60_000, -60_000]) {
  let requestCount = 0;
  const requests: Array<{ method: string; path: string; elapsedMs: number }> = [];
  const server = createServer((request, response) => {
    request.resume();
    requestCount += 1;
    requests.push({
      method: request.method ?? "",
      path: request.url ?? "",
      elapsedMs: Math.round(performance.now() - cellStarted),
    });
    if (requestCount === 1) {
      Date.now = () => originalNow() + shiftMs;
    }
    response.writeHead(429, { "content-type": "application/json", "retry-after": "120" });
    response.end(JSON.stringify({ ok: false, error: "ratelimited" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const cellStarted = performance.now();
  let errorMessage = "";
  try {
    const client = createSlackStartupAuthClient("synthetic-proof-token", {
      slackApiUrl: `http://127.0.0.1:${address.port}/api/`,
      logger: {
        debug() {},
        info() {},
        warn() {},
        error() {},
        setLevel() {},
        getLevel() {
          return "error";
        },
        setName() {},
      },
    });
    try {
      await client.auth.test();
      assert.fail("Rate-limited startup auth unexpectedly succeeded");
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }
    const elapsedMs = Math.round(performance.now() - cellStarted);
    assert.match(errorMessage, /Slack startup auth retry budget exhausted after rate limit/);
    assert.ok(requests.length > 0);
    assert.ok(
      requests.every((entry) => entry.method === "POST" && entry.path === "/api/auth.test"),
    );
    if (fixed) {
      assert.ok(elapsedMs >= 34_000 && elapsedMs < 45_000, `Fixed auth duration ${elapsedMs} ms`);
    } else if (shiftMs > 0) {
      assert.ok(elapsedMs < 10_000, `Expected premature baseline settlement: ${elapsedMs} ms`);
    } else {
      assert.ok(
        elapsedMs >= 90_000 && elapsedMs < 110_000,
        `Expected extended baseline budget: ${elapsedMs} ms`,
      );
    }
    receipts.push({
      shiftMs,
      elapsedMs,
      requests,
      errorMessage,
      expectation: fixed
        ? "35-second elapsed budget"
        : shiftMs > 0
          ? "premature settlement reproduced"
          : "extended budget reproduced",
    });
  } finally {
    Date.now = originalNow;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    assert.equal(server.listening, false);
  }
}

const report = {
  sha,
  sourceHash,
  node: process.version,
  fixed,
  boundary:
    "createSlackStartupAuthClient -> real Slack WebClient.auth.test -> native HTTP loopback 429",
  timerPolicy: "real timers; only process Date.now changed after first HTTP request",
  receipts,
  cleanup: "both HTTP servers closed; Date.now restored",
  durationMs: Math.round(performance.now() - started),
};
await writeFile(process.env.PROOF_OUTPUT!, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = process.cwd();
const plugin = fileURLToPath(new URL("./plugin/", import.meta.url));
const expected = process.env.PROOF_EXPECT;
assert.ok(expected === "red" || expected === "green");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jM1sAAAAASUVORK5CYII=", "base64");
const pngSha = createHash("sha256").update(png).digest("hex");
const temporary = await mkdtemp(path.join(os.tmpdir(), "native-media-proof-"));
const workspace = path.join(temporary, "workspace");
await mkdir(workspace);
await writeFile(path.join(workspace, "proof.png"), png);
const requests = [];
const serverErrors = [];
const server = createServer(async (req, res) => {
  try {
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/v1/chat/completions");
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(body.model, "native-image");
    const userParts = body.messages.filter((message) => message.role === "user").flatMap((message) => Array.isArray(message.content) ? message.content : []);
    const images = userParts.filter((part) => part.type === "image_url");
    assert.equal(images.length, 1);
    assert.ok(images[0].image_url.url.startsWith("data:image/png;base64,"));
    assert.deepEqual(Buffer.from(images[0].image_url.url.split(",")[1], "base64"), png);
    requests.push({ pngSha, text: userParts.filter((part) => part.type === "text").map((part) => part.text).join("\n") });
    const chunk = (delta, finish_reason) => ({ id: "chatcmpl-proof", object: "chat.completion.chunk", created: 1, model: "native-image", choices: [{ index: 0, delta, finish_reason }] });
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: ${JSON.stringify(chunk({ role: "assistant", content: "NATIVE_IMAGE_OK" }, null))}\n\n`);
    res.write(`data: ${JSON.stringify({ ...chunk({}, "stop"), usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
    res.end("data: [DONE]\n\n");
  } catch (error) {
    serverErrors.push(error.message);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Synthetic HTTP fixture assertion failed" } }));
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const portProbe = net.createServer();
await new Promise((resolve) => portProbe.listen(0, "127.0.0.1", resolve));
const gatewayPort = portProbe.address().port;
await new Promise((resolve) => portProbe.close(resolve));
const token = "synthetic-native-media-proof-token";
const logFile = path.join(temporary, "gateway.log");
const configPath = path.join(temporary, "openclaw.json");
await writeFile(configPath, JSON.stringify({
  gateway: { mode: "local", bind: "loopback", port: gatewayPort, auth: { mode: "token", token }, controlUi: { enabled: false } },
  agents: { defaults: { model: { primary: "proof-local/native-image" }, workspace, skipBootstrap: true, heartbeat: { every: "0m" } } },
  models: { providers: { "proof-local": { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "synthetic-proof-key", api: "openai-completions", request: { allowPrivateNetwork: true }, models: [{ id: "native-image", name: "native-image", api: "openai-completions", reasoning: false, input: ["text", "image"], contextWindow: 128000, maxTokens: 128, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } },
  tools: { deny: ["*"], media: { models: [{ provider: "proof-unused-audio", model: "unused", capabilities: ["audio", "video"] }] } },
  plugins: { allow: ["proof-native-media"], load: { paths: [plugin] }, entries: { "proof-native-media": { enabled: true } }, slots: { memory: "none" } },
  cron: { enabled: false },
  logging: { level: "debug", consoleLevel: "error", file: logFile },
}));
const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(temporary, "state"), OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_SKIP_CHANNELS: "1", OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1" };
let gatewayOutput = "";
const gateway = spawn("pnpm", ["--silent", "openclaw", "gateway", "run", "--bind", "loopback", "--port", String(gatewayPort)], { cwd: root, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
gateway.stdout.on("data", (chunk) => { gatewayOutput += chunk; });
gateway.stderr.on("data", (chunk) => { gatewayOutput += chunk; });
const gatewayClosed = new Promise((resolve) => gateway.once("close", resolve));
function rpc(method, params, timeout = "120000") {
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", ["--silent", "openclaw", "gateway", "call", method, "--params", JSON.stringify(params), "--json", "--url", `ws://127.0.0.1:${gatewayPort}`, "--token", token, "--timeout", timeout], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let errors = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { errors += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) return reject(new Error(`RPC ${method} exit ${code}: ${output}\n${errors}`));
      try { resolve(JSON.parse(output)); } catch { reject(new Error(`RPC JSON parse failed: ${output}\n${errors}`)); }
    });
  });
}
try {
  const deadline = Date.now() + 360000;
  while (true) {
    if (gateway.exitCode !== null) throw new Error(`Gateway exited ${gateway.exitCode}: ${gatewayOutput}`);
    try {
      const ready = await rpc("proof.ready", {}, "3000");
      assert.equal(ready.ready, true);
      assert.equal(ready.mode, "full");
      break;
    } catch (error) {
      if (Date.now() > deadline) throw new Error(`Gateway readiness failed: ${error.message}\n${gatewayOutput}`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  const healthy = await rpc("proof.nativeImage", { case: "healthy" });
  assert.equal(healthy.faults, 0);
  assert.ok(healthy.decisions.some((decision) => decision.capability === "image" && decision.nativeVisionActive === true));
  assert.ok(healthy.replies.some((reply) => reply.text?.includes("NATIVE_IMAGE_OK")));
  const armed = await rpc("proof.arm", { armed: true });
  assert.equal(armed.armed, true);
  const faulty = await rpc("proof.nativeImage", { case: "faulty" });
  assert.ok(faulty.replies.some((reply) => reply.text?.includes("NATIVE_IMAGE_OK")));
  assert.deepEqual(serverErrors, []);
  assert.equal(requests.length, 2);
  assert.ok(requests[0].text.includes("Proof case healthy"));
  assert.ok(requests[1].text.includes("Proof case faulty"));
  const logs = await readFile(logFile, "utf8");
  if (expected === "red") {
    assert.ok(faulty.faults > 0);
    assert.deepEqual(faulty.decisions, []);
    assert.match(logs, /media understanding failed, proceeding with raw content:.*PROOF_UNRELATED_MEDIA_REGISTRY_FAULT/);
  } else {
    assert.equal(faulty.faults, 0);
    const image = faulty.decisions.find((decision) => decision.capability === "image");
    assert.equal(image?.nativeVisionActive, true);
    assert.equal(image.attachmentDispositions[0].kind, "handed-to-native-vision");
    assert.doesNotMatch(logs, /PROOF_UNRELATED_MEDIA_REGISTRY_FAULT/);
  }
  console.log(JSON.stringify({ source: process.env.SOURCE_SHA, expected, modelHttpRequests: requests.length, exactPngSha256: pngSha, healthyFaults: healthy.faults, faultyRegistryFaults: faulty.faults, faultyImageDecision: faulty.decisions.find((decision) => decision.capability === "image") ?? null, finalReply: "NATIVE_IMAGE_OK", proof: "real Gateway reply pipeline and localhost HTTP image bytes; not a cloud model or live channel" }));
} finally {
  if (gateway.exitCode === null) {
    process.kill(-gateway.pid, "SIGTERM");
    const stopped = await Promise.race([gatewayClosed.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 10000))]);
    if (!stopped) { process.kill(-gateway.pid, "SIGKILL"); await gatewayClosed; }
  }
  await new Promise((resolve) => server.close(resolve));
}

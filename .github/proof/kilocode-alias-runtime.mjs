import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const exactHead = process.env.PR_SOURCE_HEAD;
assert.ok(exactHead, "PR_SOURCE_HEAD is required");
const canonicalProvider = "kilocode";
const aliasProvider = "kilo";
const model = "kilo-auto/balanced";

async function runCli(args, env) {
  const child = spawn(process.execPath, [path.resolve("openclaw.mjs"), ...args], {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(code, 0, `openclaw ${args.join(" ")} failed\n${stderr}\n${stdout}`);
  return { stdout, stderr };
}

function listedModel(output, provider) {
  const parsed = JSON.parse(output);
  assert.ok(Array.isArray(parsed.models));
  const key = `${provider}/${model}`;
  assert.ok(parsed.models.some((entry) => entry.key === key), `missing ${key}`);
  return key;
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "kilocode-runtime-proof-"));
const stateDir = path.join(root, "state");
const configPath = path.join(root, "openclaw.json");
const workspace = path.join(root, "workspace");
await fs.mkdir(workspace, { recursive: true });
const requests = [];
const server = http.createServer((request, response) => {
  void (async () => {
    let raw = "";
    for await (const chunk of request) raw += String(chunk);
    const body = JSON.parse(raw);
    requests.push({
      path: new URL(request.url ?? "/", "http://127.0.0.1").pathname,
      authorization: request.headers.authorization,
      routeHeader: request.headers["x-kilocode-proof"],
      model: body.model,
      stream: body.stream,
    });
    const chunk = {
      id: "proof-kilocode",
      object: "chat.completion.chunk",
      created: 1,
      model,
      choices: [{ index: 0, delta: { role: "assistant", content: "ALIAS_OK" }, finish_reason: null }],
    };
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
  })().catch((error) => response.destroy(error));
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

try {
  const address = server.address();
  assert.ok(address && typeof address !== "string", "proof server did not bind");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  await fs.writeFile(
    configPath,
    `${JSON.stringify({
      gateway: { mode: "local" },
      plugins: { slots: { memory: "none" } },
      agents: {
        defaults: {
          workspace,
          skipBootstrap: true,
          skills: [],
          model: { primary: `${canonicalProvider}/${model}` },
        },
      },
    }, null, 2)}\n`,
    "utf8",
  );
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    USERPROFILE: root,
    CI: "1",
    NO_COLOR: "1",
    KILOCODE_API_KEY: "proof-placeholder",
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_TEST_FAST: "1",
  };

  const freshStatus = JSON.parse((await runCli(["models", "status", "--json"], env)).stdout);
  assert.equal(freshStatus.defaultModel, `${canonicalProvider}/${model}`);
  const canonicalListed = listedModel(
    (
      await runCli(
        ["models", "list", "--provider", canonicalProvider, "--refresh", "--json"],
        env,
      )
    ).stdout,
    canonicalProvider,
  );
  const aliasListed = listedModel(
    (
      await runCli(["models", "list", "--provider", aliasProvider, "--refresh", "--json"], env)
    ).stdout,
    aliasProvider,
  );

  const savedAlias = {
    baseUrl,
    api: "openai-completions",
    apiKey: "proof-placeholder",
    headers: { "X-Kilocode-Proof": "saved-alias-route" },
    models: [{
      id: model,
      name: "Proof Kilo Auto",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192,
      maxTokens: 1024,
    }],
  };
  const updates = [
    { path: "models.providers.kilo", value: savedAlias },
    { path: "agents.defaults.model.primary", value: `${aliasProvider}/${model}` },
  ];
  await runCli(["config", "set", "--batch-json", JSON.stringify(updates)], env);

  const readback = JSON.parse(
    (await runCli(["config", "get", "models.providers.kilo", "--json"], env)).stdout,
  );
  assert.equal(readback.baseUrl, baseUrl);
  assert.equal(readback.api, "openai-completions");
  assert.equal(readback.headers["X-Kilocode-Proof"], "saved-alias-route");

  const savedStatus = JSON.parse((await runCli(["models", "status", "--json"], env)).stdout);
  assert.equal(savedStatus.defaultModel, `${aliasProvider}/${model}`);
  listedModel(
    (await runCli(["models", "list", "--provider", aliasProvider, "--json"], env)).stdout,
    aliasProvider,
  );
  listedModel(
    (await runCli(["models", "list", "--provider", canonicalProvider, "--json"], env)).stdout,
    canonicalProvider,
  );

  const agent = await runCli(
    ["agent", "--local", "--agent", "main", "--message", "return alias proof", "--json"],
    env,
  );
  assert.match(agent.stdout, /ALIAS_OK/);
  assert.deepEqual(requests, [{
    path: "/v1/chat/completions",
    authorization: "Bearer proof-placeholder",
    routeHeader: "saved-alias-route",
    model,
    stream: true,
  }]);

  const output = {
    exactHead,
    fresh: {
      defaultModel: freshStatus.defaultModel,
      canonicalListed,
      aliasListed,
    },
    saved: {
      defaultModel: savedStatus.defaultModel,
      baseUrl: readback.baseUrl,
      api: readback.api,
      routeHeader: readback.headers["X-Kilocode-Proof"],
    },
    resolvedTransport: requests[0],
    responseObserved: "ALIAS_OK",
  };
  await fs.mkdir(path.dirname(process.env.PROOF_OUTPUT), { recursive: true });
  await fs.writeFile(process.env.PROOF_OUTPUT, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log(`[behavior-evidence] kilocode-alias-runtime ${JSON.stringify(output)}`);
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}

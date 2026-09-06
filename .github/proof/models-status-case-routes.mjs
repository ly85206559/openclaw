import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const proofHome = mkdtempSync(path.join(os.tmpdir(), "openclaw-model-status-case-proof-"));
const configPath = path.join(proofHome, "openclaw.json");
const stateDir = path.join(proofHome, "state");
const model = (id, name, api, baseUrl) => ({
  id,
  name,
  api,
  baseUrl,
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 1024,
});

writeFileSync(
  configPath,
  JSON.stringify({
    agents: {
      defaults: {
        model: { primary: "openai/Reader", fallbacks: ["openai/reader"] },
        modelPolicy: { allow: ["openai/Reader", "openai/reader"] },
      },
    },
    models: {
      providers: {
        openai: {
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          models: [
            model("Reader", "Reader Platform", "openai-responses", "https://api.openai.com/v1"),
            model(
              "reader",
              "reader ChatGPT",
              "openai-chatgpt-responses",
              "https://chatgpt.com/backend-api/codex",
            ),
          ],
        },
      },
    },
  }),
);

const result = spawnSync(process.execPath, [path.resolve("openclaw.mjs"), "models", "status", "--json"], {
  cwd: process.cwd(),
  encoding: "utf8",
  timeout: 60_000,
  env: {
    PATH: process.env.PATH,
    HOME: proofHome,
    USERPROFILE: proofHome,
    CI: "1",
    NO_COLOR: "1",
    OPENAI_API_KEY: "proof-placeholder",
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_TEST_FAST: "1",
  },
});

assert.equal(result.status, 0, result.stderr || result.stdout);
const payload = JSON.parse(result.stdout);
const issues = payload.auth?.modelRouteIssues ?? [];
const summary = {
  defaultModel: payload.defaultModel,
  fallbacks: payload.fallbacks,
  modelRouteIssues: issues,
};
process.stdout.write(`[behavior-evidence] models-status-case-routes ${JSON.stringify(summary)}\n`);

assert.equal(payload.defaultModel, "openai/Reader");
assert.deepEqual(payload.fallbacks, ["openai/reader"]);
assert.equal(
  issues.some((issue) => issue.provider === "openai" && issue.model === "Reader"),
  false,
  "the Platform Reader route must remain usable with the configured API key",
);
assert.deepEqual(
  issues.filter((issue) => issue.provider === "openai" && issue.model === "reader"),
  [
    {
      kind: "missing-auth",
      provider: "openai",
      model: "reader",
      authRequirement: "subscription",
      message: "No usable subscription authentication is available for openai/reader.",
    },
  ],
);

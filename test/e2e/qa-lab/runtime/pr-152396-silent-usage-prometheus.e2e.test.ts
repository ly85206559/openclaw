import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  createQaGatewayChild,
  startQaMockOpenAiServer,
} from "../../../../extensions/qa-lab/api.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const ARTIFACT_DIR = path.join(REPO_ROOT, ".artifacts/pr-152396-silent-usage-prometheus");
const PRODUCT_HEAD = "853b71ee9b8908dea76a3a54af5fb3087aeeccba";
const MODEL_REF = "mock-openai/gpt-5.6-luna";
const TOKEN_METRIC = "openclaw_model_tokens_total";
const COST_METRIC = "openclaw_model_cost_usd_total";

function metricTotal(scrape: string, metric: string): number {
  return scrape
    .split("\n")
    .filter((line) => line.startsWith(`${metric}{`) || line.startsWith(`${metric} `))
    .reduce((total, line) => {
      const value = Number(line.trim().split(/\s+/u).at(-1));
      return total + (Number.isFinite(value) ? value : 0);
    }, 0);
}

async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) {
      return value;
    }
    await delay(100);
  }
  throw new Error("timed out waiting for silent-turn Prometheus evidence");
}

describe("PR 152396 silent reply usage proof", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    const failures: unknown[] = [];
    for (const cleanup of cleanups.splice(0).toReversed()) {
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "silent usage proof cleanup failed");
    }
  });

  it("keeps an actual Gateway NO_REPLY turn silent while token and cost counters increase", async () => {
    const mock = await startQaMockOpenAiServer();
    cleanups.push(() => mock.stop());
    const owner = createQaGatewayChild();
    cleanups.push(() => stopQaGatewayFixture(owner));
    const gateway = await owner.start({
      repoRoot: REPO_ROOT,
      useRepoCli: true,
      providerMode: "mock-openai",
      providerBaseUrl: `${mock.baseUrl}/v1`,
      primaryModel: MODEL_REF,
      alternateModel: MODEL_REF,
      transportBaseUrl: "http://127.0.0.1:1",
      enabledPluginIds: ["diagnostics-prometheus"],
      controlUiEnabled: false,
      mutateConfig: (config) => {
        const providers = config.models?.providers;
        const provider = providers?.["mock-openai"];
        if (!provider) {
          throw new Error("QA mock-openai provider config is missing");
        }
        return {
          ...config,
          diagnostics: { enabled: true },
          models: {
            ...config.models,
            providers: {
              ...providers,
              "mock-openai": {
                ...provider,
                models: provider.models.map((model) => ({
                  ...model,
                  cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0.5 },
                })),
              },
            },
          },
        };
      },
    });

    const scrape = async () => {
      const response = await fetch(`${gateway.baseUrl}/api/diagnostics/prometheus`, {
        headers: { authorization: `Bearer ${gateway.token}` },
        signal: AbortSignal.timeout(10_000),
      });
      expect(response.status, gateway.logs()).toBe(200);
      return await response.text();
    };
    const before = await scrape();
    const beforeTokens = metricTotal(before, TOKEN_METRIC);
    const beforeCost = metricTotal(before, COST_METRIC);
    const sessionKey = `agent:qa:pr-152396-${randomUUID()}`;
    const started = (await gateway.call("chat.send", {
      sessionKey,
      message: "Return the marker. Reply exactly: NO_REPLY",
      idempotencyKey: randomUUID(),
    })) as { runId?: string; status?: string };
    expect(started.status).toBe("started");
    expect(started.runId).toBeTruthy();
    const completed = (await gateway.call(
      "agent.wait",
      { runId: started.runId, timeoutMs: 60_000 },
      { timeoutMs: 65_000 },
    )) as {
      status?: string;
      terminalReply?: { disposition?: string };
      terminalDelivery?: { status?: string; resultCount?: number };
    };
    expect(completed.status, gateway.logs()).toBe("ok");
    expect(completed.terminalReply).toEqual({ disposition: "silent" });
    if (completed.terminalDelivery) {
      expect(completed.terminalDelivery).toMatchObject({ status: "suppressed", resultCount: 0 });
    }

    const history = (await gateway.call("chat.history", { sessionKey, limit: 20 })) as {
      messages?: Array<{ role?: unknown; content?: unknown }>;
    };
    const assistantMessages = (history.messages ?? []).filter(
      (message) => message.role === "assistant",
    );
    expect(
      assistantMessages,
      "NO_REPLY must not become a visible or persisted assistant reply",
    ).toEqual([]);

    const after = await waitFor(async () => {
      const candidate = await scrape();
      return metricTotal(candidate, TOKEN_METRIC) > beforeTokens &&
        metricTotal(candidate, COST_METRIC) > beforeCost
        ? candidate
        : undefined;
    });
    const afterTokens = metricTotal(after, TOKEN_METRIC);
    const afterCost = metricTotal(after, COST_METRIC);
    const requestsResponse = await fetch(`${mock.baseUrl}/debug/requests?after=0`, {
      signal: AbortSignal.timeout(10_000),
    });
    expect(requestsResponse.ok).toBe(true);
    const requests = (await requestsResponse.json()) as unknown[];
    expect(requests).toHaveLength(1);

    const evidence = {
      productHead: PRODUCT_HEAD,
      boundary:
        "registered chat.send -> mock OpenAI Responses -> reply finalizer -> diagnostics-prometheus",
      runStatus: completed.status,
      terminalReply: completed.terminalReply,
      terminalDelivery: completed.terminalDelivery,
      providerRequests: requests.length,
      assistantMessages: assistantMessages.length,
      visibleReplySuppressed: true,
      tokenCounter: { before: beforeTokens, after: afterTokens, delta: afterTokens - beforeTokens },
      estimatedCostCounter: { before: beforeCost, after: afterCost, delta: afterCost - beforeCost },
    };
    await fs.mkdir(ARTIFACT_DIR, { recursive: true });
    await fs.writeFile(
      path.join(ARTIFACT_DIR, "observed.json"),
      `${JSON.stringify(evidence, null, 2)}\n`,
    );
    await fs.writeFile(path.join(ARTIFACT_DIR, "gateway.log"), gateway.logs());
    process.stdout.write(`${JSON.stringify(evidence)}\n`);
  }, 180_000);
});

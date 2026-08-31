import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import type { OpenClawConfig } from "./src/config/types.openclaw.js";
import { createOpenClawTestInstance } from "./test/helpers/openclaw-test-instance.js";

const label = process.argv[2] ?? "unknown";
const outputPath = process.env.PROOF_OUTPUT;
const sourceHead = process.env.PROOF_SOURCE_HEAD ?? null;
const GATEWAY_TOKEN = "pr-133391-proof-token";
const PROVIDER_ID = "pr-133391-proof";
const MODEL_ID = "proof-model";
const MODEL_REF = `${PROVIDER_ID}/${MODEL_ID}`;
const TOOL_NAME = "get_weather";
const PROVISIONAL_TEXT = "Working...";
const FINAL_TEXT = "Done.";

if (!outputPath) {
  throw new Error("PROOF_OUTPUT is required");
}

async function readJsonRequest(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function writeEvent(response: ServerResponse, event: unknown): void {
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function writeProviderResponse(response: ServerResponse, requestIndex: number): void {
  const message = {
    type: "message",
    id: `msg_pr_133391_${requestIndex}`,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: FINAL_TEXT, annotations: [] }],
  };
  const call = {
    type: "function_call",
    id: `fc_pr_133391_${requestIndex}`,
    call_id: `call_pr_133391_${requestIndex}`,
    name: TOOL_NAME,
    arguments: '{"city":"Taipei"}',
    status: "completed",
  };
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  writeEvent(response, {
    type: "response.output_item.added",
    output_index: 0,
    item: { ...message, status: "in_progress", content: [] },
  });
  writeEvent(response, {
    type: "response.output_text.delta",
    item_id: message.id,
    output_index: 0,
    content_index: 0,
    delta: PROVISIONAL_TEXT,
  });
  writeEvent(response, {
    type: "response.output_text.done",
    item_id: message.id,
    output_index: 0,
    content_index: 0,
    text: FINAL_TEXT,
  });
  writeEvent(response, { type: "response.output_item.done", output_index: 0, item: message });
  writeEvent(response, {
    type: "response.output_item.added",
    output_index: 1,
    item: { ...call, status: "in_progress", arguments: "" },
  });
  writeEvent(response, {
    type: "response.function_call_arguments.done",
    item_id: call.id,
    output_index: 1,
    arguments: call.arguments,
  });
  writeEvent(response, { type: "response.output_item.done", output_index: 1, item: call });
  writeEvent(response, {
    type: "response.completed",
    response: {
      id: `resp_pr_133391_${requestIndex}`,
      status: "completed",
      output: [message, call],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    },
  });
  response.end("data: [DONE]\n\n");
}

async function startProvider() {
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method === "GET" && request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: MODEL_ID, object: "model" }] }));
        return;
      }
      if (request.method === "POST" && request.url === "/v1/responses") {
        requests.push(await readJsonRequest(request));
        writeProviderResponse(response, requests.length);
        return;
      }
      response.writeHead(404).end();
    })().catch((error: unknown) => {
      response.writeHead(500).end(error instanceof Error ? error.message : String(error));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("proof provider did not bind");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function parseSse(raw: string): Array<Record<string, unknown>> {
  return raw.split(/\r?\n\r?\n/u).flatMap((block) => {
    const data = block
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trim())
      .join("\n");
    if (!data || data === "[DONE]") {
      return [];
    }
    return [JSON.parse(data) as Record<string, unknown>];
  });
}

function readCompletedText(event: Record<string, unknown>): string | undefined {
  const response = event.response as Record<string, unknown> | undefined;
  const output = response?.output as Array<Record<string, unknown>> | undefined;
  const message = output?.find((item) => item.type === "message");
  const content = message?.content as Array<Record<string, unknown>> | undefined;
  return content?.find((item) => item.type === "output_text")?.text as string | undefined;
}

async function runClientRequest(origin: string, toolChoice: unknown) {
  const response = await fetch(`${origin}/v1/responses`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${GATEWAY_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "openclaw/main",
      stream: true,
      input: "Check the weather and call the provided client tool.",
      tools: [
        {
          type: "function",
          name: TOOL_NAME,
          description: "Get weather",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      ],
      tool_choice: toolChoice,
    }),
  });
  const raw = await response.text();
  if (response.status !== 200) {
    throw new Error(`Gateway returned ${response.status}: ${raw}`);
  }
  const events = parseSse(raw);
  const completed = events.find((event) => event.type === "response.completed");
  if (!completed) {
    throw new Error(`missing response.completed: ${raw}`);
  }
  const output = (completed.response as Record<string, unknown>).output as Array<
    Record<string, unknown>
  >;
  return {
    raw,
    eventTypes: events.map((event) => event.type),
    deltas: events
      .filter((event) => event.type === "response.output_text.delta")
      .map((event) => event.delta),
    completedText: readCompletedText(completed),
    functionCallName: output.find((item) => item.type === "function_call")?.name,
  };
}

const provider = await startProvider();
const instance = await createOpenClawTestInstance({
  name: `pr-133391-${label}`,
  gatewayToken: GATEWAY_TOKEN,
  config: {
    gateway: {
      auth: { mode: "token", token: GATEWAY_TOKEN },
      controlUi: { enabled: false },
      http: { endpoints: { responses: { enabled: true } } },
    },
    agents: {
      defaults: {
        workspace: path.join(process.cwd(), `.tmp-pr-133391-workspace-${label}`),
        model: { primary: MODEL_REF },
        models: {
          [MODEL_REF]: {
            agentRuntime: { id: "openclaw" },
            params: { transport: "sse", openaiWsWarmup: false },
          },
        },
        skills: [],
        skipBootstrap: true,
      },
      list: [{ id: "main", default: true, model: { primary: MODEL_REF }, skills: [] }],
    },
    models: {
      mode: "replace",
      providers: {
        [PROVIDER_ID]: {
          baseUrl: `${provider.baseUrl}/v1`,
          apiKey: "proof-provider-token",
          api: "openai-responses",
          request: { allowPrivateNetwork: true },
          models: [
            {
              id: MODEL_ID,
              name: MODEL_ID,
              api: "openai-responses",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 32_000,
              maxTokens: 2_048,
            },
          ],
        },
      },
    },
    plugins: { slots: { memory: "none" } },
    tools: { profile: "minimal" },
  } satisfies OpenClawConfig,
  env: {
    OPENCLAW_SKIP_PROVIDERS: undefined,
    OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
  },
});

try {
  await instance.startGateway();
  const gatewayUrl = new URL(instance.url);
  gatewayUrl.protocol = gatewayUrl.protocol === "wss:" ? "https:" : "http:";
  const required = await runClientRequest(gatewayUrl.origin, "required");
  const pinned = await runClientRequest(gatewayUrl.origin, {
    type: "function",
    name: TOOL_NAME,
  });
  const providerToolNames = provider.requests.map((request) =>
    ((request.tools as Array<Record<string, unknown>> | undefined) ?? []).map((tool) => tool.name),
  );
  const result = {
    label,
    sourceHead,
    checkoutHead: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    transport: "real loopback Gateway HTTP -> configured OpenClaw agent -> Responses provider",
    providerRequestCount: provider.requests.length,
    providerToolNames,
    required,
    pinned,
  };
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(instance.logs());
  throw error;
} finally {
  await instance.cleanup();
  await provider.close();
}

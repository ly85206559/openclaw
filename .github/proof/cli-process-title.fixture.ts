import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { text } from "node:stream/consumers";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { withRegisteredChannelIngress } from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import type { ChannelInboundTurnPlan } from "openclaw/plugin-sdk/channel-inbound";
import type { GetReplyOptions } from "openclaw/plugin-sdk/reply-runtime";
import { discordPlugin } from "../../../extensions/discord/api.js";
import { createDiscordMessageHandler, createNoopThreadBindingManager, setDiscordRuntime } from "../../../extensions/discord/runtime-api.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { buildPreparedCliRunContext } from "../../agents/cli-runner.test-helpers.js";
import { executePreparedCliRun } from "../../agents/cli-runner/execute.js";
import { admitCliRunParams } from "../../agents/cli-runner/run-admission.js";
import type { RunCliAgentParams } from "../../agents/cli-runner/types.js";
import type { CliBackendExecute } from "../../plugins/cli-backend.types.js";
import {
  createAgentTurnExecutionDefaults,
  setupAgentRunnerExecutionTestState,
  getExecuteAgentTurnForTest,
  createMockTypingSignaler,
  createFollowupRun,
  runInitialFallbackAttempt,
  type FallbackRunnerParams,
} from "./agent-runner-execution.test-support.js";
import { attachProgressNarratorToReplyOptions } from "./progress-narrator.js";
import type { ProgressNarrationInput } from "./progress-narrator-model.js";

const narrationModelMocks = vi.hoisted(() => ({ prepare: vi.fn(), generate: vi.fn(), reply: vi.fn<NonNullable<ChannelInboundTurnPlan["replyResolver"]>>() }));
// The actual registered channel owner, request authority and compositor remain
// intact. Only agent selection/storage, utility model and REST transport are isolated.
vi.mock("./progress-narrator-model.js", () => ({
  prepareNarrationModel: narrationModelMocks.prepare,
  generateNarrationWithUtilityModel: narrationModelMocks.generate,
}));
vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>();
  return {
    ...actual,
    dispatchChannelInboundTurn: (plan: ChannelInboundTurnPlan) =>
      actual.dispatchChannelInboundTurn({ ...plan, replyResolver: narrationModelMocks.reply }),
  };
});

const state = await setupAgentRunnerExecutionTestState();
const executeAgentTurn = await getExecuteAgentTurnForTest();

const fixtureSource = `
const { spawnSync } = require("node:child_process");
const name = process.argv[2];
const command = "/bin/sh -c false";
const result = spawnSync("/bin/sh", ["-c", "false"], { encoding: "utf8" });
if (result.error) throw result.error;
if (result.status !== 1) throw new Error("Expected actual native exit 1");
process.stderr.write(JSON.stringify({
  fixturePid: process.pid, nativePid: result.pid, command,
  nativeExit: result.status, nativeSignal: result.signal,
  nativeStdout: result.stdout, nativeStderr: result.stderr,
}) + "\\n");
for (const event of [
  { type: "assistant", message: { content: [{ type: "tool_use", id: "status-check", name,
    input: { command, title: "Check build status" } }] } },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "status-check",
    is_error: result.status !== 0, content: "Native command exited " + result.status }] } },
  { type: "result", subtype: "success", result: "The status check failed." },
]) process.stdout.write(JSON.stringify(event) + "\\n");
`;

describe("physical CLI process to registered failure narration", () => {
  it.each(["mcp__openclaw__exec", "mcp_openclaw_exec", "exec"])(
    "preserves %s authored title after an actual native failure",
    async (name) => {
      const provider = "claude-cli";
      const model = "claude-opus-4-6";
      state.isCliProviderMock.mockReturnValue(true);
      state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
        result: await runInitialFallbackAttempt(params, provider, model),
        provider, model, attempts: [],
      }));
      const followupRun = createFollowupRun();
      followupRun.run.provider = provider;
      followupRun.run.model = model;
      followupRun.run.timeoutMs = 30_000;
      const fixturePath = path.join(followupRun.run.workspaceDir, "native-cli-fixture.cjs");
      await fs.writeFile(fixturePath, fixtureSource);
      const stage = (phase: string, detail?: unknown) =>
        console.info("PHYSICAL_CLI_STAGE", JSON.stringify({ name, phase, detail }));
      stage("fixture-ready");
      const observedInput = createDeferred<ProgressNarrationInput>();
      const narrationDelivered = createDeferred<void>();
      const receipts: Array<{ pid?: number; code: number | null; stderr: string; argv: string[] }> = [];
      onTestFinished(() => {
        narrationModelMocks.prepare.mockReset();
        narrationModelMocks.generate.mockReset();
        narrationModelMocks.reply.mockReset();
      });
      narrationModelMocks.prepare.mockResolvedValue({ provider: "openai", model: "test-utility" });
      narrationModelMocks.generate.mockImplementation(async ({ input }: { input: ProgressNarrationInput }) => {
        stage("narration-input", { activityNotes: input.activityNotes });
        const failedNote = input.activityNotes.find((note) => note.endsWith(": failed"));
        if (failedNote) observedInput.resolve(input);
        return { text: failedNote ? `Fixture failure narration: ${failedNote}` : "Fixture working." };
      });
      let registeredOptions: GetReplyOptions | undefined;
      const restReceipts: Array<{ method: string; route: string; content?: string }> = [];
      const channelId = "101010101010101010";
      const userId = "202020202020202020";
      const fetchFixture: typeof fetch = async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.origin !== "https://discord.com" || !url.pathname.startsWith(`/api/v10/channels/${channelId}/`)) {
          throw new Error(`Unexpected proof transport request: ${url.origin}${url.pathname}`);
        }
        const method = init?.method ?? "GET";
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
        restReceipts.push({ method, route: url.pathname, content: body.content });
        if (typeof body.content === "string" && body.content.includes("Fixture failure narration:")) {
          narrationDelivered.resolve();
        }
        if (method === "POST" && url.pathname.endsWith("/messages")) {
          return Response.json({ id: "303030303030303030", channel_id: channelId });
        }
        if ((method === "PATCH" || method === "DELETE") && url.pathname.includes("/messages/")) {
          return new Response(null, { status: 204 });
        }
        if (method === "POST" && url.pathname.endsWith("/typing")) return new Response(null, { status: 204 });
        throw new Error(`Unexpected proof route: ${method} ${url.pathname}`);
      };
      vi.stubGlobal("fetch", fetchFixture);
      onTestFinished(() => vi.unstubAllGlobals());

      const execute: CliBackendExecute = async function* (context) {
        stage("native-spawn", { command: context.command, args: context.args });
        const child = spawn(context.command, context.args, {
          cwd: context.cwd, env: context.env, signal: context.abortSignal,
          killSignal: "SIGKILL", stdio: ["ignore", "pipe", "pipe"],
        });
        const completion = once(child, "close");
        const stderr = text(child.stderr);
        const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
        try {
          for await (const line of lines) {
            const event: unknown = JSON.parse(line);
            if (typeof event !== "object" || event === null || Array.isArray(event)) {
              throw new Error("Fixture child emitted an invalid event");
            }
            yield event as Record<string, unknown>;
          }
          const [code] = await completion;
          receipts.push({ pid: child.pid, code, stderr: await stderr, argv: [context.command, ...context.args] });
          stage("native-complete", { code, pid: child.pid });
          if (code !== 0) throw new Error(`Fixture CLI exited with code ${code}`);
        } finally {
          lines.close();
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
          await completion;
        }
      };
      state.runCliAgentMock.mockImplementationOnce(async (params: RunCliAgentParams) => {
        stage("prepared-execution-entry");
        const admittedParams = await admitCliRunParams(params, params.agentId ?? "main");
        stage("prepared-admission-complete");
        const context = buildPreparedCliRunContext({
          provider, model, runId: params.runId, workspaceDir: params.workspaceDir,
          backend: {
            command: process.execPath, args: [fixturePath, name],
            modelArg: undefined, sessionArgs: undefined, systemPromptFileArg: undefined,
            input: "stdin", output: "jsonl", jsonlDialect: "claude-stream-json",
          },
        });
        context.params = { ...context.params, ...admittedParams };
        context.backendResolved.bundleMcp = false;
        context.executionTarget = { kind: "plugin", execute };
        let result;
        try {
          result = await executePreparedCliRun(context);
        } catch (error) {
          stage("prepared-execution-error", error instanceof Error ? error.message : String(error));
          throw error;
        }
        stage("prepared-execution-complete");
        return { payloads: [{ text: result.text }], meta: {} };
      });
      await withOpenClawTestState({ prefix: "registered-discord-cli-proof-" }, async (testState) => {
        const cfg = {
          agents: { defaults: { workspace: testState.workspaceDir, utilityModel: "openai/test-utility" } },
          messages: { inbound: { debounceMs: 0 }, ackReaction: "", statusReactions: { enabled: false } },
          channels: { discord: {
            enabled: true, token: "fixture-token", dm: { enabled: true },
            dmPolicy: "allowlist" as const, allowFrom: [userId],
            streaming: { mode: "progress" as const, progress: { narration: true, toolProgress: true, commandText: "details" as const } },
          } },
        };
        await testState.writeConfig(cfg);
        await withRegisteredChannelIngress({ plugin: discordPlugin, config: cfg, setRuntime: setDiscordRuntime }, async () => {
          const replyComplete = createDeferred<void>();
          narrationModelMocks.reply.mockImplementationOnce(async (ctx, replyOptions) => {
            registeredOptions = replyOptions;
            expect(replyOptions?.onNarrationUpdate).toBeTypeOf("function");
            expect(replyOptions?.narrationHideCommandText).not.toBe(true);
            const opts = attachProgressNarratorToReplyOptions({ cfg, agentId: "main", userMessage: "Check the build status", opts: replyOptions });
            followupRun.run.config = cfg;
            followupRun.run.sessionKey = ctx.SessionKey;
            const outcome = await executeAgentTurn({
              commandBody: "Check the build status", followupRun, sessionCtx: ctx,
              opts, typingSignals: createMockTypingSignaler(), ...createAgentTurnExecutionDefaults(), sessionKey: ctx.SessionKey,
            });
            stage("turn-complete", { kind: outcome.kind, receipts: receipts.length, cliCalls: state.runCliAgentMock.mock.calls.length });
            expect(outcome.kind).toBe("success");
            expect(receipts).toHaveLength(1);
            stage("await-registered-discord-narration");
            await observedInput.promise;
            await narrationDelivered.promise;
            replyComplete.resolve();
            return { text: "The status check failed." };
          });
          const client = {
            fetchChannel: async (id: string) => ({ id, type: 1 }),
            rest: { get: async () => ({}) },
          } as unknown as Parameters<typeof createDiscordMessageHandler>[0]["client"];
          const handler = createDiscordMessageHandler({
            cfg, discordConfig: cfg.channels.discord, client, accountId: "default", token: "fixture-token",
            botUserId: "404040404040404040", runtime: { log: console.info, error: (message) => {
              stage("registered-discord-error", message);
              replyComplete.reject(new Error(String(message)));
            }, exit: (code) => { throw new Error(`Unexpected runtime exit ${code}`); } },
            dmEnabled: true, dmPolicy: "allowlist", allowFrom: [userId], groupDmEnabled: false,
            guildHistories: new Map(), historyLimit: 0, mediaMaxBytes: 10_000, textLimit: 2_000,
            replyToMode: "off", threadBindings: createNoopThreadBindingManager("default"),
          });
          try {
            stage("registered-discord-ingress");
            await handler({
              id: "505050505050505050", channel_id: channelId, content: "Check the build status",
              author: { id: userId, username: "fixture-user", discriminator: "0", avatar: null, bot: false },
              attachments: [], embeds: [], mentions: [], mention_roles: [], mention_everyone: false,
              timestamp: new Date().toISOString(), edited_timestamp: null, components: [], pinned: false, type: 0, tts: false,
            });
            await replyComplete.promise;
          } finally { await handler.deactivate(); }
        });
      });
      const input = await observedInput.promise;
      console.info("PHYSICAL_CLI_NARRATION_RECEIPT", JSON.stringify({
        name, process: receipts, registeredNarration: typeof registeredOptions?.onNarrationUpdate,
        activityNotes: input.activityNotes, discordRest: restReceipts,
        isolated: ["selection", "agent-persistence", "utility-model", "REST-transport"],
      }));
      expect(receipts).toHaveLength(1);
      expect(receipts[0]?.code).toBe(0);
      expect(receipts[0]?.pid).toBeGreaterThan(0);
      const native: unknown = JSON.parse(receipts[0]?.stderr ?? "");
      expect(native).toMatchObject({ nativeExit: 1, command: "/bin/sh -c false", nativeStdout: "", nativeStderr: "" });
      expect(input.activityNotes).toContain("Check build status: failed");
      expect(restReceipts.some((receipt) => receipt.content?.includes("Fixture failure narration:"))).toBe(true);
    },
  );
});

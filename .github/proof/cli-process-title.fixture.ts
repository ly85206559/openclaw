import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { text } from "node:stream/consumers";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { buildPreparedCliRunContext } from "../../agents/cli-runner.test-helpers.js";
import { executePreparedCliRun } from "../../agents/cli-runner/execute.js";
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

const narrationModelMocks = vi.hoisted(() => ({ prepare: vi.fn(), generate: vi.fn() }));
// Only process/event/projector/narrator consumption is claimed. Selection,
// persistence, utility model and channel transport remain isolated test doubles.
vi.mock("./progress-narrator-model.js", () => ({
  prepareNarrationModel: narrationModelMocks.prepare,
  generateNarrationWithUtilityModel: narrationModelMocks.generate,
}));

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
      const observedInput = createDeferred<ProgressNarrationInput>();
      const narrationDelivered = createDeferred<void>();
      const controller = new AbortController();
      const receipts: Array<{ pid?: number; code: number | null; stderr: string; argv: string[] }> = [];
      onTestFinished(() => {
        controller.abort();
        narrationModelMocks.prepare.mockReset();
        narrationModelMocks.generate.mockReset();
      });
      narrationModelMocks.prepare.mockResolvedValue({ provider: "openai", model: "test-utility" });
      narrationModelMocks.generate.mockImplementation(async ({ input }: { input: ProgressNarrationInput }) => {
        observedInput.resolve(input);
        return { text: "The status check failed." };
      });
      const onNarrationUpdate = vi.fn(() => narrationDelivered.resolve());
      const opts = attachProgressNarratorToReplyOptions({
        cfg: { agents: { defaults: { utilityModel: "openai/test-utility" } } },
        agentId: "main",
        userMessage: "Check the build status",
        opts: { onNarrationUpdate, abortSignal: controller.signal },
      });
      if (!opts) throw new Error("Expected registered narrator options");

      const execute: CliBackendExecute = async function* (context) {
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
          if (code !== 0) throw new Error(`Fixture CLI exited with code ${code}`);
        } finally {
          lines.close();
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
          await completion;
        }
      };
      state.runCliAgentMock.mockImplementationOnce(async (params: RunCliAgentParams) => {
        const context = buildPreparedCliRunContext({
          provider, model, runId: params.runId, workspaceDir: params.workspaceDir,
          backend: {
            command: process.execPath, args: [fixturePath, name],
            modelArg: undefined, sessionArgs: undefined, systemPromptFileArg: undefined,
            input: "stdin", output: "jsonl", jsonlDialect: "claude-stream-json",
          },
        });
        context.params = { ...context.params, ...params };
        context.backendResolved.bundleMcp = false;
        context.executionTarget = { kind: "plugin", execute };
        const result = await executePreparedCliRun(context);
        return { payloads: [{ text: result.text }], meta: {} };
      });
      const outcome = await executeAgentTurn({
        commandBody: "Check the build status", followupRun,
        sessionCtx: { Provider: "webchat", MessageSid: "fixture-message" },
        opts, typingSignals: createMockTypingSignaler(), ...createAgentTurnExecutionDefaults(),
      });
      const input = await observedInput.promise;
      await narrationDelivered.promise;
      console.info("PHYSICAL_CLI_NARRATION_RECEIPT", JSON.stringify({
        name, process: receipts, outcome: outcome.kind,
        activityNotes: input.activityNotes, narrationUpdate: onNarrationUpdate.mock.calls[0]?.[0],
        isolated: ["selection", "persistence", "utility-model", "channel-transport"],
      }));
      expect(receipts).toHaveLength(1);
      expect(receipts[0]?.code).toBe(0);
      expect(receipts[0]?.pid).toBeGreaterThan(0);
      const native: unknown = JSON.parse(receipts[0]?.stderr ?? "");
      expect(native).toMatchObject({ nativeExit: 1, command: "/bin/sh -c false", nativeStdout: "", nativeStderr: "" });
      expect(input.activityNotes).toEqual(["Check build status: failed"]);
      expect(onNarrationUpdate).toHaveBeenCalledWith({ text: "The status check failed." });
    },
  );
});

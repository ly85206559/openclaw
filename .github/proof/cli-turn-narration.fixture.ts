import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createCliJsonlStreamingParser } from "../../agents/cli-output-stream.js";
import { createCliEventHandlers } from "../../agents/cli-runner/execute-events.js";
import { buildContext } from "../../agents/cli-runner/execute-events.tool-result-args.test-support.js";
import { createCliToolTracking } from "../../agents/cli-runner/execute-tool-tracking.js";
import type { RunCliAgentParams } from "../../agents/cli-runner/types.js";
import {
  createAgentTurnExecutionDefaults,
  setupAgentRunnerExecutionTestState,
  getExecuteAgentTurnForTest,
  createMockTypingSignaler,
  createFollowupRun,
  runInitialFallbackAttempt,
} from "./agent-runner-execution.test-support.js";
import type { FallbackRunnerParams } from "./agent-runner-execution.test-support.js";
import type { InternalGetReplyOptions } from "./get-reply.types.js";
import { attachProgressNarratorToReplyOptions } from "./progress-narrator.js";
import type { ProgressNarrationInput } from "./progress-narrator-model.js";

const narrationModelMocks = vi.hoisted(() => ({ prepare: vi.fn(), generate: vi.fn() }));
// External utility credentials and provider execution stay outside this wire fixture.
vi.mock("./progress-narrator-model.js", () => ({
  prepareNarrationModel: narrationModelMocks.prepare,
  generateNarrationWithUtilityModel: narrationModelMocks.generate,
}));

const state = await setupAgentRunnerExecutionTestState();
const executeAgentTurn = await getExecuteAgentTurnForTest();

describe("production CLI-turn narration boundary", () => {
  it.each(["mcp__openclaw__exec", "mcp_openclaw_exec", "exec"])(
    "carries %s authored failure titles through the CLI turn into narration",
    async (name) => {
      const provider = "claude-cli";
      const model = "claude-opus-4-6";
      state.isCliProviderMock.mockReturnValue(true);
      state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
        result: await runInitialFallbackAttempt(params, provider, model),
        provider,
        model,
        attempts: [],
      }));
      const followupRun = createFollowupRun();
      followupRun.run.provider = provider;
      followupRun.run.model = model;
      const observedInput = createDeferred<ProgressNarrationInput>();
      const narrationDelivered = createDeferred<void>();
      const controller = new AbortController();
      onTestFinished(() => {
        controller.abort();
        narrationModelMocks.prepare.mockReset();
        narrationModelMocks.generate.mockReset();
      });
      narrationModelMocks.prepare.mockResolvedValue({ provider: "openai", model: "test-utility" });
      narrationModelMocks.generate.mockImplementation(
        async ({ input }: { input: ProgressNarrationInput }) => {
          observedInput.resolve(input);
          return { text: "The status check failed." };
        },
      );
      const onNarrationUpdate = vi.fn<NonNullable<InternalGetReplyOptions["onNarrationUpdate"]>>(
        () => narrationDelivered.resolve(),
      );
      const opts = attachProgressNarratorToReplyOptions({
        cfg: { agents: { defaults: { utilityModel: "openai/test-utility" } } },
        agentId: "main",
        userMessage: "Check the build status",
        // The production narrator supplies the missing command callback itself.
        opts: { onNarrationUpdate, abortSignal: controller.signal },
      });
      if (!opts) {
        throw new Error("Expected attached narration options");
      }
      state.runCliAgentMock.mockImplementationOnce(async (params: RunCliAgentParams) => {
        const context = buildContext(params.runId);
        context.params = { ...context.params, ...params };
        const events = createCliEventHandlers({
          context,
          toolTracking: createCliToolTracking(context),
          getRunState: () => ({ failed: false, error: undefined }),
        });
        const parser = createCliJsonlStreamingParser({
          backend: { command: "local-cli", output: "jsonl", jsonlDialect: "claude-stream-json" },
          providerId: provider,
          onAssistantDelta: events.emitCliAssistantDelta,
          onToolUseStart: events.emitParsedToolUseStart,
          onToolResult: events.emitParsedToolResult,
        });
        parser.push(
          [
            JSON.stringify({
              type: "assistant",
              message: {
                content: [{ type: "tool_use", id: "status-check", name,
                  input: { command: "date -u", title: "Check build status" } }],
              },
            }),
            JSON.stringify({
              type: "user",
              message: {
                content: [{ type: "tool_result", tool_use_id: "status-check",
                  is_error: true, content: "Synthetic command failure" }],
              },
            }),
            JSON.stringify({ type: "result", result: "The check failed." }),
            "",
          ].join("\n"),
        );
        parser.finish();
        return { payloads: [{ text: parser.getOutput()?.text ?? "" }], meta: {} };
      });
      await executeAgentTurn({
        commandBody: "hi",
        followupRun,
        sessionCtx: { Provider: "telegram", MessageSid: "msg" },
        opts,
        typingSignals: createMockTypingSignaler(),
        ...createAgentTurnExecutionDefaults(),
      });
      const input = await observedInput.promise;
      await narrationDelivered.promise;
      console.info("CLI_TURN_NARRATION_RECEIPT", JSON.stringify({
        name, userMessage: input.userMessage, activityNotes: input.activityNotes,
        narrationUpdate: onNarrationUpdate.mock.calls[0]?.[0],
      }));
      expect(input.userMessage).toBe("Check the build status");
      expect(input.activityNotes).toEqual(["Check build status: failed"]);
      expect(onNarrationUpdate).toHaveBeenCalledWith({ text: "The status check failed." });
    },
  );
});

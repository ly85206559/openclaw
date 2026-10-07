// Temporary fork-only proof; place at extensions/voice-call/src/providers/mock.runtime-proof.test.ts.
import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it, vi } from "vitest";
import { CallManager } from "../manager.js";
import {
  createTestStorePath,
  installVoiceCallStateRuntimeForTests,
  registerTestManagerCleanup,
} from "../manager.test-harness.js";
import { createVoiceCallBaseConfig } from "../test-fixtures.js";
import type { NormalizedEvent } from "../types.js";
import { VoiceCallWebhookServer } from "../webhook.js";
import { MockProvider } from "./mock.js";

const admitsInbound = process.env.MOCK_CALL_PROOF_EXPECT_ADMISSION === "1";
if (!["0", "1"].includes(process.env.MOCK_CALL_PROOF_EXPECT_ADMISSION ?? "")) {
  throw new Error("Set MOCK_CALL_PROOF_EXPECT_ADMISSION=0 for baseline or 1 for fixed");
}

describe("real mock voice-call HTTP webhook boundary", () => {
  it.each(["open", "disabled"] as const)("observes %s policy through the HTTP server", async (policy) => {
    installVoiceCallStateRuntimeForTests();
    const config = createVoiceCallBaseConfig();
    config.serve.port = 0;
    config.inboundPolicy = policy;
    const provider = new MockProvider();
    const hangup = vi.spyOn(provider, "hangupCall");
    const greetingFinished = Promise.withResolvers<void>();
    const realStartListening = provider.startListening.bind(provider);
    vi.spyOn(provider, "startListening").mockImplementation(async (input) => {
      await realStartListening(input);
      if (input.providerCallId === "mock-open-call.answered") {
        greetingFinished.resolve();
      }
    });
    const manager = registerTestManagerCleanup(new CallManager(config, createTestStorePath()));
    const server = new VoiceCallWebhookServer(
      createTestPluginServiceScheduler(),
      config,
      manager,
      provider,
    );
    try {
      const url = await server.start();
      await manager.initialize(provider, url);
      async function post(event: NormalizedEvent) {
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ event }),
        });
        const body = await response.text();
        expect(response.status).toBe(200);
        expect(body).toBe("OK");
      }

      for (const [type, expectedState] of [
        ["call.initiated", "ringing"],
        ["call.ringing", "ringing"],
        ["call.answered", "listening"],
        ["call.active", "active"],
      ] as const) {
        const providerCallId = `mock-${policy}-${type}`;
        const event: NormalizedEvent = {
          id: `${providerCallId}-event`,
          type,
          callId: providerCallId,
          providerCallId,
          timestamp: Date.now(),
          direction: "inbound",
          from: "+15552222222",
          to: "+15553333333",
        };
        const hangupsBefore = hangup.mock.calls.length;
        await post(event);
        if (policy === "open" && admitsInbound && type === "call.answered") {
          await greetingFinished.promise;
        }
        const record = await manager.getCallFromMemoryOrStore(providerCallId);
        const admitted = manager.getActiveCalls().length;
        console.log("MOCK_CALL_HTTP_PROOF", JSON.stringify({
          policy, type, admitted, hangups: hangup.mock.calls.length,
          record: record && {
            provider: record.provider, direction: record.direction,
            from: record.from, to: record.to, state: record.state,
          },
        }));
        expect(admitted).toBe(policy === "open" && admitsInbound ? 1 : 0);
        if (policy === "disabled") {
          expect(hangup.mock.calls.length - hangupsBefore).toBe(admitsInbound ? 1 : 0);
          if (admitsInbound) {
            expect(hangup.mock.calls.at(-1)?.[0]).toMatchObject({
              providerCallId,
              reason: "hangup-bot",
            });
          }
        }
        if (policy === "open" && admitsInbound) {
          expect(record).toMatchObject({
            provider: "mock", direction: "inbound", from: event.from, to: event.to,
            state: expectedState,
          });
          await post({ ...event, id: `${event.id}-end`, type: "call.ended", reason: "completed" });
          expect(manager.getActiveCalls()).toEqual([]);
          expect(await manager.getCallFromMemoryOrStore(providerCallId)).toMatchObject({
            direction: "inbound", state: "completed", endReason: "completed",
          });
        }
      }

      // Existing outbound ownership must not be rewritten by inbound-shaped mock callbacks.
      const outbound = await manager.initiateCall("+15554444444", undefined, { mode: "conversation" });
      expect(outbound.success).toBe(true);
      const original = manager.getCall(outbound.callId);
      if (!original?.providerCallId) {
        throw new Error("expected the real manager to track the outbound mock call");
      }
      const providerCallId = original.providerCallId;
      await post({
        id: `outbound-control-${policy}`, type: "call.answered", callId: outbound.callId,
        providerCallId, timestamp: Date.now(), direction: "inbound",
        from: "+15550009999", to: "+15550008888",
      });
      expect(manager.getCall(outbound.callId)).toMatchObject({
        direction: "outbound", from: config.fromNumber, to: "+15554444444", state: "answered",
      });
      await post({
        id: `outbound-end-${policy}`, type: "call.ended", callId: outbound.callId,
        providerCallId, timestamp: Date.now(), reason: "completed",
      });
      expect(manager.getActiveCalls()).toEqual([]);

      for (const omitted of ["direction", "providerCallId"] as const) {
        const providerId = `missing-${policy}-${omitted}`;
        await post({
          id: providerId, type: "call.initiated", callId: providerId,
          providerCallId: providerId, timestamp: Date.now(), direction: "inbound",
          from: "+15552222222", to: "+15553333333", [omitted]: undefined,
        });
        expect(manager.getActiveCalls()).toEqual([]);
      }
      console.log("MOCK_CALL_HTTP_CONTROLS", JSON.stringify({
        policy, outboundOwnership: "preserved", missingFacts: "not admitted", activeCalls: 0,
      }));
    } finally {
      await server.stop();
    }
  });
});

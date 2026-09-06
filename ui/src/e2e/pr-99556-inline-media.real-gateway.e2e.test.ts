import { writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveStorePath, upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { appendSessionTranscriptMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import { expect, it } from "vitest";
import { resolveQaGatewayChildCommand } from "../../../extensions/qa-lab/src/gateway-child-command.ts";
import { createQaLiveLaneGateway } from "../../../extensions/qa-lab/src/live-transports/shared/live-gateway.runtime.ts";
import { controlUiSessionUrl } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const EXACT_PR_HEAD = "1e9b2e9e03df1b0b106392fcc394c0856f0c66a9";
const INLINE_DATA_URL = `data:image/png;base64,${Buffer.from("responses-history-proof").toString("base64")}`;
const SESSION_ID = "pr-99556-connected-proof";
const SESSION_KEY = "agent:qa:pr-99556-connected-proof";
const captureProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";

const suite = createControlUiE2eSuite({
  name: "PR 99556 inline media with a real Gateway",
  startServerBeforeBrowser: true,
});

suite.define(() => {
  it(
    "redacts stored Responses media in a connected Control UI",
    { timeout: 180_000 },
    async () => {
      const gatewayOwner = createQaLiveLaneGateway();
      const proofDir = suite.artifactDir;
      const gateway = await gatewayOwner.start({
        repoRoot: process.cwd(),
        command: {
          ...resolveQaGatewayChildCommand(process.cwd()),
          usePackagedPlugins: false,
        },
        providerMode: "mock-openai",
        primaryModel: "mock-openai/gpt-5.6-luna",
        alternateModel: "mock-openai/gpt-5.6-luna-alt",
        transport: { requiredPluginIds: [], createGatewayConfig: () => ({}) },
        transportBaseUrl: "http://127.0.0.1",
        controlUiAllowedOrigins: [new URL(suite.server.baseUrl).origin],
        controlUiEnabled: false,
      });
      const env = {
        ...process.env,
        OPENCLAW_STATE_DIR: path.join(gateway.gateway.tempRoot, "state"),
      };
      try {
        const storePath = resolveStorePath(undefined, { agentId: "qa", env });
        await upsertSessionEntry({
          agentId: "qa",
          env,
          sessionKey: SESSION_KEY,
          storePath,
          entry: { sessionId: SESSION_ID, updatedAt: Date.now() },
        });
        await appendSessionTranscriptMessageByIdentity({
          agentId: "qa",
          env,
          sessionId: SESSION_ID,
          sessionKey: SESSION_KEY,
          storePath,
          message: {
            role: "user",
            timestamp: Date.now(),
            content: [
              { type: "input_text", text: "Stored Responses image" },
              { type: "input_image", image_url: INLINE_DATA_URL },
            ],
          } as never,
        });
        const historyBefore = await gateway.gateway.call("chat.history", {
          sessionKey: SESSION_KEY,
          limit: 10,
        });
        const serializedHistory = JSON.stringify(historyBefore);
        expect(serializedHistory).toContain('"type":"input_image"');
        expect(serializedHistory).toContain('"omitted":true');
        expect(serializedHistory).not.toContain(INLINE_DATA_URL);

        await suite.withPage(
          {
            locale: "en-US",
            permissions: ["local-network-access"],
            serviceWorkers: "block",
            viewport: { width: 1280, height: 900 },
            ...(captureProof
              ? { recordVideo: { dir: proofDir, size: { width: 1280, height: 900 } } }
              : {}),
          },
          async ({ page }) => {
            const pageErrors: string[] = [];
            page.on("pageerror", (error) => pageErrors.push(error.message));
            await page.addInitScript(
              ({ gatewayUrl, token }) => {
                (
                  window as Window & {
                    __OPENCLAW_NATIVE_CONTROL_AUTH__?: { gatewayUrl: string; token: string };
                  }
                )["__OPENCLAW_NATIVE_CONTROL_AUTH__"] = { gatewayUrl, token };
              },
              { gatewayUrl: gateway.gateway.wsUrl, token: gateway.gateway.token },
            );
            await page.goto(controlUiSessionUrl(suite.server.baseUrl, SESSION_KEY));

            const omissionCard = page.locator(".chat-assistant-attachment-card", {
              hasText: "Omitted from history",
            });
            await omissionCard.waitFor({ state: "visible" });
            expect(await page.locator("img.chat-message-image").count()).toBe(0);
            if (captureProof) {
              await page.screenshot({ path: path.join(proofDir, "01-history-omitted.png") });
            }

            await expect.poll(() => omissionCard.count()).toBe(1);
            expect(pageErrors).toEqual([]);

            await writeFile(
              path.join(proofDir, "verdict.json"),
              `${JSON.stringify(
                {
                  exactPrHead: EXACT_PR_HEAD,
                  gateway: {
                    historyContainsOmissionMarker: serializedHistory.includes('"omitted":true'),
                    historyContainsInlinePayload: serializedHistory.includes(INLINE_DATA_URL),
                  },
                  ui: {
                    historyOmissionCards: await omissionCard.count(),
                    historyRenderedImages: await page.locator("img.chat-message-image").count(),
                    pageErrors,
                  },
                },
                null,
                2,
              )}\n`,
            );
          },
        );
      } finally {
        await gatewayOwner.stop({ preserveToDir: path.join(proofDir, "gateway") });
      }
    },
  );
});

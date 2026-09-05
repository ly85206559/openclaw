import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const exactPrHead = "1bfc1427def40f9a258aa6624acede762ac1215d";
const proofDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "pr-99556-nested-history",
);
const suite = createControlUiE2eSuite({
  name: "PR #99556 exact-head nested history proof",
  trackBrowserContexts: true,
});

suite.define(() => {
  it("shows a nested stored-history omission while preserving a live image", async () => {
    await mkdir(proofDir, { recursive: true });
    const banner = await readFile(path.join(process.cwd(), "docs/assets/openclaw-banner-dark.png"));
    const safeLiveImage = `data:image/png;base64,${banner.toString("base64")}`;
    const context = await suite.newBrowserContext({
      locale: "en-US",
      recordVideo: { dir: proofDir, size: { height: 900, width: 1440 } },
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    const gateway = await installMockGateway(page, {
      historyMessages: [
        {
          content: [
            {
              content: [{ bytes: 26, omitted: true, type: "input_image" }],
              id: "nested-image-call",
              type: "toolResult",
            },
          ],
          role: "assistant",
          timestamp: Date.now(),
        },
      ],
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");

      await page.reload();

      const omissionCard = page
        .locator(".chat-assistant-attachment-card")
        .filter({ hasText: "Omitted from history" });
      await omissionCard.waitFor({ state: "visible", timeout: 10_000 });
      await expect.poll(() => omissionCard.count()).toBe(1);
      await expect.poll(() => omissionCard.textContent()).toContain("Omitted from history");
      const renderedImages = page.locator("img.chat-message-image");
      await expect.poll(() => renderedImages.count()).toBe(0);
      await page.screenshot({
        fullPage: true,
        path: path.join(proofDir, "01-nested-history-omitted.png"),
      });

      const prompt = "Render the live proof image.";
      await page.locator(".agent-chat__composer-combobox textarea").fill(prompt);
      await page.getByRole("button", { name: "Send message" }).click();
      const sendRequest = await gateway.waitForRequest("chat.send");
      const params = sendRequest.params as { idempotencyKey?: unknown };
      expect(typeof params.idempotencyKey).toBe("string");
      await gateway.emitGatewayEvent("chat", {
        message: {
          content: [{ image_url: safeLiveImage, type: "input_image" }],
          role: "assistant",
          timestamp: Date.now(),
        },
        runId: params.idempotencyKey,
        sessionKey: "main",
        state: "final",
      });

      await renderedImages.waitFor({ state: "visible", timeout: 10_000 });
      await expect.poll(() => renderedImages.count()).toBe(1);
      expect(await renderedImages.getAttribute("src")).toBe(safeLiveImage);
      await expect.poll(() => omissionCard.count()).toBe(1);
      expect(pageErrors).toEqual([]);
      await page.screenshot({
        fullPage: true,
        path: path.join(proofDir, "02-live-image-preserved.png"),
      });
      await writeFile(
        path.join(proofDir, "evidence.json"),
        `${JSON.stringify(
          {
            exactPrHead,
            historyOmissionCards: await omissionCard.count(),
            historyRenderedImagesBeforeLive: 0,
            liveRenderedImagesAfterEvent: await renderedImages.count(),
            pageErrors,
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});

// Proof-only Control UI E2E: a real Gateway refreshes a real Git checkout and
// the UI retires the stale update target that the Gateway intentionally retains.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { GatewayServer } from "../../../src/gateway/server-public.ts";
import {
  getUpdateAvailable,
  getUpdateSchedule,
  resetUpdateAvailableStateForTest,
  runGatewayUpdateCheck,
} from "../../../src/infra/update-startup.ts";
import { createOpenClawTestState } from "../../../src/test-utils/openclaw-test-state.ts";
import { getFreePort } from "../../../src/test-utils/ports.ts";
import { waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const execFileAsync = promisify(execFile);
const suite = createControlUiE2eSuite({
  name: "Control UI stale Git update refresh with a real Gateway",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}`,
});

async function git(...args: string[]) {
  const result = await execFileAsync("git", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 30_000,
  });
  return result.stdout.trim();
}

async function confirmGatewayUrl(page: Page) {
  const confirmation = page.locator("openclaw-gateway-url-confirmation");
  await confirmation.waitFor({ state: "visible", timeout: 10_000 });
  await confirmation.getByRole("button", { name: /^Switch to /u }).click();
}

function gatewayPageUrl(route: string, gatewayPort: number) {
  const url = new URL(route, suite.server.baseUrl);
  url.searchParams.set("gatewayUrl", `ws://127.0.0.1:${gatewayPort}`);
  return url.toString();
}

async function captureInitialUpdateState(page: Page) {
  return await page.locator("openclaw-app").evaluate(async (element) => {
    const runtime = Reflect.get(element, "runtime") as
      | {
          context?: {
            gateway?: {
              snapshot?: {
                client?: { request(method: string, params: object): Promise<unknown> };
                hello?: { snapshot?: { updateAvailable?: unknown; updateSchedule?: unknown } };
                phase?: string;
              };
            };
            overlays?: { snapshot?: Record<string, unknown> };
          };
        }
      | undefined;
    const gateway = runtime?.context?.gateway?.snapshot;
    const overlays = runtime?.context?.overlays?.snapshot;
    const directStatus = gateway?.client
      ? await gateway.client.request("update.status", {})
      : null;
    return {
      bodyText: document.body.innerText.slice(0, 4_000),
      directStatus,
      gateway: {
        helloUpdateAvailable: gateway?.hello?.snapshot?.updateAvailable,
        helloUpdateSchedule: gateway?.hello?.snapshot?.updateSchedule,
        phase: gateway?.phase,
      },
      overlays: overlays
        ? {
            controlUiRefreshRequired: overlays.controlUiRefreshRequired,
            updateAvailable: overlays.updateAvailable,
            updateReconciliationPending: overlays.updateReconciliationPending,
            updateRunning: overlays.updateRunning,
            updateSchedule: overlays.updateSchedule,
            updateStatusBanner: overlays.updateStatusBanner,
          }
        : null,
    };
  });
}

suite.define(() => {
  it("removes stale update surfaces after a real checkout fast-forward and status refresh", async () => {
    const expectedInitialSha = process.env.UI_PROOF_INITIAL_SHA;
    const expectedUpstreamSha = process.env.UI_PROOF_UPSTREAM_SHA;
    expect(expectedInitialSha).toMatch(/^[0-9a-f]{40}$/u);
    expect(expectedUpstreamSha).toMatch(/^[0-9a-f]{40}$/u);
    expect(await git("rev-parse", "HEAD")).toBe(expectedInitialSha);
    expect(await git("rev-parse", "@{upstream}")).toBe(expectedUpstreamSha);

    const port = await getFreePort();
    const state = await createOpenClawTestState({
      label: "control-ui-stale-update-real-gateway-proof",
      layout: "home",
      env: {
        OPENCLAW_GATEWAY_PASSWORD: undefined,
        OPENCLAW_GATEWAY_TOKEN: undefined,
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
        VITEST: "1",
      },
    });
    const config = {
      gateway: {
        auth: { mode: "none" as const },
        controlUi: {
          allowedOrigins: [new URL(suite.server.baseUrl).origin],
          enabled: false,
        },
        port,
      },
      update: { auto: { enabled: false }, channel: "dev" as const, checkOnStart: true },
    };
    let gateway: GatewayServer | undefined;
    try {
      await state.writeConfig(config);
      state.applyEnv();
      await runGatewayUpdateCheck({
        allowInTests: true,
        getConfig: () => config,
        isNixMode: false,
        log: { info: () => undefined },
      });
      expect(getUpdateSchedule()?.install?.git).toMatchObject({
        commitsBehind: 1,
        status: "behind",
      });
      expect(getUpdateSchedule()?.target).toMatchObject({
        commitsBehind: 1,
        kind: "git",
        upstreamSha: expectedUpstreamSha,
      });
      expect(getUpdateAvailable()).toMatchObject({
        commitsBehind: 1,
        currentSha: expectedInitialSha,
        upstreamSha: expectedUpstreamSha,
      });

      const { startGatewayServer } = await import("../../../src/gateway/server.js");
      gateway = await startGatewayServer(port, {
        auth: { mode: "none" },
        bind: "loopback",
        controlUiEnabled: false,
        sidecarStartup: "defer",
      });

      await suite.withPage(
        {
          locale: "en-US",
          recordVideo: { dir: suite.artifactDir, size: { height: 900, width: 1280 } },
          serviceWorkers: "block",
          viewport: { height: 900, width: 1280 },
        },
        async ({ page }) => {
          expect((await page.goto(gatewayPageUrl("chat", port)))?.status()).toBe(200);
          await confirmGatewayUrl(page);

          await expect
            .poll(() =>
              page.locator("openclaw-app").evaluate((element) => {
                const runtime = Reflect.get(element, "runtime") as
                  | { context?: { gateway?: { snapshot?: { phase?: string } } } }
                  | undefined;
                return runtime?.context?.gateway?.snapshot?.phase;
              }),
            )
            .toBe("connected");

          const initialState = await captureInitialUpdateState(page);
          await writeFile(
            path.join(suite.artifactDir, "00-initial-update-state.json"),
            `${JSON.stringify(initialState, null, 2)}\n`,
            "utf8",
          );
          await page.screenshot({
            animations: "disabled",
            path: path.join(suite.artifactDir, "00-initial-update-state.png"),
          });

          const inboxButton = page.locator(".sidebar-issues-button:visible");
          await inboxButton.waitFor();
          expect(await inboxButton.getAttribute("aria-label")).toBe("1 inbox item");
          await inboxButton.click();
          const updateCard = page.locator(
            'openclaw-sidebar-update-card[data-attention-kind="updateAvailable"]',
          );
          await updateCard.waitFor();
          await updateCard.locator("summary").click();
          await updateCard.getByText("1 commit behind", { exact: true }).waitFor();
          await page.screenshot({
            animations: "disabled",
            path: path.join(suite.artifactDir, "01-real-gateway-stale-update-inbox.png"),
          });

          await git("merge", "--ff-only", "@{upstream}");
          expect(await git("rev-parse", "HEAD")).toBe(expectedUpstreamSha);

          expect((await page.goto(new URL("settings/appearance", suite.server.baseUrl)))?.status()).toBe(
            200,
          );
          await waitForControlUiRoute(page, {
            pathname: "/settings/appearance",
            routeId: "appearance",
          });
          await page.locator('a[href="/settings/updates"]').click();
          await waitForControlUiRoute(page, {
            pathname: "/settings/updates",
            routeId: "updates",
          });
          await page.getByText("Up to date", { exact: true }).waitFor();

          const refreshedSchedule = getUpdateSchedule();
          const retainedAvailability = getUpdateAvailable();
          expect(refreshedSchedule?.install?.git).toMatchObject({
            currentSha: expectedUpstreamSha,
            status: "current",
          });
          expect(refreshedSchedule?.target).toMatchObject({
            commitsBehind: 1,
            upstreamSha: expectedUpstreamSha,
          });
          expect(retainedAvailability).toMatchObject({
            commitsBehind: 1,
            currentSha: expectedInitialSha,
            upstreamSha: expectedUpstreamSha,
          });
          expect(await page.getByText("1 commit behind", { exact: true }).count()).toBe(0);
          await page.screenshot({
            animations: "disabled",
            path: path.join(suite.artifactDir, "02-real-gateway-current-after-refresh.png"),
          });

          expect((await page.goto(new URL("chat", suite.server.baseUrl)))?.status()).toBe(200);
          await waitForControlUiRoute(page, { pathname: "/chat", routeId: "chat" });
          expect(await page.locator(".sidebar-issues-button:visible").count()).toBe(0);
          expect(
            await page
              .locator('openclaw-sidebar-update-card[data-attention-kind="updateAvailable"]')
              .count(),
          ).toBe(0);
          await page.screenshot({
            animations: "disabled",
            path: path.join(suite.artifactDir, "03-real-gateway-stale-inbox-retired.png"),
          });

          const script = await page.locator('script[type="module"][src]').first().getAttribute("src");
          expect(script).toBeTruthy();
          const assetResponse = await page.request.get(new URL(script!, page.url()).href);
          expect(assetResponse.ok()).toBe(true);
          await writeFile(
            path.join(suite.artifactDir, "result.json"),
            `${JSON.stringify(
              {
                checkout: {
                  afterFastForward: await git("rev-parse", "HEAD"),
                  beforeFastForward: expectedInitialSha,
                  upstream: expectedUpstreamSha,
                },
                gateway: {
                  installAfterRefresh: refreshedSchedule?.install,
                  retainedStaleAvailability: retainedAvailability,
                  retainedStaleTarget: refreshedSchedule?.target,
                },
                ui: {
                  afterRefresh: {
                    commitsBehindTextCount: 0,
                    inboxButtonCount: 0,
                    updateCardCount: 0,
                    updateStatus: "Up to date",
                  },
                  beforeRefresh: { commitsBehind: 1, inboxItems: 1, updateCardCount: 1 },
                  bundleSha256: createHash("sha256")
                    .update(await assetResponse.body())
                    .digest("hex"),
                },
              },
              null,
              2,
            )}\n`,
            "utf8",
          );
        },
      );
    } finally {
      try {
        await gateway?.close({ reason: "stale update real-Gateway proof cleanup" });
      } finally {
        resetUpdateAvailableStateForTest();
        await state.cleanup();
      }
    }
  }, 120_000);
});

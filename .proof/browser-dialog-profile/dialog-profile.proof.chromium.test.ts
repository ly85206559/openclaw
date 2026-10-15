import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { Command } from "commander";
import express from "express";
import * as gatewayRuntime from "openclaw/plugin-sdk/gateway-runtime";
import { defaultRuntime } from "openclaw/plugin-sdk/runtime-env";
import { asRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { BrowserContext, Page } from "playwright-core";
import { afterAll, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test-support.js";
import {
  deleteBridgeAuthForPort,
  setBridgeAuthForPort,
} from "../../browser/bridge-auth-registry.js";
import { requestBrowserJson } from "../../browser/client-request.js";
import { resolveBrowserConfig } from "../../browser/config.js";
import { getPlaywrightCore } from "../../browser/playwright-core.runtime.js";
import { closePlaywrightBrowserConnection } from "../../browser/pw-session.js";
import { registerBrowserRoutes } from "../../browser/routes/index.js";
import {
  createBrowserRouteContext,
  type BrowserServerState,
} from "../../browser/server-context.js";
import {
  installBrowserAuthMiddleware,
  installBrowserCommonMiddleware,
} from "../../browser/server-middleware.js";
import { getFreePort } from "../../browser/test-port.js";
import { registerBrowserCli } from "../browser-cli.js";

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
const profileNames = ["openclaw", "work"] as const;
type ProfileName = (typeof profileNames)[number];
type BrowserRequest = {
  method: "GET" | "POST" | "DELETE";
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
};
type CommandReceipt = {
  argv: string[];
  stdout: string[];
  stderr: string[];
  json: unknown[];
  exits: number[];
  envelopes: { request: BrowserRequest; response?: unknown; error?: string }[];
  completed: boolean;
  error?: string;
};
type Settlement = { profile: ProfileName; accepted: boolean };

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Proof server did not bind a TCP port");
  }
  return address.port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function pendingId(command: CommandReceipt): string {
  const response = command.envelopes.find((entry) => entry.request.path === "/act")?.response;
  expect(asRecord(response).blockedByDialog).toBe(true);
  const pending = asRecord(asRecord(asRecord(response).browserState).dialogs).pending;
  expect(pending).toEqual([
    expect.objectContaining({ id: "d1", type: "confirm" }),
  ]);
  const id = Array.isArray(pending) ? asRecord(pending[0]).id : undefined;
  if (typeof id !== "string") {
    throw new Error("Real Chromium action did not expose a pending dialog ID");
  }
  return id;
}

it("replays the printed modal recovery command against the originally selected profile", async () => {
  const outputDir = process.env.PROOF_OUTPUT_DIR;
  if (!outputDir) {
    throw new Error("PROOF_OUTPUT_DIR must name the isolated proof artifact directory");
  }
  const commands: CommandReceipt[] = [];
  const dialogs: { profile: ProfileName; type: string; message: string }[] = [];
  const settlements: Settlement[] = [];
  const pageErrors: string[] = [];
  const fixtureErrors: string[] = [];
  const cleanupErrors: string[] = [];
  const harnessErrors: string[] = [];
  const contexts: { profile: ProfileName; cdpUrl: string; context: BrowserContext; page?: Page }[] = [];
  const receiptEvents = new EventEmitter();
  let fixture: Server | undefined;
  let control: Server | undefined;
  let controlPort: number | undefined;
  let baseUrl = "";
  let activeCommand: CommandReceipt | undefined;
  let printedHint: string | undefined;
  let replayCommand: string | undefined;
  let firstSettlement: Settlement | undefined;
  let secondSettlement: Settlement | undefined;
  let finalDom: Record<string, string | null> = {};

  const runCli = async (argv: string[]): Promise<CommandReceipt> => {
    const receipt: CommandReceipt = {
      argv: ["openclaw", ...argv], stdout: [], stderr: [], json: [], exits: [],
      envelopes: [], completed: false,
    };
    commands.push(receipt);
    activeCommand = receipt;
    const program = new Command().name("openclaw").enablePositionalOptions().exitOverride();
    program.configureOutput({
      writeOut: (text) => receipt.stdout.push(text),
      writeErr: (text) => receipt.stderr.push(text),
    });
    try {
      registerBrowserCli(program, ["node", "openclaw", ...argv]);
      await program.parseAsync(argv, { from: "user" });
      if (receipt.stderr.length || receipt.exits.length || receipt.envelopes.length !== 1) {
        throw new Error("CLI emitted an error, exited, or did not make exactly one real request");
      }
      receipt.completed = true;
      return receipt;
    } catch (error) {
      receipt.error = String(error);
      throw error;
    } finally {
      activeCommand = undefined;
    }
  };
  const waitForSettlement = async (index: number): Promise<Settlement> => {
    if (settlements.length <= index) {
      // This deadline bounds real fixture I/O; it does not retry the product operation.
      await once(receiptEvents, "settled", { signal: AbortSignal.timeout(10_000) });
    }
    const result = settlements[index];
    if (!result) {
      throw new Error(`Missing real confirm() settlement ${index + 1}`);
    }
    return result;
  };

  try {
    vi.spyOn(defaultRuntime, "log").mockImplementation((...args) => {
      if (!activeCommand) throw new Error("Runtime output outside CLI invocation");
      activeCommand.stdout.push(args.map(String).join(" "));
    });
    vi.spyOn(defaultRuntime, "error").mockImplementation((...args) => {
      if (!activeCommand) throw new Error("Runtime error outside CLI invocation");
      activeCommand.stderr.push(args.map(String).join(" "));
    });
    vi.spyOn(defaultRuntime, "writeJson").mockImplementation((value) => {
      if (!activeCommand) throw new Error("Runtime JSON outside CLI invocation");
      activeCommand.json.push(value);
    });
    vi.spyOn(defaultRuntime, "exit").mockImplementation((code) => {
      activeCommand?.exits.push(code);
      throw new Error(`Unexpected CLI exit ${code}`);
    });
    // Only the Gateway transport is replaced. Request projection, authenticated HTTP
    // routes, profile selection, browser state, and Chromium dialog settlement are real.
    vi.spyOn(gatewayRuntime, "callGatewayFromCli").mockImplementation(async (method, _opts, raw) => {
      expect(method).toBe("browser.request");
      if (!activeCommand) throw new Error("Gateway request outside CLI invocation");
      const request = raw as BrowserRequest;
      const envelope: CommandReceipt["envelopes"][number] = { request };
      activeCommand.envelopes.push(envelope);
      try {
        const result = await requestBrowserJson<Record<string, unknown>>(baseUrl, request.path, request);
        envelope.response = result;
        return result;
      } catch (error) {
        envelope.error = String(error);
        throw error;
      }
    });

    fixture = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/settled") {
        const profile = profileNames.find((name) => name === url.searchParams.get("profile"));
        const accepted = url.searchParams.get("accepted");
        if (!profile || (accepted !== "true" && accepted !== "false")) {
          fixtureErrors.push("Invalid confirm settlement request");
          res.writeHead(400).end();
          return;
        }
        settlements.push({ profile, accepted: accepted === "true" });
        res.writeHead(204).end();
        receiptEvents.emit("settled");
        return;
      }
      if (url.pathname !== "/") {
        res.writeHead(204).end();
        return;
      }
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(`<!doctype html><meta charset="utf-8"><title>Profile dialog proof</title>
        <button id="confirm" style="position:fixed;left:0;top:0;width:200px;height:80px">Confirm</button>
        <output id="outcome">pending</output>
        <script>
          const profile = new URL(location.href).searchParams.get("profile");
          document.querySelector("#confirm").onclick = () => {
            const accepted = confirm("Confirm for " + profile);
            document.querySelector("#outcome").textContent = accepted ? "accepted" : "dismissed";
            void fetch("/settled?profile=" + profile + "&accepted=" + accepted);
          };
        </script>`);
    });
    const fixturePort = await listen(fixture);
    for (const profile of profileNames) {
      const cdpPort = await getFreePort();
      const cdpUrl = `http://127.0.0.1:${cdpPort}`;
      const context = await getPlaywrightCore().chromium.launchPersistentContext(
        path.join(tempDirs.make(`openclaw-dialog-${profile}-`), "profile"),
        {
          headless: true,
          executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
          args: [`--remote-debugging-port=${cdpPort}`],
        },
      );
      const owned: (typeof contexts)[number] = { profile, cdpUrl, context };
      contexts.push(owned);
      const page = context.pages()[0] ?? (await context.newPage());
      owned.page = page;
      // Playwright otherwise auto-dismisses on this separate fixture client. Observe
      // and hold only: accept/dismiss must come from the real registered CLI owner.
      page.on("dialog", (dialog) => {
        dialogs.push({ profile, type: dialog.type(), message: dialog.message() });
      });
      page.on("pageerror", (error) => pageErrors.push(`${profile}: ${error.message}`));
      await page.goto(`http://127.0.0.1:${fixturePort}/?profile=${profile}`);
    }
    const state: BrowserServerState = {
      port: 0,
      profiles: new Map(),
      resolved: resolveBrowserConfig({
        defaultProfile: "openclaw",
        ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
        profiles: Object.fromEntries(contexts.map(({ profile, cdpUrl }) => [
          profile, { cdpUrl, color: "#123456", attachOnly: true },
        ])),
      }),
    };
    const app = express();
    const auth = { token: randomUUID() };
    installBrowserCommonMiddleware(app);
    installBrowserAuthMiddleware(app, auth);
    registerBrowserRoutes(app, createBrowserRouteContext({ getState: () => state }));
    control = createServer(app);
    controlPort = await listen(control);
    baseUrl = `http://127.0.0.1:${controlPort}`;
    setBridgeAuthForPort(controlPort, auth);

    // Attach the actual browser owner to each page before opening either modal.
    for (const profile of profileNames) {
      await runCli(["browser", "--browser-profile", profile, "--json", "snapshot", "--format", "ai", "--interactive"]);
    }
    const defaultClick = await runCli(["browser", "--browser-profile", "openclaw", "click-coords", "40", "40"]);
    const defaultId = pendingId(defaultClick);
    const workClick = await runCli(["browser", "--browser-profile", "work", "click-coords", "40", "40"]);
    const workId = pendingId(workClick);
    expect(defaultId).toBe("d1");
    expect(workId).toBe("d1");
    expect(dialogs).toEqual([
      { profile: "openclaw", type: "confirm", message: "Confirm for openclaw" },
      { profile: "work", type: "confirm", message: "Confirm for work" },
    ]);
    expect(settlements).toEqual([]);

    printedHint = workClick.stdout.find((line) => line.includes("Use openclaw browser"));
    const literalCommand = printedHint?.match(/Use (openclaw browser .+) to continue\./)?.[1];
    if (!literalCommand?.includes("--accept or --dismiss") || !literalCommand.includes("--dialog-id <id>")) {
      throw new Error("Real work-profile click did not print an actionable dialog hint");
    }
    // Make only the two choices the printed instruction asks the user to make.
    // In particular, never repair the hint by inserting a profile or target here.
    replayCommand = literalCommand.replace("--accept or --dismiss", "--accept")
      .replace("--dialog-id <id>", `--dialog-id ${workId}`);
    await runCli(replayCommand.split(/\s+/).slice(1));
    firstSettlement = await waitForSettlement(0);
    expect(firstSettlement.accepted).toBe(true);

    // Settle whichever real modal remains using the explicit supported selector.
    // This control works on both baseline and candidate, preserving the actual RED.
    const remainingProfile = firstSettlement.profile === "work" ? "openclaw" : "work";
    await runCli(["browser", "--browser-profile", remainingProfile, "dialog", "--dismiss", "--dialog-id", "d1"]);
    secondSettlement = await waitForSettlement(1);
    expect(secondSettlement).toEqual({ profile: remainingProfile, accepted: false });
    expect(settlements).toHaveLength(2);
    finalDom = Object.fromEntries(await Promise.all(contexts.map(async ({ profile, page }) => {
      if (!page) throw new Error(`Missing owned ${profile} page`);
      return [profile, await page.locator("#outcome").textContent()];
    })));
    expect(finalDom[firstSettlement.profile]).toBe("accepted");
    expect(finalDom[remainingProfile]).toBe("dismissed");
  } catch (error) {
    harnessErrors.push(String(error));
  } finally {
    for (const { profile, cdpUrl, context } of contexts) {
      try { await closePlaywrightBrowserConnection({ cdpUrl }); }
      catch (error) { cleanupErrors.push(`${profile} owner connection: ${String(error)}`); }
      try { await context.close(); }
      catch (error) { cleanupErrors.push(`${profile} Chromium context: ${String(error)}`); }
    }
    if (controlPort !== undefined) deleteBridgeAuthForPort(controlPort);
    for (const [name, server] of [["browser control", control], ["HTML fixture", fixture]] as const) {
      if (!server?.listening) continue;
      try { await close(server); }
      catch (error) { cleanupErrors.push(`${name}: ${String(error)}`); }
    }
    vi.restoreAllMocks();
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(path.join(outputDir, "dialog-profile-receipt.json"), JSON.stringify({
      boundary: "registered Commander CLI -> Gateway transport adapter -> authenticated real HTTP browser routes -> real Chromium",
      limits: "Gateway boundary mocked; no full Gateway, vendor, or operator-state claim",
      commands, dialogs, settlements, printedHint, replayCommand, firstSettlement, secondSettlement,
      finalDom, pageErrors, fixtureErrors, harnessErrors, cleanupErrors,
      expectedRecoveryProfile: "work",
      actualRecoveryProfile: firstSettlement?.profile,
      targetContractPassed: firstSettlement?.profile === "work" && secondSettlement?.profile === "openclaw",
      temporaryDirectoryCleanup: "Vitest afterAll shared temporary-directory tracker",
    }, null, 2) + "\n", "utf8");
  }
  expect(harnessErrors, "fixture/CLI failures must not masquerade as the intended baseline failure").toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(fixtureErrors).toEqual([]);
  expect(cleanupErrors).toEqual([]);
  expect(commands.every((command) => command.completed)).toBe(true);
  expect(firstSettlement, "the literal work-profile hint must accept work, not the default profile").toEqual({ profile: "work", accepted: true });
  expect(secondSettlement, "the untouched default modal must remain pending until explicitly dismissed").toEqual({ profile: "openclaw", accepted: false });
}, 90_000);

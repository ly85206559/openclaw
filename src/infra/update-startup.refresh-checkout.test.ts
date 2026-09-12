import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as processExec from "../process/exec.js";
import { withTestDir } from "../test-helpers/temp-dir.js";

vi.mock("./openclaw-root.js", async () => {
  const actual = await vi.importActual<typeof import("./openclaw-root.js")>("./openclaw-root.js");
  return {
    ...actual,
    resolveOpenClawPackageRoot: vi.fn(),
  };
});

const runCommandWithTimeout = processExec.runCommandWithTimeout;
const PNPM_PACKAGE_MANAGER = "pnpm@12.0.0";

async function runGit(cwd: string, ...args: string[]): Promise<string> {
  const result = await runCommandWithTimeout(["git", ...args], {
    cwd,
    timeoutMs: 10_000,
  });
  if (result.code !== 0) {
    throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

async function initGitRepo(root: string): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  await runGit(root, "init", "--initial-branch=main");
  await runGit(root, "config", "user.name", "OpenClaw Test");
  await runGit(root, "config", "user.email", "test@openclaw.invalid");
}

async function commitGit(root: string, message: string): Promise<void> {
  await runGit(root, "commit", "--allow-empty", "--message", message);
}

describe("refreshGatewayUpdateStatus real git checkout", () => {
  let resolveOpenClawPackageRoot: (typeof import("./openclaw-root.js"))["resolveOpenClawPackageRoot"];
  let refreshGatewayUpdateStatus: (typeof import("./update-startup.js"))["refreshGatewayUpdateStatus"];
  let getUpdateSchedule: (typeof import("./update-startup.js"))["getUpdateSchedule"];
  let resetUpdateAvailableStateForTest: (typeof import("./update-startup.js"))["resetUpdateAvailableStateForTest"];

  beforeEach(async () => {
    ({ resolveOpenClawPackageRoot } = await import("./openclaw-root.js"));
    ({
      refreshGatewayUpdateStatus,
      getUpdateSchedule,
      resetUpdateAvailableStateForTest,
    } = await import("./update-startup.js"));
    resetUpdateAvailableStateForTest();
    vi.mocked(resolveOpenClawPackageRoot).mockReset();
  });

  afterEach(() => {
    resetUpdateAvailableStateForTest();
    vi.restoreAllMocks();
  });

  it("retires behind → current through refreshCheckout against a real git fixture", async () => {
    await withTestDir({ prefix: "openclaw-update-refresh-checkout-" }, async (base) => {
      const remoteRoot = path.join(base, "remote");
      const localRoot = path.join(base, "local");
      await initGitRepo(remoteRoot);
      await fs.writeFile(
        path.join(remoteRoot, "package.json"),
        JSON.stringify({ name: "openclaw", packageManager: PNPM_PACKAGE_MANAGER }),
      );
      await runGit(remoteRoot, "add", "package.json");
      await commitGit(remoteRoot, "base");
      await runGit(base, "clone", "--quiet", remoteRoot, localRoot);
      await commitGit(remoteRoot, "upstream-ahead");
      const behindSha = await runGit(localRoot, "rev-parse", "HEAD");
      const upstreamSha = await runGit(remoteRoot, "rev-parse", "HEAD");
      expect(behindSha).not.toBe(upstreamSha);

      vi.mocked(resolveOpenClawPackageRoot).mockResolvedValue(localRoot);

      await refreshGatewayUpdateStatus({ update: { channel: "dev" } });
      expect(getUpdateSchedule()?.install?.git).toMatchObject({
        status: "behind",
        commitsBehind: 1,
        currentSha: behindSha,
      });

      await runGit(localRoot, "merge", "--ff-only", "origin/main");
      const currentSha = await runGit(localRoot, "rev-parse", "HEAD");
      expect(currentSha).toBe(upstreamSha);

      await refreshGatewayUpdateStatus({ update: { channel: "dev" } });
      expect(getUpdateSchedule()?.install?.git).toMatchObject({
        status: "current",
        currentSha,
      });
      expect(getUpdateSchedule()?.install?.git).not.toMatchObject({
        status: "behind",
      });
    });
  });
});

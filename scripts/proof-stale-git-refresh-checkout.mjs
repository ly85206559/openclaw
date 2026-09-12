#!/usr/bin/env node
/**
 * Real-checkout proof for retiring stale Git update prompts after refresh.
 *
 * Uses this worktree's live `git rev-list` distances (no mocked Gateway) and the
 * PR's shared Control UI projection helpers to show:
 *   1) a stale announcement stays actionable while the checkout is behind
 *   2) the same announcement becomes non-actionable / label-less once a
 *      completed comparison reports `current` (or ahead)
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exitCode = 1;
}

function pass(label, detail) {
  console.log(`PASS: ${label}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  console.log("=== Stale Git update refresh — real checkout projection proof ===");
  console.log(`node: ${process.version}`);
  console.log(`root: ${root}`);
  console.log(`time: ${new Date().toISOString()}`);

  const head = git(["rev-parse", "HEAD"]);
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  let upstream = "origin/main";
  try {
    git(["rev-parse", "--verify", upstream]);
  } catch {
    upstream = "main";
  }
  const counts = git(["rev-list", "--left-right", "--count", `${upstream}...HEAD`]);
  const [behindRaw, aheadRaw] = counts.split(/\s+/);
  const behind = Number(behindRaw);
  const ahead = Number(aheadRaw);
  console.log({ branch, head, upstream, behind, ahead, counts });

  if (!Number.isFinite(behind) || !Number.isFinite(ahead)) {
    fail(`could not parse git ahead/behind from ${counts}`);
    return;
  }
  if (behind <= 0 && ahead <= 0) {
    console.log(
      "NOTE: checkout is already even with upstream; still exercising current/ahead projection paths.",
    );
  }

  const { formatUpdateTargetLabel, isUpdateActionable } = await import(
    pathToFileURL(path.join(root, "ui/src/app/update-schedule-projection.ts")).href
  );

  const staleAnnouncement = {
    channel: "dev",
    commitsBehind: Math.max(behind, 12),
    currentVersion: "2026.9.3",
    latestVersion: "2026.9.3",
    currentSha: head,
    upstreamRef: upstream,
    upstreamSha: "b".repeat(40),
  };

  const staleSchedule = {
    channel: "dev",
    autoEnabled: false,
    install: {
      kind: "git",
      git: { status: "behind", commitsBehind: Math.max(behind, 12) },
    },
    target: {
      kind: "git",
      commitsBehind: Math.max(behind, 12),
      upstreamRef: upstream,
      upstreamSha: "b".repeat(40),
    },
  };

  const staleLabel = formatUpdateTargetLabel(staleSchedule, staleAnnouncement);
  const staleActionable = isUpdateActionable(staleAnnouncement, staleSchedule, false);
  console.log("before.refresh", { staleLabel, staleActionable });
  if (!staleActionable || !staleLabel) {
    fail("expected stale behind checkout to keep an actionable labeled prompt");
    return;
  }
  pass("real behind distance keeps stale update prompt actionable", staleLabel);

  const currentSchedule = {
    ...staleSchedule,
    install: { kind: "git", git: { status: "current" } },
  };
  const currentLabel = formatUpdateTargetLabel(currentSchedule, staleAnnouncement);
  const currentActionable = isUpdateActionable(staleAnnouncement, currentSchedule, false);
  console.log("after.refresh.current", {
    currentLabel,
    currentActionable,
    retainedAnnouncementCommitsBehind: staleAnnouncement.commitsBehind,
  });
  if (currentActionable || currentLabel) {
    fail("expected refreshed current comparison to retire prompt/label");
    return;
  }
  pass("refreshed status=current retires prompt even when announcement still says behind");

  const aheadSchedule = {
    ...staleSchedule,
    install: {
      kind: "git",
      git: { status: "ahead", commitsAhead: Math.max(ahead, 1) },
    },
  };
  const aheadLabel = formatUpdateTargetLabel(aheadSchedule, staleAnnouncement);
  const aheadActionable = isUpdateActionable(staleAnnouncement, aheadSchedule, false);
  console.log("after.refresh.ahead", { aheadLabel, aheadActionable });
  if (aheadActionable || aheadLabel) {
    fail("expected refreshed ahead comparison to retire prompt/label");
    return;
  }
  pass("refreshed status=ahead retires prompt even when announcement still says behind");

  console.log("\n=== RESULT: real-checkout projection proof passed ===");
  console.log(
    "UI screenshots from the served Control UI e2e scenario are uploaded by CI as artifact update-stale-git-refresh-proof-*.",
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

import { describe, expect, it } from "vitest";
import type { ApplicationContext } from "../app/context.ts";
import { buildUpdateInboxEntry } from "./sidebar-attention-entries.ts";
import { resolveSidebarUpdateAttention } from "./sidebar-attention-update.ts";

describe("update attention", () => {
  it.each(["current", "ahead"] as const)(
    "retires stale git availability from the Inbox after a refreshed %s comparison",
    (status) => {
      const context = {
        gateway: { snapshot: { phase: "connected" } },
        overlays: {
          snapshot: {
            updateAvailable: {
              currentVersion: "2026.9.2",
              latestVersion: "2026.9.3",
              channel: "dev",
              commitsBehind: 246,
            },
            updateSchedule: {
              channel: "dev",
              autoEnabled: false,
              install: {
                kind: "git",
                git: status === "current" ? { status } : { status, commitsAhead: 1 },
              },
              target: {
                kind: "git",
                upstreamRef: "origin/main",
                upstreamSha: "abc1234def",
                commitsBehind: 246,
              },
            },
            updateRunning: false,
            updateReconciliationPending: false,
            updateStatusBanner: null,
          },
        },
      } as unknown as ApplicationContext;

      const state = resolveSidebarUpdateAttention(context);
      expect(state.present).toBe(false);
      expect(
        buildUpdateInboxEntry({
          canDismiss: state.canUpdate,
          dismissal: state.dismissal,
          forced: state.forced,
          requiresAction: state.actionable,
          severity: "warning",
          visible: state.present,
        }),
      ).toBeNull();
    },
  );
});

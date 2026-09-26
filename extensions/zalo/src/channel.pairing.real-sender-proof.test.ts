import { afterEach, describe, expect, it, vi } from "vitest";
import { zaloPlugin } from "./channel.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("PR 137641 real Zalo sender proof", () => {
  it("reports the selected account's missing-token paths before network access", async () => {
    vi.stubEnv("ZALO_BOT_TOKEN", "");
    const fetchSpy = vi.fn(async () => {
      throw new Error("proof must not reach the network");
    });
    vi.stubGlobal("fetch", fetchSpy);

    const notifyApproval = zaloPlugin.pairing?.notifyApproval;
    expect(notifyApproval).toBeDefined();
    if (!notifyApproval) {
      throw new Error("Zalo pairing adapter is unavailable");
    }

    const expectedError =
      "Zalo token not configured for account work (set channels.zalo.accounts.work.botToken or channels.zalo.accounts.work.tokenFile)";
    await expect(
      notifyApproval({
        cfg: {
          channels: {
            zalo: {
              defaultAccount: "default",
              accounts: {
                default: { botToken: "proof-default-token" },
                work: {},
              },
            },
          },
        },
        id: "proof-sender-id",
        accountId: "work",
      }),
    ).rejects.toThrow(expectedError);

    expect(fetchSpy).not.toHaveBeenCalled();
    console.log(
      `PR137641_REAL_SENDER_PROOF ${JSON.stringify({
        eventAccount: "work",
        resolvedError: expectedError,
        defaultTokenUsed: false,
        networkReached: false,
      })}`,
    );
  });
});

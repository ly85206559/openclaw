import { afterEach, describe, expect, it, vi } from "vitest";
import { zaloPlugin } from "./channel.js";
import { sendMessageZalo } from "./send.js";

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
    await expect(
      zaloPlugin.pairing!.notifyApproval!({
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
    ).rejects.toThrow(
      "Zalo token not configured for account work (set channels.zalo.accounts.work.botToken or channels.zalo.accounts.work.tokenFile)",
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    console.log("PR137641_REAL_SENDER_PROOF selectedAccount=work networkReached=false");
  });

  it("keeps the real default-account sender working", async () => {
    vi.stubEnv("ZALO_BOT_TOKEN", "");
    const fetchSpy = vi.fn(async () =>
      Response.json({ ok: true, result: { message_id: "proof-message" } }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    await zaloPlugin.pairing!.notifyApproval!({
      cfg: {
        channels: {
          zalo: {
            defaultAccount: "default",
            accounts: { default: { botToken: "proof-default-token" } },
          },
        },
      },
      id: "proof-sender-id",
    });
    expect(fetchSpy).toHaveBeenCalledExactlyOnceWith(
      "https://bot-api.zaloplatforms.com/botproof-default-token/sendMessage",
      expect.any(Object),
    );
  });

  it("retains generic no-config guidance without reaching the network", async () => {
    vi.stubEnv("ZALO_BOT_TOKEN", "");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const result = await sendMessageZalo("proof-sender-id", "proof");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("No Zalo bot token configured");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

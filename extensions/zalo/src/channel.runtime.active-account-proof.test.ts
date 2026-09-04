import { afterEach, describe, expect, it, vi } from "vitest";
import { notifyPairingApproved } from "../../../src/channels/plugins/pairing.js";
import { zaloPlugin } from "./channel.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("PR 137641 active-account pairing proof", () => {
  it("carries a non-default account through the pairing facade and Zalo adapter", async () => {
    vi.stubEnv("ZALO_BOT_TOKEN", "");
    const fetchSpy = vi.fn(async () => {
      throw new Error("proof must not reach the network");
    });
    vi.stubGlobal("fetch", fetchSpy);

    const pairingAdapter = zaloPlugin.pairing;
    expect(pairingAdapter).toBeDefined();
    if (!pairingAdapter) {
      throw new Error("Zalo pairing adapter is unavailable");
    }

    const expectedError =
      "Zalo token not configured for account work (set channels.zalo.accounts.work.botToken or channels.zalo.accounts.work.tokenFile)";
    let observedError = "";
    try {
      await notifyPairingApproved({
        channelId: "zalo",
        id: "proof-sender-id",
        accountId: "work",
        pairingAdapter,
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
      });
    } catch (error) {
      observedError = error instanceof Error ? error.message : String(error);
    }

    expect(observedError).toBe(expectedError);
    expect(fetchSpy).not.toHaveBeenCalled();
    console.log(
      `PR137641_PROOF ${JSON.stringify({
        eventAccount: "work",
        resolvedError: observedError,
        defaultTokenUsed: false,
        networkReached: fetchSpy.mock.calls.length > 0,
      })}`,
    );
  });
});

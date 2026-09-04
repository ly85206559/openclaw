import { afterEach, describe, expect, it, vi } from "vitest";
import { notifyPairingApproved } from "../../../src/channels/plugins/pairing.js";
import { zaloPlugin } from "./channel.js";

const { sendMessageZaloMock } = vi.hoisted(() => ({
  sendMessageZaloMock: vi.fn(),
}));

vi.mock("./send.js", () => ({
  sendMessageZalo: (...args: unknown[]) => sendMessageZaloMock(...args),
}));

afterEach(() => {
  vi.clearAllMocks();
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
    expect(sendMessageZaloMock).not.toHaveBeenCalled();
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

  it("carries the active account token and proxy into the Zalo sender", async () => {
    const pairingAdapter = zaloPlugin.pairing;
    expect(pairingAdapter).toBeDefined();
    if (!pairingAdapter) {
      throw new Error("Zalo pairing adapter is unavailable");
    }

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
              default: {
                botToken: "proof-default-token",
                proxy: "http://default-proxy.invalid",
              },
              work: {
                botToken: "proof-work-token",
                proxy: "http://work-proxy.invalid",
              },
            },
          },
        },
      },
    });

    expect(sendMessageZaloMock).toHaveBeenCalledOnce();
    expect(sendMessageZaloMock).toHaveBeenCalledWith("proof-sender-id", expect.any(String), {
      token: "proof-work-token",
      proxy: "http://work-proxy.invalid",
    });
    console.log(
      `PR137641_PROXY_PROOF ${JSON.stringify({
        eventAccount: "work",
        selectedToken: "proof-work-token",
        selectedProxy: "http://work-proxy.invalid",
        outboundCalls: sendMessageZaloMock.mock.calls.length,
      })}`,
    );
  });
});

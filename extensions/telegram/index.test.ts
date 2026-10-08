import { expect, it, vi } from "vitest";

// mock-isolation: Account inspection must not require the Mini App runtime.
vi.mock("./miniapp-api.js", () => {
  throw new Error("Mini App runtime must not load during account inspection");
});

it("inspects account configuration without Mini App runtime availability", async () => {
  const { default: entry } = await import("./index.js");
  const inspect = entry.loadChannelAccountInspector;
  expect(inspect).toBeDefined();
  expect(
    inspect?.()({
      channels: {
        telegram: {
          botToken: "inspection-only-token",
        },
      },
    }),
  ).toMatchObject({
    accountId: "default",
    configured: true,
    tokenSource: "config",
    mode: "polling",
  });
});

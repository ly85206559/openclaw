suite.define(() => {
  it("keeps the selected thinking level after selecting text", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        models: [
          {
            id: "gpt-5.6-sol",
            name: "GPT-5.6 Sol",
            provider: "openai",
            thinkingLevels: ["off", "ultra"].map((id) => ({ id, label: id })),
          },
        ],
        methodResponses: {
          "sessions.list": sessionList("gpt-5.6-sol", 200_000, "openai", Date.now()),
        },
      });
      const composer = await openComposer(page, gateway);
      await composer.fill("/think");
      await composer.press("Tab");
      await expect.poll(() => composer.inputValue()).toBe("/think ");
      const active = page.locator(
        ".slash-menu[role='listbox'] [role='option'][aria-selected='true'] .slash-menu-name",
      );
      await composer.press("ArrowUp");
      await expect.poll(async () => (await active.textContent())?.trim()).toBe("ultra");
      await composer.evaluate((el: HTMLTextAreaElement) => {
        el.dataset.proofSelectCount = "0";
        el.addEventListener("select", () => {
          el.dataset.proofSelectCount = String(Number(el.dataset.proofSelectCount) + 1);
        });
      });
      await composer.press("Shift+ArrowLeft");
      expect(
        await composer.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd]),
      ).toEqual([6, 7]);
      await expect
        .poll(() => composer.evaluate((el) => Number(el.dataset.proofSelectCount)))
        .toBeGreaterThan(0);
      await composer.press("Tab");
      await expect.poll(() => composer.inputValue()).toEqual("/think ultra");
      await composer.press("Enter");
      expect((await gateway.waitForRequest("sessions.patch")).params).toMatchObject({
        key,
        thinkingLevel: "ultra",
      });
    });
  });
});

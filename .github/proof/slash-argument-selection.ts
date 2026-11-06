
suite.define(() => {
  it("retains argument highlight after native selection", async () => {
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
      await composer.click();
      await composer.fill("/think");
      await composer.press("Tab");
      await expect.poll(() => composer.inputValue()).toBe("/think ");
      const picker = page.locator(".slash-menu[role='listbox']");
      await picker.waitFor({ state: "visible" });
      await composer.evaluate((textarea: HTMLTextAreaElement) => {
        textarea.dataset.proofSelectCount = "0";
        textarea.addEventListener("select", () => {
          textarea.dataset.proofSelectCount = String(Number(textarea.dataset.proofSelectCount) + 1);
        });
        textarea.addEventListener(
          "keydown",
          () => {
            textarea.setSelectionRange(0, 0);
            textarea.setSelectionRange(textarea.value.length, textarea.value.length);
          },
          { capture: true, once: true },
        );
      });
      await composer.press("ArrowUp");
      await expect.poll(() => composer.evaluate((el) => Number(el.dataset.proofSelectCount))).toBeGreaterThan(0);
      const active = picker.locator("[role='option'][aria-selected='true'] .slash-menu-name");
      await expect.poll(async () => (await active.textContent())?.trim()).toBe("ultra");
    });
  });
});

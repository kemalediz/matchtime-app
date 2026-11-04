/**
 * A person opening the rating link MatchTime DM'd them, in their own
 * browser: the real magic link, the real page, the real submit. Shared by
 * the club rehearsal and the club scenarios.
 */
import type { Browser } from "@playwright/test";
import { E2E_BASE_URL } from "../helpers/env";

export function ratePage(
  browser: Browser,
): (linkPath: string, mom: string | undefined) => Promise<string> {
  return async (linkPath: string, mom: string | undefined): Promise<string> => {
    const context = await browser.newContext({ baseURL: E2E_BASE_URL });
    const page = await context.newPage();
    try {
      await page.goto(linkPath);
      await page.waitForURL(/\/rate/, { timeout: 60_000 });
      let picked = "no Man of the Match picked";
      // The page renders its player cards after load: wait for the submit
      // button before looking for anyone on it.
      await page
        .getByRole("button", { name: /submit/i })
        .waitFor({ timeout: 60_000 });
      if (mom) {
        const card = page.locator("div.border-amber-200");
        await card
          .getByRole("button")
          .first()
          .waitFor({ timeout: 30_000 })
          .catch(() => {});
        const btn = card
          .getByRole("button", { name: new RegExp(mom, "i") })
          .first();
        if (await btn.count()) {
          await btn.click();
          picked = `Man of the Match: ${(await btn.innerText()).replace(/\s+/g, " ").trim()}`;
        } else picked = `nobody matching /${mom}/ offered for Man of the Match`;
      }
      await page.getByRole("button", { name: /submit/i }).click();
      await page.waitForURL(/\/profile\/stats/, { timeout: 60_000 });
      return `submitted (default scores; ${picked})`;
    } catch (err) {
      return `failed at ${page.url()}: ${(err as Error).message.split("\n")[0]}`;
    } finally {
      await context.close();
    }
  };
}

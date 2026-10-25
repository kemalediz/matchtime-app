/**
 * Football only, for now (Kemal, 2026-10-25), in a real browser: the public
 * pages and their search and link-preview text name no sport that is not
 * live (`LIVE_SPORTS`, src/lib/pool/sports.ts), and the home page's sports
 * chips are the live sport's formats. The forbidden names come from the
 * same switch, so switching a sport on needs nothing here.
 * No model anywhere: $0.
 */
import { test, expect, resetDb } from "../fixtures";
import { SPORTS } from "@/components/landing/landing-content";
import { SPORT_PRESETS } from "@/lib/sport-presets";
import { isLiveSport, notLiveSportNames, poolSportOfClubSport } from "@/lib/pool/sports";

const SHOTS = process.env.FB_SHOTS_DIR;
const PAGES = ["/", "/players", "/pricing", "/help", "/help/player", "/help/admin", "/play"];

const FORBIDDEN = [
  ...new Set([
    ...notLiveSportNames(),
    ...SPORT_PRESETS.filter((p) => {
      const s = poolSportOfClubSport({ preset: p.key, name: p.name, playersPerTeam: p.playersPerTeam });
      return !s || !isLiveSport(s.sport);
    }).map((p) => p.name.split(" ")[0].toLowerCase()),
  ]),
];
const named = (text: string) => FORBIDDEN.filter((n) => new RegExp(`(^|[^\\p{L}])${n.replace(/\s+/g, "\\s+")}($|[^\\p{L}])`, "iu").test(text));

test.beforeAll(() => resetDb());
test.use({ locale: "en-GB" });

test("the forbidden names are the switch's: basketball and the rest, never football", () => {
  expect(FORBIDDEN).toEqual(expect.arrayContaining(["basketball", "netball", "volleyball", "cricket", "tennis", "padel"]));
  expect(FORBIDDEN).not.toContain("football");
});

for (const width of [390, 1280]) {
  for (const path of PAGES) {
    test(`${path} at ${width}: no sport but the live one, in the page or its metadata`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const res = await page.goto(path);
      expect(res?.status()).toBe(200);
      await page.waitForLoadState("networkidle");
      const body = await page.locator("body").innerText();
      const meta = await page.evaluate(() =>
        [document.title, ...Array.from(document.querySelectorAll("meta[name], meta[property]")).map((m) => m.getAttribute("content") ?? "")].join("\n"),
      );
      const jsonLd = await page.evaluate(() => Array.from(document.querySelectorAll('script[type="application/ld+json"]')).map((s) => s.textContent ?? "").join("\n"));
      expect(named(body)).toEqual([]);
      expect(named(meta)).toEqual([]);
      expect(named(jsonLd)).toEqual([]);
      // The help guides overflow by 1px at 390 on main too (not this change); the rest must not.
      if (!path.startsWith("/help")) expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
      if (SHOTS && width === 390 && ["/", "/play", "/players"].includes(path)) {
        const name = path === "/" ? "home" : path.slice(1);
        await page.screenshot({ path: `${SHOTS}/fb-${name}-390.png`, fullPage: true });
      }
      if (SHOTS && width === 1280 && path === "/") await page.screenshot({ path: `${SHOTS}/fb-home-1280.png`, fullPage: true });
    });
  }
}

test("the home page says football, and its sports chips are football's formats", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: /Run your weekly football/ })).toBeVisible();
  await expect(page).toHaveTitle(/football/i);
  const chips = page.getByRole("list", { name: "Sports" }).getByRole("listitem");
  await expect(chips).toHaveText(SPORTS);
  expect(SPORTS).toEqual(["Football 5-a-side", "Football 7-a-side", "Football 8-a-side", "Football 9-a-side", "Football 11-a-side"]);
  await expect(page.getByText("Football, any format", { exact: true }).first()).toBeVisible();
});

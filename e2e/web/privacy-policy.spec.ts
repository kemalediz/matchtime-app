/**
 * The privacy policy page (local player pool, slice L0).
 *
 * A signed-out visitor reads it in their browser's language (English or
 * Turkish) and can switch; it is linked from the landing page footer; it
 * reads on a phone with no sideways scroll; and it has the structure a
 * screen reader needs (one h1, a heading per section, landmarks, the
 * language marked, readable contrast). No model calls: $0.
 */
import { test, expect, signInAs, U } from "../fixtures";
import type { Page } from "@playwright/test";
import { privacyPolicy } from "@/lib/i18n/privacy-policy";
import { PRIVACY_POLICY_VERSION } from "@/lib/privacy-policy";

const EN = privacyPolicy("en");
const TR = privacyPolicy("tr");

const MOBILE = { width: 375, height: 740 };
const DESKTOP = { width: 1280, height: 900 };

async function expectPolicy(page: Page, copy: typeof EN, lang: "en" | "tr") {
  await expect(page.getByRole("heading", { level: 1, name: copy.title })).toBeVisible();
  const article = page.locator(`article[lang="${lang}"]`);
  await expect(article).toBeVisible();
  for (const s of copy.sections) {
    await expect(article.getByRole("heading", { level: 2, name: s.heading })).toHaveCount(1);
  }
  await expect(article.getByText(copy.versionLine)).toBeVisible();
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

test.describe("English visitor", () => {
  test.use({ locale: "en-GB" });

  for (const [name, size] of [["phone", MOBILE], ["desktop", DESKTOP]] as const) {
    test(`reads the policy on ${name} width with no sideways scroll`, async ({ page }) => {
      await page.setViewportSize(size);
      const res = await page.goto("/privacy");
      expect(res?.status()).toBe(200);
      await expect(page).toHaveURL(/\/privacy$/);
      await expectPolicy(page, EN, "en");
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
      // No app sidebar for a visitor, once the session check has settled.
      await page.waitForLoadState("networkidle");
      await expect(page.getByRole("link", { name: /^matches$/i })).toHaveCount(0);
    });
  }

  test("switches to Turkish and back", async ({ page }) => {
    await page.goto("/privacy");
    await expectPolicy(page, EN, "en");
    await page.getByRole("button", { name: "Türkçe" }).click();
    await expectPolicy(page, TR, "tr");
    await expect(page.getByRole("button", { name: "Türkçe" })).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "English" }).click();
    await expectPolicy(page, EN, "en");
  });

  test("the contents list jumps to a section", async ({ page }) => {
    await page.goto("/privacy");
    const contents = page.getByRole("navigation", { name: EN.contentsLabel });
    const last = EN.sections[EN.sections.length - 1];
    await contents.getByRole("link", { name: last.heading }).click();
    await expect(page).toHaveURL(new RegExp(`#${last.id}$`));
    await expect(page.getByRole("heading", { level: 2, name: last.heading })).toBeInViewport();
  });

  test("the landing page footer links to it", async ({ page }) => {
    await page.goto("/");
    // The landing footer sits inside the app shell's <main>, so it is a
    // plain <footer> element rather than the contentinfo landmark.
    const footer = page.locator("footer");
    await footer.scrollIntoViewIfNeeded();
    await footer.getByRole("link", { name: "Privacy policy" }).click();
    await page.waitForURL("**/privacy");
    await expectPolicy(page, EN, "en");
  });

  test("has one h1, landmarks, a labelled language switch and readable contrast", async ({ page }) => {
    await page.goto("/privacy");
    await expect(page.locator("h1")).toHaveCount(1);
    await expect(page.getByRole("main")).toHaveCount(1);
    await expect(page.getByRole("navigation", { name: EN.contentsLabel })).toBeVisible();
    await expect(page.getByRole("group", { name: EN.languageLabel })).toBeVisible();
    await expect(page.getByRole("button", { name: "English" })).toHaveAttribute("aria-pressed", "true");
    // Headings never skip a level: h1 then h2 only.
    const levels = await page.locator("main h1, main h2, main h3, main h4").evaluateAll((els) =>
      els.map((e) => Number(e.tagName.slice(1))),
    );
    expect(levels[0]).toBe(1);
    for (let i = 1; i < levels.length; i++) expect(levels[i] - levels[i - 1]).toBeLessThanOrEqual(1);
    // WCAG AA: 4.5:1 for body text, links and the switch.
    const ratios = await contrastRatios(page, "main h1, main h2, main p, main li, main a, main button");
    expect(ratios.length).toBeGreaterThan(40);
    const poor = ratios.filter((r) => r.ratio < 4.5);
    expect(poor).toEqual([]);
  });

  test("a signed-in member reads it too", async ({ page }) => {
    await signInAs(page, U.player);
    await page.goto("/privacy");
    await expectPolicy(page, EN, "en");
  });
});

test.describe("Turkish visitor", () => {
  test.use({ locale: "tr-TR" });

  for (const [name, size] of [["phone", MOBILE], ["desktop", DESKTOP]] as const) {
    test(`reads the policy in Turkish on ${name} width with no sideways scroll`, async ({ page }) => {
      await page.setViewportSize(size);
      await page.goto("/privacy");
      await expectPolicy(page, TR, "tr");
      expect(TR.versionLine).toContain(String(PRIVACY_POLICY_VERSION));
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    });
  }

  test("switches to English", async ({ page }) => {
    await page.goto("/privacy");
    await expectPolicy(page, TR, "tr");
    await page.getByRole("button", { name: "English" }).click();
    await expectPolicy(page, EN, "en");
  });
});

/**
 * Contrast ratio of each visible element's text against the first opaque
 * background behind it (WCAG 2 relative luminance).
 */
async function contrastRatios(page: Page, selector: string) {
  return page.locator(selector).evaluateAll((els) => {
    // Any CSS colour syntax (Tailwind 4 uses oklch) to sRGB, via a canvas.
    const ctx = document.createElement("canvas").getContext("2d")!;
    const parse = (c: string) => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = "rgba(0,0,0,0)";
      ctx.fillStyle = c;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      return { r, g, b, a: a / 255 };
    };
    const lum = ({ r, g, b }: { r: number; g: number; b: number }) => {
      const f = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const bgOf = (el: Element | null): { r: number; g: number; b: number } => {
      for (let n = el; n; n = n.parentElement) {
        const c = parse(getComputedStyle(n).backgroundColor);
        if (c && c.a >= 1) return c;
      }
      return { r: 255, g: 255, b: 255 };
    };
    return els
      .filter((el) => (el as HTMLElement).offsetParent !== null && (el.textContent ?? "").trim() !== "")
      .map((el) => {
        const fg = parse(getComputedStyle(el).color)!;
        const l1 = lum(fg);
        const l2 = lum(bgOf(el));
        const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
        return { text: (el.textContent ?? "").trim().slice(0, 40), ratio: Math.round(ratio * 100) / 100 };
      });
  });
}

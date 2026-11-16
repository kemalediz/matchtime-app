/**
 * Public marketing site: the landing page and the help guides must be
 * readable by a signed-out visitor (Kemal's ad points people at them),
 * without the empty app sidebar, and must still work for signed-in users.
 */
import { test, expect, signInAs, resetDb, U } from "../fixtures";
import { firstMonthsFree, firstMonthsFreeBadge } from "@/lib/i18n/free-period";

/** The only "free" a visitor may read: the free period, in the words the
 *  pages build from FREE_PERIOD_MONTHS (three months since 2026-10-28). */
const FIRST_FREE = firstMonthsFree("en");
const FIRST_FREE_BADGE = firstMonthsFreeBadge();
const withoutFreePeriod = (text: string) =>
  text.replaceAll(FIRST_FREE, "").replaceAll(FIRST_FREE_BADGE, "").replace(/\bfree period\b/gi, "");

test.beforeAll(async () => {
  resetDb();
});

const GUIDES: Array<[string, RegExp]> = [
  ["/help", /What MatchTime does, in one minute/i],
  ["/help/player", /The one rule: tag it for anything but In or Out/i],
  ["/help/admin", /What happens each week/i],
];

for (const [path, heading] of GUIDES) {
  test(`signed-out visitor can read ${path}`, async ({ page }) => {
    const res = await page.goto(path);
    expect(res?.status()).toBe(200);
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(page.getByText(heading).first()).toBeVisible();
    // No app sidebar (Dashboard / Matches / Profile) for a visitor.
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("link", { name: /^matches$/i })).toHaveCount(0);
  });
}

// Review 2026-11-15: /contact showed the empty app sidebar to visitors.
test("signed-out visitor reads /contact full-bleed, with no app sidebar", async ({ page }) => {
  const res = await page.goto("/contact");
  expect(res?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1, name: "Contact MatchTime" })).toBeVisible();
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("link", { name: /^matches$/i })).toHaveCount(0);
});

// Review 2026-11-15: every page named the HOME page as its canonical and
// og:url (the root layout set both). Each public page now names itself,
// and keeps the site card image (review of #605: seven pages lost it).
// Read as a fetcher that reads only the head does.
test("each public page names itself as canonical and og:url, with the site card image", async ({ request }) => {
  const FETCHER = "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)";
  for (const path of ["/", "/contact", "/pricing", "/privacy", "/players", "/help", "/help/player", "/help/admin"]) {
    const res = await request.get(path, { headers: { "user-agent": FETCHER } });
    expect(res.status(), path).toBe(200);
    const html = await res.text();
    const head = html.slice(0, html.indexOf("</head>"));
    const want = path === "/" ? /^https?:\/\/[^/]+\/?$/ : new RegExp(`^https?://[^/]+${path}$`);
    expect(head.match(/<link rel="canonical" href="([^"]+)"/)?.[1], `${path} canonical`).toMatch(want);
    expect(head.match(/<meta property="og:url" content="([^"]+)"/)?.[1], `${path} og:url`).toMatch(want);
    const og = (p: string) => head.match(new RegExp(`<meta property="og:${p}" content="([^"]+)"`))?.[1];
    const image = og("image");
    expect(image, `${path} og:image`).toMatch(/^https?:\/\/[^/]+\/opengraph-image\.png(\?.*)?$/);
    expect(og("image:width"), `${path} og:image:width`).toBe("1200");
    expect(og("image:height"), `${path} og:image:height`).toBe("630");
    expect(og("image:type"), `${path} og:image:type`).toBe("image/png");
    // The picture itself loads, with no session.
    const src = new URL(image!.replace(/&amp;/g, "&"));
    const pic = await request.get(src.pathname + src.search);
    expect(pic.status(), `${path} og:image loads`).toBe(200);
    expect(pic.headers()["content-type"], `${path} og:image type`).toContain("image/png");
  }
});

test("the price: free months first on the home teaser and on /pricing, then the price; the player guide link works", async ({ page }) => {
  expect(FIRST_FREE).toBe("Your first three months are free");
  // /pricing is the price's own page (Kemal, 2026-10-25).
  await page.goto("/pricing");
  const pricing = page.locator("#pricing");
  await expect(pricing.getByRole("heading", { level: 1, name: "Try it with your group first." })).toBeVisible();
  await expect(pricing.getByText("First three months free", { exact: true })).toBeVisible();
  await expect(pricing.getByText(/then up to £4\.99 a month for the whole group/)).toBeVisible();
  await expect(pricing.getByText(/about 25p a player/i)).toBeVisible();
  // Charged by games played, up to £4.99 a month (Kemal, 2026-10-02 and 2026-10-28); the free months first (2026-10-25).
  await expect(
    pricing.getByText(/Your first three months are free, so you can see how it runs your week before you pay\. After that it's up to £4\.99 a month per WhatsApp group, not per player, and you only pay for the weeks you play\./),
  ).toBeVisible();
  await expect(pricing.getByText(/Play 3 weeks out of 4 and it's £3\.74\. Take a month off and it's nothing\./)).toBeVisible();
  let body = withoutFreePeriod(await page.locator("body").innerText());
  expect(body).not.toMatch(/\bfree\b/i);
  expect(body).not.toMatch(/first month/i);

  await page.goto("/");
  const teaser = page.locator("#pricing");
  await teaser.scrollIntoViewIfNeeded();
  await expect(teaser.getByText("First three months free", { exact: true })).toBeVisible();
  await expect(teaser.getByRole("link", { name: "See pricing" })).toHaveAttribute("href", "/pricing");
  await expect(page.getByText(/Your first three months are free, and you can remove it from your group any time\./)).toBeVisible();
  await expect(page.getByText(/Your first three months are free, then it's up to £4\.99 a month for the whole group/)).toBeVisible();
  // Nothing on the page still claims MatchTime is free.
  body = withoutFreePeriod(await page.locator("body").innerText());
  expect(body).not.toMatch(/\bfree\b/i);
  expect(body).not.toMatch(/first month/i);
  await page.getByRole("link", { name: /read the player guide/i }).click();
  await page.waitForURL("**/help/player");
  await expect(page.getByText(/The one rule/i)).toBeVisible();
});

test("robots.txt is served and points at the sitemap", async ({ request }) => {
  const res = await request.get("/robots.txt");
  expect(res.status()).toBe(200);
  const body = await res.text();
  expect(body).toMatch(/Sitemap: .*\/sitemap\.xml/);
  expect(body).toMatch(/Disallow: \/admin/);
});

test("the organiser guide explains the club fee: games played, up to £4.99, the card, stopping", async ({ page }) => {
  await page.goto("/help/admin");
  const heading = page.getByRole("heading", { name: "Club fee", exact: true });
  await heading.scrollIntoViewIfNeeded();
  await expect(heading).toBeVisible();
  const guide = page.locator("article");
  await expect(guide.getByText(/only pay for the weeks you play: up to £4\.99 a month per WhatsApp group, VAT included/)).toBeVisible();
  await expect(guide.getByText(/adds a card/).first()).toBeVisible();
  await expect(guide.getByText(/at most about 13p a player per game/)).toBeVisible();
  await expect(guide.getByText(/Your first three months are free, counted from the day MatchTime goes live in your group\./)).toBeVisible();
  await expect(guide.getByText(/Nine days before your free period ends/)).toBeVisible();
  const text = withoutFreePeriod(await guide.innerText());
  expect(text).not.toMatch(/\bfree\b/i);
  expect(text).not.toMatch(/first month/i);
  expect(text).not.toMatch(/[—–]/);
});

test("the player guide explains the friend link and the real tag (2026-10-31)", async ({ page }) => {
  await page.goto("/help/player");
  const guide = page.locator("article");
  await expect(guide.getByText(/type @ and pick Match Time from the list/)).toBeVisible();
  await expect(guide.getByText(/Typing the name or replying to MatchTime is not enough/)).toBeVisible();
  const heading = page.getByRole("heading", { name: "2. Bringing a friend", exact: true });
  await heading.scrollIntoViewIfNeeded();
  await expect(heading).toBeVisible();
  await expect(guide.getByText(/MatchTime reacts ✉️ and DMs you a personal link for your friend/)).toBeVisible();
  await expect(guide.getByText(/They are not in the game until they send that code/)).toBeVisible();
  await expect(guide.getByText(/The link works until kick-off/)).toBeVisible();
  expect(await guide.innerText()).not.toMatch(/[—–]|waiting list/i);
});

// 2026-11-16: Next's compiler dropped the space after a highlighted word in
// a multi-line sentence holding an &apos; ("OUTon its own"). See
// src/app/__tests__/jsx-entity-space.test.ts.
test("the guides keep the space after a highlighted word", async ({ page }) => {
  const text = async (path: string) => {
    await page.goto(path);
    return ((await page.locator("article").textContent()) ?? "").replace(/\s+/g, " ");
  };
  const player = await text("/help/player");
  for (const s of [
    "MatchTime picks up IN and OUT on its own,",
    "@Match Time in your message.",
    "turn on Play elsewhere too on your profile.",
    "Daily update at 17:00. The squad so far",
    "One message is enough. No need to say",
  ]) {
    expect(player).toContain(s);
  }
  const admin = await text("/help/admin");
  expect(admin).toContain("What the group is told: Nothing is posted.");
  expect(admin).toContain("Switch on Collect match fees in Settings");
  const overview = await text("/help");
  expect(overview).toContain("OUT as normal.");
});

test("the guides say a partner club's ask is answered by replying IN to it or tapping its link (2026-11-16)", async ({ page }) => {
  await page.goto("/help/player");
  const player = page.locator("article");
  const heading = page.getByRole("heading", { name: "A partner club is a player short", exact: true });
  await heading.scrollIntoViewIfNeeded();
  await expect(heading).toBeVisible();
  // The sentences carry <code>IN</code>, so they are read as the guide's
  // text with its spacing normalised (and the space after the code element
  // must really be there: the page writes it explicitly).
  const playerText = ((await player.textContent()) ?? "").replace(/\s+/g, " ");
  expect(playerText).toContain("Reply IN to that post, or tap its link, and MatchTime confirms with you by DM.");
  expect(playerText).toContain("An IN that isn't a reply to the ask is for your own club's game, as always.");
  expect(playerText).not.toMatch(/[—–]/);

  await page.goto("/help/admin");
  const adminText = ((await page.locator("article").textContent()) ?? "").replace(/\s+/g, " ");
  expect(adminText).toContain("your players can answer it by replying IN to that post or tapping its link.");
  expect(adminText).not.toMatch(/[—–]/);
});

test("the organiser guide explains quiet hours, off for a new club, by settings or a tag (2026-10-31)", async ({ page }) => {
  await page.goto("/help/admin");
  const heading = page.getByRole("heading", { name: "9. Quiet hours", exact: true });
  await heading.scrollIntoViewIfNeeded();
  await expect(heading).toBeVisible();
  const guide = page.locator("article");
  await expect(guide.getByText(/A new club starts with quiet hours off/)).toBeVisible();
  await expect(guide.getByText("@Match Time turn on quiet hours from 23:00 to 09:00")).toBeVisible();
  await expect(guide.getByText(/A player brings a friend/)).toBeVisible();
  expect(await guide.innerText()).not.toMatch(/[—–]|waiting list/i);
});

test("signed-in admin still gets the guides", async ({ page }) => {
  await signInAs(page, U.admin);
  await page.goto("/help/admin");
  await expect(page).toHaveURL(/\/help\/admin$/);
  await expect(page.getByText(/What happens each week/i)).toBeVisible();
  // Signed-in users keep the app sidebar on the guides.
  await expect(page.getByRole("link", { name: /^matches$/i }).first()).toBeVisible();
});

test("app pages still require sign-in", async ({ page }) => {
  await page.goto("/admin/players");
  await page.waitForURL("**/login**", { timeout: 30_000 });
});

test("connecting is 'within a day' everywhere; the wait-for-GO sentence appears only once the approval hold is on", async ({ page, context }) => {
  const SENTENCE =
    "Once your club is approved, MatchTime shows you how it has read your group and waits for you to say GO before it speaks in the group.";
  // The hold is off (as in production today): the public pages do not mention GO.
  for (const path of ["/", "/help/admin"]) {
    await page.goto(path);
    const body = page.locator("body");
    await expect(body).toContainText("usually within a day");
    await expect(body).not.toContainText("same day");
    await expect(body).not.toContainText("say GO");
  }
  await expect(page.locator("body")).toContainText("Once it's in your group, MatchTime:");

  // Switched on (the test cookie, honoured only under MT_TEST_MODE=1): the
  // same pages say it at once, with nothing else to deploy.
  await context.addCookies([{ name: "mt-test-setup-hold", value: "1", url: new URL(page.url()).origin }]);
  await page.goto("/");
  await expect(page.locator("#how-it-works")).toContainText(`Sign up and we'll get your group connected, usually within a day. ${SENTENCE}`);
  await page.goto("/help/admin");
  await expect(page.locator("body")).toContainText(SENTENCE);
  await expect(page.locator("body")).toContainText("Once you have said GO, MatchTime:");
  await expect(page.locator("body")).not.toContainText("Once it's in your group, MatchTime:");
  await expect(page.locator("body")).not.toContainText("same day");
  await context.clearCookies();
});

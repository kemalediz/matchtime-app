/**
 * POOL SCENARIOS: a club's ONE share post (growth slice G3, 2026-10-24).
 * Real routes, real database, the real settings card, model-free ($0).
 *
 * The organiser opens club settings, reads the exact post on "Tell your
 * players about the player pool" and taps Send. That tap is the approval.
 * MatchTime then posts it ONCE in the players' group, in the club's
 * language, with the club's own campaign link (/play?src=club-<slug>), at
 * an allowed time: inside the club's quiet hours it waits until they end.
 * A second tap, a double tap or a reload sends nothing more, ever. A club
 * without the player pool sees no card and nothing is posted.
 *
 * What goes out is the Pi's own poll (`/api/whatsapp/due-posts`), claimed
 * as the Pi claims it, at a pinned clock.
 */
import type { Page } from "@playwright/test";
import { scenario, scenarios, expect } from "./fixtures";
import { signInAs } from "../../fixtures";
import { openSettingsCard, openSettingsTab } from "../../helpers/settings-nav";
import type { PoolClub, PoolWorld } from "./world";
import { E2E } from "../../helpers/env";
import { poolClubShareCopy } from "@/lib/i18n/pool-club-share";

const PI = { "x-api-key": E2E.WHATSAPP_API_KEY };
const MIN = 60_000;

interface Instruction {
  kind: string;
  key: string;
  text?: string;
}

/** The London wall clock now, moved by `offsetMin` on the dial (not in
 *  real time: on the night the clocks go back, two hours on can read the
 *  same as three). */
function londonClock(offsetMin: number): string {
  const [h, m] = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date()).split(":").map(Number);
  const t = (((h * 60 + m + offsetMin) % 1440) + 1440) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}

/** The club's quiet hours, set so that right now is inside them, or not. */
async function quietHours(pool: PoolWorld, club: PoolClub, nowIsQuiet: boolean): Promise<void> {
  const [from, to] = nowIsQuiet ? [londonClock(-60), londonClock(60)] : [londonClock(120), londonClock(180)];
  await pool.db.run(`UPDATE "Organisation" SET "quietHoursEnabled" = true, "quietHoursFrom" = $2, "quietHoursTo" = $3 WHERE id = $1`, [club.group.orgId, from, to]);
}

/** The Pi polls the club's group at `now` and claims what it is handed. */
async function piPoll(pool: PoolWorld, club: PoolClub, now: Date): Promise<Instruction[]> {
  pool.note(`(the Pi polls ${club.key}'s group at ${now.toISOString()})`);
  const res = await pool.request.get(`/api/whatsapp/due-posts?groupId=${encodeURIComponent(club.group.groupId)}`, {
    headers: { ...PI, "x-mt-platform-jobs": "1", "x-test-now": now.toISOString() },
  });
  expect(res.status(), await res.text()).toBe(200);
  return ((await res.json()).instructions ?? []) as Instruction[];
}

const sharePosts = (ins: readonly Instruction[]) => ins.filter((i) => i.kind === "group-message" && /\/play\?src=club-/.test(i.text ?? ""));

/** Club settings is tabs of collapsible cards since #435 (2026-10-28): the
 *  share card is on "Finding players", and is opened the way an organiser
 *  opens it. With the player pool off the tab is shown and the card is not
 *  there to open. */
async function openSettingsAsOwner(pool: PoolWorld, page: Page, club: PoolClub, opts: { card?: boolean } = {}): Promise<void> {
  const owner = await pool.userOf(club.member("owner"));
  pool.note(`${club.key}.owner opens club settings`);
  await signInAs(page, owner!.id, "/admin/settings");
  if (opts.card === false) await openSettingsTab(page, "finding");
  else await openSettingsCard(page, "pool-club-share");
  await page.waitForLoadState("networkidle");
}

const slugOf = async (pool: PoolWorld, club: PoolClub) => (await pool.db.one<{ slug: string }>(`SELECT slug FROM "Organisation" WHERE id = $1`, [club.group.orgId]))!.slug;

scenarios("a club's one share post about the player pool", () => {
  scenario("the organiser taps Send in posting hours: ONE post in the players' group, in English, with the club's link; a second tap sends nothing", async ({ pool, page }) => {
    const fnf = await pool.club("fnf", { name: "FNF", pool: { featurePlayerPool: true } });
    await quietHours(pool, fnf, false);
    await openSettingsAsOwner(pool, page, fnf);

    const text = page.getByTestId("pool-club-share-text");
    await expect(text).toBeVisible({ timeout: 30_000 });
    const shown = (await text.textContent())!;
    const code = (await pool.db.one<{ code: string }>(`SELECT code FROM "PoolCampaign" WHERE "orgId" = $1 AND source = 'club'`, [fnf.group.orgId]))!.code;
    expect(code.startsWith("club-")).toBe(true);
    expect(shown).toMatch(new RegExp(`/play\\?src=${code}$`));
    expect(code).toContain((await slugOf(pool, fnf)).slice(0, 10));

    pool.note("fnf.owner taps Send twice, fast");
    await page.getByTestId("pool-club-share-send").dblclick();
    // #435 (2026-10-28): until the Pi has posted it, the card says it is queued.
    await expect(page.getByTestId("pool-club-share-queued")).toHaveText(poolClubShareCopy("en").queuedSoon);
    await expect(page.getByTestId("pool-club-share-send")).toHaveCount(0);
    const sent = await pool.collect();
    pool.expectSent(sent, [{ to: "fnf.group", channel: "group", text: shown, sendAfter: null }]);
    expect(shown).toContain("The MatchTime player pool");
    expect(shown).toContain("Play elsewhere too");
    pool.expectNoLeaks(fnf.secrets(), { in: sent });

    const first = await piPoll(pool, fnf, new Date(Date.now() + MIN));
    expect(sharePosts(first).map((i) => i.text)).toEqual([shown]);

    pool.note("the Pi posts it; he reloads: the card says it was sent; no Send button");
    await pool.db.run(`UPDATE "BotJob" SET "sentAt" = now() WHERE "aboutKey" = $1`, [`org-${fnf.group.orgId}:pool-club-share`]);
    await page.reload();
    await openSettingsCard(page, "pool-club-share");
    await expect(page.getByTestId("pool-club-share-sent")).toContainText("Sent to your players' group on", { timeout: 30_000 });
    await expect(page.getByTestId("pool-club-share-send")).toHaveCount(0);
    pool.expectSent(await pool.collect(), []);
    expect(sharePosts(await piPoll(pool, fnf, new Date(Date.now() + 2 * MIN)))).toEqual([]);
    expect(await pool.db.one(`SELECT count(*)::int AS n FROM "SentNotification" WHERE key = $1`, [`org-${fnf.group.orgId}:pool-club-share`])).toEqual({ n: 1 });
  });

  scenario("tapped during the club's quiet hours: held until they end, then posted once", async ({ pool, page }) => {
    const fnf = await pool.club("fnf", { name: "FNF", pool: { featurePlayerPool: true } });
    await quietHours(pool, fnf, true);
    await openSettingsAsOwner(pool, page, fnf);
    await page.getByTestId("pool-club-share-send").click();
    await expect(page.getByText(/^Sent\. It goes out on .+, when your quiet hours end\.$/)).toBeVisible();

    const [job] = await pool.collect();
    expect(job).toMatchObject({ to: "fnf.group", channel: "group" });
    expect(job.sendAfter).not.toBeNull();
    const at = new Date(job.sendAfter!);
    expect(at.getTime()).toBeGreaterThan(Date.now() + 30 * MIN);
    expect(at.getTime()).toBeLessThan(Date.now() + 150 * MIN); // an hour on the dial; two in real time the night the clocks go back

    expect(sharePosts(await piPoll(pool, fnf, new Date(Date.now() + MIN)))).toEqual([]);
    expect(sharePosts(await piPoll(pool, fnf, new Date(at.getTime() - MIN)))).toEqual([]);
    expect(sharePosts(await piPoll(pool, fnf, new Date(at.getTime() + MIN)))).toHaveLength(1);
    expect(sharePosts(await piPoll(pool, fnf, new Date(at.getTime() + 5 * MIN)))).toEqual([]);
  });

  scenario("a Turkish club: the card and the post in Turkish", async ({ pool, page }) => {
    const ist = await pool.club("ist", { name: "Kadıköy FC", pool: { featurePlayerPool: true } });
    await pool.db.run(`UPDATE "Organisation" SET language = 'tr' WHERE id = $1`, [ist.group.orgId]);
    await quietHours(pool, ist, false);
    await openSettingsAsOwner(pool, page, ist);
    await expect(page.getByRole("heading", { name: "Oyuncularınıza oyuncu havuzunu anlatın" })).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Oyuncu grubuna gönder" }).click();
    // #435: queued until the Pi has posted it, in Turkish.
    await expect(page.getByTestId("pool-club-share-queued")).toHaveText(poolClubShareCopy("tr").queuedSoon);

    const [post] = sharePosts(await piPoll(pool, ist, new Date(Date.now() + MIN)));
    expect(post.text).toContain("MatchTime oyuncu havuzu");
    expect(post.text).toContain("Başka yerlerde de oyna");
    expect(post.text).not.toContain("player pool");
    pool.expectSent(await pool.collect(), [{ to: "ist.group", channel: "group", text: post.text! }]);
    pool.expectNoLeaks(ist.secrets(), { to: ["ist.group"] });
  });

  scenario("the player pool off: no card, nothing posted, no code made", async ({ pool, page }) => {
    const fnf = await pool.club("fnf", { name: "FNF", pool: { featurePlayerPool: false } });
    await quietHours(pool, fnf, false);
    await openSettingsAsOwner(pool, page, fnf, { card: false });
    await expect(page.getByTestId("pool-club-share")).toHaveCount(0);
    pool.expectSent(await pool.collect(), []);
    expect(sharePosts(await piPoll(pool, fnf, new Date(Date.now() + MIN)))).toEqual([]);
    expect(await pool.db.one(`SELECT code FROM "PoolCampaign" WHERE "orgId" = $1`, [fnf.group.orgId])).toBeNull();
  });
});

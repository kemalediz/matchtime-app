/**
 * POOL SCENARIOS: an organiser switches the player pool on for his club
 * (Kemal, 2026-10-28). Real routes, real database, the real settings card,
 * model-free ($0).
 *
 *   - a club whose only WhatsApp group is its players' group: ONE post in
 *     that group, worded for everyone, with how to use it; no admin DM at
 *     all. Off and on again sends nothing more.
 *   - a club with an admin group (HQ): the post goes to HQ only, nothing
 *     in the players' group.
 */
import type { Page } from "@playwright/test";
import { scenario, scenarios, expect } from "./fixtures";
import { signInAs } from "../../fixtures";
import type { PoolClub, PoolWorld } from "./world";
import { poolClubSwitchCopy, type PoolOnLinks } from "../../../src/lib/i18n/pool-club-switch";
import type { SentMessage } from "./transcript";

/** The links as the server built them (its own host), read off what it sent. */
function linksIn(sent: readonly SentMessage[]): PoolOnLinks {
  const text = sent.map((m) => m.text).join("\n");
  const base = /(https?:\/\/\S+?)\/admin\/settings#pool-auto-ask/.exec(text)?.[1] ?? "missing";
  return { autoAsk: `${base}/admin/settings#pool-auto-ask`, share: `${base}/admin/settings#pool-club-share` };
}

/** The club's quiet hours set well away from now, so nothing is held. */
async function noQuietHours(pool: PoolWorld, club: PoolClub): Promise<void> {
  await pool.db.run(`UPDATE "Organisation" SET "quietHoursEnabled" = false WHERE id = $1`, [club.group.orgId]);
}

async function openPoolCardAsOwner(pool: PoolWorld, page: Page, club: PoolClub): Promise<void> {
  const owner = await pool.userOf(club.member("owner"));
  pool.note(`${club.key}.owner opens the Player pool card in club settings`);
  page.on("dialog", (d) => void d.accept());
  await signInAs(page, owner!.id, "/admin/settings#player-pool");
  await expect(page.getByTestId("player-pool-switch")).toBeVisible({ timeout: 30_000 });
}

async function flip(pool: PoolWorld, page: Page, club: PoolClub, to: boolean): Promise<void> {
  pool.note(`${club.key}.owner switches the pool ${to ? "on" : "off"}`);
  const sw = page.getByTestId("player-pool-switch");
  await sw.click();
  await expect(sw).toHaveAttribute("aria-checked", String(to), { timeout: 30_000 });
  await expect(sw).toBeEnabled();
}

scenarios("switching the player pool on tells the club once", () => {
  scenario("a club with only its players' group: ONE post there with the how-to, no admin DM; off and on again sends nothing", async ({ pool, page }) => {
    const fnf = await pool.club("fnf", { name: "FNF", pool: { featurePlayerPool: false } });
    await noQuietHours(pool, fnf);
    await openPoolCardAsOwner(pool, page, fnf);
    pool.expectSent(await pool.collect(), []);

    await flip(pool, page, fnf, true);
    const sent = await pool.collect();
    const text = poolClubSwitchCopy("en").groupAnnouncement("FNF", linksIn(sent));
    pool.expectSent(sent, [{ to: "fnf.group", channel: "group", text, sendAfter: null }]);
    expect(text).toContain("*How to ask* (organisers only)");
    expect(text).toContain("• @Match Time ask the player pool for 2 players for Thursday");
    expect(text).not.toContain("Tell your players about the player pool");
    pool.expectNoLeaks(fnf.secrets(), { in: sent });
    expect(await pool.db.one(`SELECT count(*)::int AS n FROM "SentNotification" WHERE key = $1`, [`org-${fnf.group.orgId}:pool-club-on-group`])).toEqual({ n: 1 });
    expect(await pool.db.one(`SELECT count(*)::int AS n FROM "SentNotification" WHERE key = $1`, [`org-${fnf.group.orgId}:pool-club-on`])).toEqual({ n: 0 });

    await flip(pool, page, fnf, false);
    await flip(pool, page, fnf, true);
    pool.expectSent(await pool.collect(), []);
  });

  scenario("a club told by DM before (the old claim): the next switch-on posts in its players' group once", async ({ pool, page }) => {
    const fnf = await pool.club("fnf", { name: "FNF", pool: { featurePlayerPool: false } });
    await noQuietHours(pool, fnf);
    await pool.db.run(`INSERT INTO "SentNotification" (id, key, kind, "createdAt") VALUES (gen_random_uuid()::text, $1, 'pool-club-on', now())`, [`org-${fnf.group.orgId}:pool-club-on`]);
    await openPoolCardAsOwner(pool, page, fnf);
    await flip(pool, page, fnf, true);
    const sent = await pool.collect();
    pool.expectSent(sent, [{ to: "fnf.group", channel: "group", text: poolClubSwitchCopy("en").groupAnnouncement("FNF", linksIn(sent)) }]);
  });

  scenario("a Turkish club with only its players' group: the post in Turkish", async ({ pool, page }) => {
    const ist = await pool.club("ist", { name: "Kadıköy FC", pool: { featurePlayerPool: false } });
    await pool.db.run(`UPDATE "Organisation" SET language = 'tr' WHERE id = $1`, [ist.group.orgId]);
    await noQuietHours(pool, ist);
    await openPoolCardAsOwner(pool, page, ist);
    await flip(pool, page, ist, true);
    const sent = await pool.collect();
    pool.expectSent(sent, [{ to: "ist.group", channel: "group", text: poolClubSwitchCopy("tr").groupAnnouncement("Kadıköy FC", linksIn(sent)) }]);
  });

  scenario("a club with an admin group: the post goes to HQ only, nothing in the players' group", async ({ pool, page }) => {
    const fnf = await pool.club("fnf", { name: "FNF", hq: true, pool: { featurePlayerPool: false } });
    await noQuietHours(pool, fnf);
    await openPoolCardAsOwner(pool, page, fnf);
    await flip(pool, page, fnf, true);
    const sent = await pool.collect();
    pool.expectSent(sent, [{ to: "fnf.hq", channel: "hq", text: poolClubSwitchCopy("en").notice("FNF", "group", linksIn(sent)) }]);
    expect(sent.filter((m) => m.channel === "group")).toEqual([]);
  });
});

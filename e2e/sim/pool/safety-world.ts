/**
 * THE POOL SCENARIO DSL FOR NO-SHOWS, BLOCKS AND REPORTS (slice L7,
 * 2026-10-24). Helpers on top of `offers-world.ts`; kept in their own file
 * so the offers slice and this one never edit the same lines.
 *
 *   const offer = await guestPlaced(pool, page, fnf, ali);       // he took a place
 *   await gameWasPlayed(pool, fnf, { hoursAgo: 2 });             // time passes
 *   await markNoShow(pool, page, fnf, ali);                      // the match page
 *   const sent = await runCompleteMatches(pool, { now: at(fnf.kickoff, 25) });
 *
 * TIME. Taking a place runs on the real clock (the offer page), so the
 * match is in the real future then; `gameWasPlayed` moves the match into
 * the real past afterwards (as if the days went by), so the match page's
 * marking window, which reads the real clock, is open. The cron takes the
 * `x-test-now` seam like every other pinned call.
 */
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { signInAs } from "../../fixtures";
import { E2E } from "../../helpers/env";
import { nextMsgId } from "../group";
import type { SentMessage } from "./transcript";
import { at, organiserAsks, pollPlatform, tapLinkIn, tapOffer, type Spot } from "./offers-world";
import type { PoolClub, PoolPerson, PoolWorld } from "./world";

type Club = PoolClub & { kickoff: Date; spot: Spot };
type Player = PoolPerson & { userId: string };

/** The organisers ask the pool for one place and he says yes on the offer page. Returns his offer link. */
export async function guestPlaced(world: PoolWorld, page: Page, club: Club, player: Player, opts: { matchId?: string; kickoff?: Date } = {}): Promise<string> {
  const now = at(opts.kickoff ?? club.kickoff, -8);
  const ex = await organiserAsks(world, page, club, { places: 1, now, matchId: opts.matchId });
  await pollPlatform(world, { now });
  const offer = ex.sent.find((m) => m.to === player.key && m.purpose === "pool-offer");
  if (!offer) throw new Error(`no offer to ${player.key}: ${ex.sent.map((m) => `${m.to}:${m.purpose}`).join(", ")}`);
  const link = tapLinkIn(offer);
  expect(await tapOffer(world, page, link, "yes")).toBe("in");
  await world.collect();
  return link;
}

/** As if time went by: the club's match kicked off `hoursAgo` hours ago (real clock). Returns the new kickoff. */
export async function gameWasPlayed(world: PoolWorld, club: Club, opts: { hoursAgo: number; matchId?: string }): Promise<Date> {
  const kickoff = new Date(Date.now() - opts.hoursAgo * 3600_000);
  await world.db.run(`UPDATE "Match" SET date = $2, "attendanceDeadline" = $2 WHERE id = $1`, [opts.matchId ?? club.group.matchId, kickoff]);
  world.note(`(the game kicked off ${opts.hoursAgo} hours ago)`);
  return kickoff;
}

async function onMatchPageAsOwner(world: PoolWorld, page: Page, club: Club, matchId?: string): Promise<void> {
  const owner = await world.userOf(club.member("owner"));
  await signInAs(page, owner!.id, `/matches/${matchId ?? club.group.matchId}`);
  await page.goto(`/matches/${matchId ?? club.group.matchId}`);
}

/** The organiser presses "Didn't turn up" (or "Turned up") for him on the match page. */
export async function markNoShow(world: PoolWorld, page: Page, club: Club, player: Player, opts: { noShow?: boolean; matchId?: string } = {}): Promise<void> {
  const noShow = opts.noShow !== false;
  world.log({ kind: "in", from: `${club.key}.owner`, channel: "dm", text: `(match page) ${player.key} ${noShow ? "didn't turn up" : "turned up"}` });
  await onMatchPageAsOwner(world, page, club, opts.matchId);
  const row = page.getByTestId("guest-result-row").filter({ hasText: player.name!.split(" ")[0] });
  await row.getByTestId(noShow ? "guest-no-show" : "guest-turned-up").click();
  await expect(row).toHaveAttribute("data-result", noShow ? "no-show" : "played", { timeout: 20_000 });
}

/** The organiser opens his card on the match page (the Guest tag). */
export async function openGuestCard(world: PoolWorld, page: Page, club: Club, player: Player, matchId?: string): Promise<void> {
  await onMatchPageAsOwner(world, page, club, matchId);
  const row = page.getByTestId("attendance-section").locator("li", { hasText: player.name!.split(" ")[0] });
  await row.getByTestId("guest-card-open").first().click();
  await expect(page.getByTestId("guest-card")).toBeVisible();
}

/** The complete-matches cron at `now` (the guests' results are settled there). */
export async function runCompleteMatches(world: PoolWorld, opts: { now: Date; poolOpen?: boolean }): Promise<{ json: Record<string, unknown>; sent: SentMessage[] }> {
  world.note(`(the complete-matches cron runs at ${opts.now.toISOString()})`);
  const res = await world.request.get("/api/cron/complete-matches", {
    headers: { authorization: `Bearer ${E2E.CRON_SECRET}`, "x-test-now": opts.now.toISOString(), "x-mt-test-pool-open": opts.poolOpen === false ? "0" : "1" },
  });
  expect(res.status(), await res.text()).toBe(200);
  return { json: (await res.json()) as Record<string, unknown>, sent: await world.collect() };
}

export interface PlaceRow {
  result: string;
  settledAt: Date | null;
  resultById: string | null;
}

export function placeOf(world: PoolWorld, club: Club, player: Player, matchId?: string): Promise<PlaceRow | null> {
  return world.db.one<PlaceRow>(`SELECT result, "settledAt", "resultById" FROM "GuestPlace" WHERE "matchId" = $1 AND "userId" = $2`, [matchId ?? club.group.matchId, player.userId]);
}

export function profileState(world: PoolWorld, player: Player): Promise<{ status: string; pausedReason: string | null; reviewRequestedAt: Date | null } | null> {
  return world.db.one(`SELECT status, "pausedReason", "reviewRequestedAt" FROM "PoolProfile" WHERE "userId" = $1`, [player.userId]);
}

/** An earlier guest game of his at another club, already settled (his history). */
export async function pastGuestGame(world: PoolWorld, player: Player, result: "played" | "no-show" | "late-cancel", daysAgo: number): Promise<void> {
  // Any other club's activity: his results there are counts only.
  const other = await world.db.one<{ orgId: string; activityId: string }>(`SELECT a."orgId", a.id AS "activityId" FROM "Activity" a ORDER BY a."createdAt" LIMIT 1`);
  const id = `sim-past-match-${nextMsgId()}`;
  const date = new Date(Date.now() - daysAgo * 24 * 3600_000);
  await world.db.run(`INSERT INTO "Match" (id, "activityId", date, "maxPlayers", status, "attendanceDeadline", "updatedAt") VALUES ($1, $2, $3, 14, 'COMPLETED', $3, now())`, [
    id,
    other!.activityId,
    date,
  ]);
  await world.db.run(
    `INSERT INTO "GuestPlace" (id, "orgId", "matchId", "userId", source, result, "resultAt", "settledAt", "updatedAt") VALUES ($1, $2, $3, $4, 'pool', $5, $6, $6, now())`,
    [`sim-past-gp-${nextMsgId()}`, other!.orgId, id, player.userId, result, date],
  );
}

/** Owner DMs (to the approver phone) among `sent`. */
export const ownerDms = (sent: readonly SentMessage[]): SentMessage[] => sent.filter((m) => m.purpose?.startsWith("owner-"));

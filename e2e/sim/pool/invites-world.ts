/**
 * THE POOL SCENARIO DSL FOR JOINING A CLUB'S GROUP (slice L8, 2026-10-24).
 * Helpers on top of `world.ts` and `offers-world.ts` for the after-game
 * question, Invite to club, My invitations and the group link. Kept in
 * their own file so no other slice's lines move.
 *
 *   const fnf = await openClub(pool, "fnf", { name: "FNF", hq: true });
 *   const sam = await playedGuest(pool, fnf, "sam", { name: "Sam Kerr" });   // played 3 hours ago
 *   await pasteLink(pool, fnf);                                               // source B
 *   const { queued } = await piPolls(pool);                                   // the sweep asks him
 *   await openAndAnswer(browser, linkIn(queued[0]), "join");                  // My invitations
 *   await organiserTaps(pool, browser, fnf, "send");                          // the club's yes
 *   await joinsGroup(pool, fnf, sam);                                         // the group-join event
 *
 * TIME. The game is seeded in the PAST on the real clock (default: kicked
 * off 3 hours ago, an hour long), so the pages (real clock) and the Pi's
 * poll (pinned to the real now unless told) agree that it has been played.
 */
import type { Browser, Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { signInAs } from "../../fixtures";
import { E2E } from "../../helpers/env";
import { nextMsgId } from "../group";
import type { SentMessage } from "./transcript";
import type { PoolClub, PoolPerson, PoolWorld } from "./world";
import { near, poolPlayer, type Spot } from "./offers-world";

const PI = { "x-api-key": E2E.WHATSAPP_API_KEY };

/** A plausible WhatsApp invite code, as the Pi reads one. */
export const PI_CODE = "Fh3kQ9zLmP2xW7vB1nR4tY";
export const PASTED = "https://chat.whatsapp.com/Pa5tedL1nkAbCdEfGh1234";

export interface PlayedGuest extends PoolPerson {
  userId: string;
  matchId: string;
}

/** A game of the club that kicked off `hoursAgo` (completed). */
export async function pastMatch(world: PoolWorld, club: PoolClub, hoursAgo = 3, status = "COMPLETED"): Promise<{ id: string; kickoff: Date }> {
  const id = `sim-match-past-${nextMsgId()}`;
  const kickoff = new Date(Date.now() - hoursAgo * 3600_000);
  await world.db.run(
    `INSERT INTO "Match" (id, "activityId", date, "maxPlayers", status, "attendanceDeadline", "updatedAt") VALUES ($1, $2, $3, 14, $4, $3, now())`,
    [id, club.group.activityId, kickoff, status],
  );
  return { id, kickoff };
}

/**
 * Someone who played ONE game with this club as a guest, as L5a's tap-yes
 * (pool) or the partner writer (partner) leaves him: a guest membership for
 * that game, CONFIRMED on it, and his guest place with its FINAL result.
 */
export async function playedGuest(
  world: PoolWorld,
  club: PoolClub & { spot?: Spot },
  key: string,
  opts: { name?: string; lang?: "en" | "tr"; via?: "pool" | "partner"; partner?: PoolClub; hoursAgo?: number; status?: "active" | "stopped"; attendance?: "CONFIRMED" | "DROPPED" } = {},
): Promise<PlayedGuest> {
  const game = await pastMatch(world, club, opts.hoursAgo ?? 3);
  const via = opts.via ?? "pool";
  let userId: string;
  let person: PoolPerson;
  if (via === "pool") {
    const p = await poolPlayer(world, key, { name: opts.name, lang: opts.lang, at: club.spot ? near(club.spot) : { lat: 51.4, lng: -0.2 }, status: opts.status });
    userId = p.userId;
    person = p;
  } else {
    if (!opts.partner) throw new Error("playedGuest: a partner guest needs his home club (opts.partner)");
    person = opts.partner.member(key);
    userId = (await world.userOf(person))!.id;
  }
  await world.db.run(
    `INSERT INTO "Membership" (id, "userId", "orgId", role, "guestVia", "guestFromOrgId", "guestMatchId")
     VALUES ($1, $2, $3, 'PLAYER', $4, $5, $6)`,
    [`sim-gm-${nextMsgId()}`, userId, club.group.orgId, via, via === "partner" ? opts.partner!.group.orgId : null, game.id],
  );
  await world.db.run(`INSERT INTO "Attendance" (id, "matchId", "userId", status, "updatedAt") VALUES ($1, $2, $3, $4, now())`, [`sim-att-${nextMsgId()}`, game.id, userId, opts.attendance ?? "CONFIRMED"]);
  // Settled, as the complete-matches cron leaves it once the no-show window
  // closed (slice L7): the after-game question waits for a FINAL result.
  const result = (opts.attendance ?? "CONFIRMED") === "CONFIRMED" ? "played" : "withdrawn";
  await world.db.run(
    `INSERT INTO "GuestPlace" (id, "orgId", "matchId", "userId", source, "fromOrgId", result, "resultAt", "settledAt", "updatedAt") VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now(), now())`,
    [`sim-gp-${nextMsgId()}`, club.group.orgId, game.id, userId, via, via === "partner" ? opts.partner!.group.orgId : null, result],
  );
  // Seeding writes no message; nothing seen so far belongs to the scenario.
  await world.collect();
  return Object.assign(person, { userId, matchId: game.id });
}

/** Source A: the Pi reported MatchTime is an admin of the club's group. */
export async function botIsGroupAdmin(world: PoolWorld, club: PoolClub): Promise<void> {
  const g = await world.db.one<{ gid: string }>(`SELECT "whatsappGroupId" AS gid FROM "Organisation" WHERE id = $1`, [club.group.orgId]);
  await world.db.run(
    `INSERT INTO "GroupPostState" ("groupId", "botIsAdmin", "canPost", "observedAt", "updatedAt") VALUES ($1, true, true, now(), now())
     ON CONFLICT ("groupId") DO UPDATE SET "botIsAdmin" = true`,
    [g!.gid],
  );
}

/** Source B, as the settings card stores it (the card itself is Playwright's). */
export async function pasteLink(world: PoolWorld, club: PoolClub, link = PASTED): Promise<void> {
  await world.db.run(`UPDATE "Organisation" SET "groupInviteLink" = $2, "groupInviteLinkSetAt" = now() WHERE id = $1`, [club.group.orgId, link]);
}

/**
 * The Pi's platform poll at `now` (default: the real now): the sweeps run,
 * then the claim. Every job handed out is reported: a DM "sent"; an
 * invite-code job "sent" with `code` (or "failed" when `code` is null).
 */
export async function piPolls(world: PoolWorld, opts: { now?: Date; code?: string | null } = {}): Promise<{ out: SentMessage[]; queued: SentMessage[]; jobs: Array<{ id: string; kind: string; groupId?: string }> }> {
  const now = opts.now ?? new Date();
  world.note(`(the Pi polls at ${now.toISOString()})`);
  const res = await world.request.get("/api/whatsapp/platform-jobs", { headers: { ...PI, "x-test-now": now.toISOString() } });
  expect(res.status(), await res.text()).toBe(200);
  const { jobs } = (await res.json()) as { jobs: Array<{ id: string; kind: string; groupId?: string }> };
  const queued = await world.collect();
  const byId = new Map(world.sent.map((m) => [m.id, m]));
  for (const j of jobs) {
    const code = opts.code === undefined ? PI_CODE : opts.code;
    const data =
      j.kind === "invite-code"
        ? code
          ? { id: j.id, outcome: "sent", inviteCode: code }
          : { id: j.id, outcome: "failed", error: "not-authorized" }
        : { id: j.id, outcome: "sent", waMessageId: `wamid-${j.id}` };
    const r = await world.request.post("/api/whatsapp/platform-jobs", { headers: { ...PI, "x-test-now": now.toISOString() }, data });
    expect(r.status()).toBe(200);
  }
  return { out: jobs.map((j) => byId.get(j.id)).filter((m): m is SentMessage => !!m), queued, jobs };
}

/** The signed My invitations link in a DM, as a path (/r/...). */
export function linkIn(m: SentMessage): string {
  const hit = /https?:\/\/[^\s/]+(\/r\/[A-Za-z0-9_.-]+)/.exec(m.text);
  if (!hit) throw new Error(`no signed link in: ${m.text}`);
  return hit[1];
}

/** A fresh browser for one person (so the owner and the guest never share a session). */
export async function browserOf(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext();
  return ctx.newPage();
}

/** He taps the link in his DM (it signs him in), then Join or No thanks. */
export async function openAndAnswer(world: PoolWorld, page: Page, path: string, answer: "join" | "no", who: string): Promise<string> {
  world.log({ kind: "in", from: who, channel: "dm", text: `(My invitations) ${answer === "join" ? "Join" : "No thanks"}` });
  await page.goto(path);
  await page.waitForURL(/\/play\/invitations/, { timeout: 30_000 });
  const card = page.getByTestId("my-invitation").first();
  await card.getByTestId(answer === "join" ? "my-invitation-join" : "my-invitation-no").click();
  const result = card.getByTestId("my-invitation-result");
  await expect(result).toBeVisible({ timeout: 20_000 });
  return (await result.getAttribute("data-result")) ?? "";
}

/**
 * The club's owner on the Guest players page (History), opening the
 * guest's card and pressing a button: "invite" (Invite to club), "send"
 * (Send the invite link) or "not-now".
 */
export async function organiserTaps(world: PoolWorld, page: Page, club: PoolClub, button: "invite" | "send" | "not-now"): Promise<void> {
  const owner = await world.userOf(club.member("owner"));
  await signInAs(page, owner!.id, "/admin/guests?tab=history");
  world.log({ kind: "in", from: `${club.key}.owner`, channel: "dm", text: `(guest card) ${button}` });
  await page.goto("/admin/guests?tab=history");
  await page.getByTestId("guest-card-open").first().click();
  const card = page.getByTestId("guest-card");
  const id = button === "invite" ? "guest-invite" : button === "send" ? "guest-invite-send" : "guest-invite-not-now";
  await card.getByTestId(id).click();
  await expect(card.getByTestId(id)).toHaveCount(0, { timeout: 20_000 });
}

/** WhatsApp says he joined the club's group (the Pi's group-join event). */
export async function joinsGroup(world: PoolWorld, club: PoolClub, p: PoolPerson): Promise<Record<string, unknown>> {
  world.log({ kind: "in", from: p.key, channel: "group", text: "(joins the group by the invite link)" });
  const g = await world.db.one<{ gid: string }>(`SELECT "whatsappGroupId" AS gid FROM "Organisation" WHERE id = $1`, [club.group.orgId]);
  const res = await world.request.post("/api/whatsapp/group-join", { headers: PI, data: { groupId: g!.gid, phones: [p.phone] } });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

export function invitationsOf(world: PoolWorld, club: PoolClub, p: { userId: string }) {
  return world.db.all<{ id: string; status: string; origin: string; clubYesAt: Date | null; playerYesAt: Date | null; declinedBy: string | null; linkSentAt: Date | null }>(
    `SELECT id, status, origin, "clubYesAt", "playerYesAt", "declinedBy", "linkSentAt" FROM "ClubInvitation" WHERE "orgId" = $1 AND "userId" = $2 ORDER BY "createdAt"`,
    [club.group.orgId, p.userId],
  );
}

export function membershipOf(world: PoolWorld, club: PoolClub, p: { userId: string }) {
  return world.db.one<{ role: string; guestVia: string | null; guestMatchId: string | null; leftAt: Date | null }>(
    `SELECT role, "guestVia", "guestMatchId", "leftAt" FROM "Membership" WHERE "orgId" = $1 AND "userId" = $2`,
    [club.group.orgId, p.userId],
  );
}

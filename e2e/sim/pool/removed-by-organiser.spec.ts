/**
 * POOL AND FRIEND LINK SCENARIOS: a person an ORGANISER removed from a club
 * is not brought back into that club's games as a guest (Kemal, 2026-10-31).
 *
 *   removed, then the pool is asked    not offered; another club still offers him
 *   left the group himself, pool       offered, as today
 *   removed, then a friend's link      not booked, told neutrally, still a pool
 *                                      member, the link still open
 *   left the group himself, friend     booked, as today
 *   removed, re-added by the organiser offered and bookable again once he is
 *                                      not a member (the organiser's own action wins)
 *
 *   removed from the WhatsApp group    marked only when the remover the Pi
 *                                      reports is an OWNER or ADMIN of the club
 *                                      and not the person himself; an old Pi
 *                                      payload (no remover) is never marked
 *
 * The removal is the real players page Remove (the real server action); a
 * leave is the Pi's real group-leave call. Model-free ($0).
 */
import type { Page } from "@playwright/test";
import { scenario, scenarios, expect } from "./fixtures";
import { signInAs } from "../../fixtures";
import { E2E } from "../../helpers/env";
import { nextMsgId } from "../group";
import { at, extraMatch, near, openClub, organiserAsks, poolPlayer } from "./offers-world";
import type { PoolClub, PoolPerson, PoolWorld } from "./world";
import { ROSTER, friendJoins, linkFor, rowOf } from "../friend-link/world";

type Player = PoolPerson & { userId: string };
const PI = { "x-api-key": E2E.WHATSAPP_API_KEY };

/** He posted in the group once, so MatchTime added him as a NEW player. */
async function provisionalMember(pool: PoolWorld, club: PoolClub, p: Player): Promise<void> {
  await pool.db.run(`INSERT INTO "Membership" (id, "userId", "orgId", role, "provisionallyAddedAt", "createdAt") VALUES ($1, $2, $3, 'PLAYER', now(), now())`, [
    `sim-mem-${nextMsgId()}`,
    p.userId,
    club.group.orgId,
  ]);
}

async function onPlayersPage(pool: PoolWorld, page: Page, club: PoolClub): Promise<void> {
  const owner = await pool.userOf(club.member("owner"));
  await signInAs(page, owner!.id, "/admin/players");
  await page.goto("/admin/players");
}

/** The organiser presses Remove for him on the players page. */
async function organiserRemoves(pool: PoolWorld, page: Page, club: PoolClub, p: Player): Promise<void> {
  pool.log({ kind: "in", from: `${club.key}.owner`, channel: "dm", text: `(players page) Remove ${p.name}` });
  await onPlayersPage(pool, page, club);
  page.once("dialog", (d) => d.accept());
  const row = page.getByTestId(`player-row-${p.userId}`);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.getByRole("button", { name: "Remove" }).click();
  await expect(page.getByText("Player removed")).toBeVisible();
  await expect.poll(async () => (await membership(pool, club, p))?.leftAt ?? null).not.toBeNull();
}

/** The organiser adds him back by his number on the players page. */
async function organiserReAdds(pool: PoolWorld, page: Page, club: PoolClub, p: Player): Promise<void> {
  pool.log({ kind: "in", from: `${club.key}.owner`, channel: "dm", text: `(players page) Add player ${p.name} ${p.phone}` });
  await onPlayersPage(pool, page, club);
  await page.getByRole("button", { name: "Add player" }).click();
  await page.getByPlaceholder("Name (e.g. Mo)").fill(p.name ?? "");
  await page.getByPlaceholder("Phone (optional, e.g. 07952130028)").fill(`+${p.phone.replace(/^\+/, "")}`);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByText("Welcomed back an existing player")).toBeVisible();
}

/** He leaves the club's WhatsApp group himself: the Pi's group-leave as an
 *  old Pi sends it, with no remover. */
async function leavesGroupHimself(pool: PoolWorld, club: PoolClub, p: Player): Promise<void> {
  pool.log({ kind: "in", from: p.key, channel: "group", text: "(leaves the WhatsApp group)" });
  const res = await pool.request.post("/api/whatsapp/group-leave", { headers: PI, data: { groupId: club.group.groupId, phones: [p.phone.replace(/^\+/, "")] } });
  expect(res.status(), await res.text()).toBe(200);
  await pool.collect();
}

/** Somebody removes him from the club's WhatsApp group: the Pi's group-leave
 *  with the remover it resolved (phone and, when addressed by one, LID). */
async function removedFromGroupBy(pool: PoolWorld, club: PoolClub, p: Player, by: { phone?: string; lid?: string; label: string }): Promise<void> {
  pool.log({ kind: "in", from: by.label, channel: "group", text: `(removes ${p.name} from the WhatsApp group)` });
  const res = await pool.request.post("/api/whatsapp/group-leave", {
    headers: PI,
    data: {
      groupId: club.group.groupId,
      phones: [p.phone.replace(/^\+/, "")],
      ...(by.phone ? { removedByPhone: by.phone.replace(/^\+/, "") } : {}),
      ...(by.lid ? { removedByLid: by.lid } : {}),
    },
  });
  expect(res.status(), await res.text()).toBe(200);
  await pool.collect();
}

function membership(pool: PoolWorld, club: PoolClub, p: Player) {
  return pool.db.one<{ leftAt: Date | null; removedByOrganiserAt: Date | null }>(
    `SELECT "leftAt", "removedByOrganiserAt" FROM "Membership" WHERE "userId" = $1 AND "orgId" = $2`,
    [p.userId, club.group.orgId],
  );
}

scenarios("removed by an organiser: the player pool", () => {
  scenario("removed on the players page, then the pool is asked: not offered that club's game; another club still offers him", async ({ pool, page }) => {
    const fnf = await openClub(pool, "fnf", { name: "FNF", hq: true });
    const gs = await openClub(pool, "gs", { name: "Galata FC", hq: true, venue: near(fnf) });
    const ali = await poolPlayer(pool, "ali", { name: "Ali Kaya", at: near(fnf), maxMiles: 10 });
    await provisionalMember(pool, fnf, ali);

    await organiserRemoves(pool, page, fnf, ali);
    expect(await membership(pool, fnf, ali)).toMatchObject({ removedByOrganiserAt: expect.any(Date) });
    pool.expectSent(await pool.collect(), []);

    pool.note("FNF asks the pool: Ali is not offered");
    const ex = await organiserAsks(pool, page, fnf, { places: 1, now: at(fnf.kickoff, -8) });
    expect(ex.sent.filter((m) => m.to === "ali")).toEqual([]);

    pool.note("Galata FC's game three days later: still offered to Ali");
    const gsGame = await extraMatch(pool, gs, 72);
    const gx = await organiserAsks(pool, page, gs, { places: 1, now: at(gsGame.kickoff, -8), matchId: gsGame.id });
    expect(gx.sent.filter((m) => m.to === "ali").map((m) => m.purpose)).toEqual(["pool-offer"]);
    pool.expectNoLeaks(["removed", "Remove"], { to: ["ali"] });
  });

  scenario("he left the group himself, then the pool is asked: offered, as today", async ({ pool, page }) => {
    const fnf = await openClub(pool, "fnf", { name: "FNF", hq: true });
    const ali = await poolPlayer(pool, "ali", { name: "Ali Kaya", at: near(fnf) });
    await provisionalMember(pool, fnf, ali);

    await leavesGroupHimself(pool, fnf, ali);
    expect(await membership(pool, fnf, ali)).toMatchObject({ leftAt: expect.any(Date), removedByOrganiserAt: null });

    const ex = await organiserAsks(pool, page, fnf, { places: 1, now: at(fnf.kickoff, -8) });
    expect(ex.sent.filter((m) => m.to === "ali").map((m) => m.purpose)).toEqual(["pool-offer"]);
  });

  scenario("removed, then re-added by the organiser on the players page: the mark is gone, and once he has left the group himself he is offered again", async ({ pool, page }) => {
    const fnf = await openClub(pool, "fnf", { name: "FNF", hq: true });
    const ali = await poolPlayer(pool, "ali", { name: "Ali Kaya", at: near(fnf) });
    await provisionalMember(pool, fnf, ali);
    await organiserRemoves(pool, page, fnf, ali);

    await organiserReAdds(pool, page, fnf, ali);
    expect(await membership(pool, fnf, ali)).toEqual({ leftAt: null, removedByOrganiserAt: null });

    pool.note("a member is never offered his own club's game; after leaving the group himself he is a pool player like any other");
    await leavesGroupHimself(pool, fnf, ali);
    const ex = await organiserAsks(pool, page, fnf, { places: 1, now: at(fnf.kickoff, -8) });
    expect(ex.sent.filter((m) => m.to === "ali").map((m) => m.purpose)).toEqual(["pool-offer"]);
  });
});

scenarios("removed by an organiser: a friend's link", () => {
  const club = (pool: PoolWorld, key: string) => openClub(pool, key, { name: key.toUpperCase(), players: ROSTER, attendance: [] });
  const friendClub = async (pool: PoolWorld, key: string) => {
    const c = await club(pool, key);
    await pool.db.run(`UPDATE "Organisation" SET "quietHoursEnabled" = false WHERE id = $1`, [c.group.orgId]);
    return c;
  };

  scenario("removed, then a member sends him his friend link: not booked, told neutrally, still a pool member, the link still open", async ({ pool, page }) => {
    const fnf = await friendClub(pool, "fnf");
    const ali = await poolPlayer(pool, "ali", { name: "Ali Yilmaz", at: near(fnf) });
    await provisionalMember(pool, fnf, ali);
    await organiserRemoves(pool, page, fnf, ali);

    const token = await linkFor(pool, fnf);
    const j = await friendJoins(pool, "ali", token, { person: ali });
    pool.expectSent(j.sent, [{ to: "ali", purpose: "friend-not-booked", text: /^You're not booked into that game\./ }]);
    expect(await rowOf(pool, fnf.group.matchId!, ali.userId)).toBeNull();
    expect(await pool.profileOf(ali)).toMatchObject({ status: "active" });
    expect(await pool.db.one(`SELECT "usedAt" FROM "FriendLink" WHERE "orgId" = $1`, [fnf.group.orgId])).toMatchObject({ usedAt: null });
    expect(await membership(pool, fnf, ali)).toMatchObject({ leftAt: expect.any(Date), removedByOrganiserAt: expect.any(Date) });
    pool.expectNoLeaks(["removed", "Remove"], { to: ["ali"] });
  });

  scenario("Turkish: the same neutral line in his language", async ({ pool, page }) => {
    const gs = await friendClub(pool, "gs");
    const can = await poolPlayer(pool, "can", { name: "Can Demir", lang: "tr", at: near(gs) });
    await provisionalMember(pool, gs, can);
    await organiserRemoves(pool, page, gs, can);

    const token = await linkFor(pool, gs);
    const j = await friendJoins(pool, "can", token, { person: can, name: "Can Demir" });
    pool.expectSent(j.sent, [{ to: "can", purpose: "friend-not-booked", text: /^O maça kaydın yapılmadı\./ }]);
  });

  scenario("he left the group himself, then a friend link: booked, as today", async ({ pool }) => {
    const fnf = await friendClub(pool, "fnf");
    const ali = await poolPlayer(pool, "ali", { name: "Ali Yilmaz", at: near(fnf) });
    await provisionalMember(pool, fnf, ali);
    await leavesGroupHimself(pool, fnf, ali);

    const token = await linkFor(pool, fnf);
    const j = await friendJoins(pool, "ali", token, { person: ali });
    expect(j.sent.map((m) => m.purpose)).toContain("friend-booked");
    expect(await rowOf(pool, fnf.group.matchId!, ali.userId)).toMatchObject({ status: "CONFIRMED" });
  });

  scenario("removed from one club: another club's friend link still books him", async ({ pool, page }) => {
    const fnf = await friendClub(pool, "fnf");
    const gs = await friendClub(pool, "gs");
    const ali = await poolPlayer(pool, "ali", { name: "Ali Yilmaz", at: near(fnf) });
    await provisionalMember(pool, fnf, ali);
    await organiserRemoves(pool, page, fnf, ali);

    const token = await linkFor(pool, gs);
    const j = await friendJoins(pool, "ali", token, { person: ali });
    expect(j.sent.map((m) => m.purpose)).toContain("friend-booked");
    expect(await rowOf(pool, gs.group.matchId!, ali.userId)).toMatchObject({ status: "CONFIRMED" });
  });

  scenario("removed, re-added by the organiser, then left the group himself: a friend link books him again", async ({ pool, page }) => {
    const fnf = await friendClub(pool, "fnf");
    const ali = await poolPlayer(pool, "ali", { name: "Ali Yilmaz", at: near(fnf) });
    await provisionalMember(pool, fnf, ali);
    await organiserRemoves(pool, page, fnf, ali);
    await organiserReAdds(pool, page, fnf, ali);
    await leavesGroupHimself(pool, fnf, ali);

    const token = await linkFor(pool, fnf);
    const j = await friendJoins(pool, "ali", token, { person: ali });
    expect(j.sent.map((m) => m.purpose)).toContain("friend-booked");
  });
});

scenarios("removed from the WhatsApp group (the Pi reports who removed him)", () => {
  const rosterClub = async (pool: PoolWorld, key: string, name: string) => {
    const c = await openClub(pool, key, { name, hq: true, players: ROSTER, attendance: [] });
    await pool.db.run(`UPDATE "Organisation" SET "quietHoursEnabled" = false WHERE id = $1`, [c.group.orgId]);
    return c;
  };

  scenario("the club's owner removes him from the group: marked, not offered the club's game, and a friend's link does not book him", async ({ pool, page }) => {
    const fnf = await rosterClub(pool, "fnf", "FNF");
    const ali = await poolPlayer(pool, "ali", { name: "Ali Yilmaz", at: near(fnf) });
    await provisionalMember(pool, fnf, ali);

    await removedFromGroupBy(pool, fnf, ali, { phone: fnf.member("owner").phone, label: "fnf.owner" });
    expect(await membership(pool, fnf, ali)).toMatchObject({ leftAt: expect.any(Date), removedByOrganiserAt: expect.any(Date) });

    const ex = await organiserAsks(pool, page, fnf, { places: 1, now: at(fnf.kickoff, -8) });
    expect(ex.sent.filter((m) => m.to === "ali")).toEqual([]);

    const token = await linkFor(pool, fnf);
    const j = await friendJoins(pool, "ali", token, { person: ali });
    pool.expectSent(j.sent, [{ to: "ali", purpose: "friend-not-booked", text: /^You're not booked into that game\./ }]);
    expect(await pool.profileOf(ali)).toMatchObject({ status: "active" });
  });

  scenario("a club ADMIN removes him from the group: marked", async ({ pool }) => {
    const fnf = await rosterClub(pool, "fnf", "FNF");
    const ali = await poolPlayer(pool, "ali", { name: "Ali Yilmaz", at: near(fnf) });
    await provisionalMember(pool, fnf, ali);
    await removedFromGroupBy(pool, fnf, ali, { phone: fnf.member("alice").phone, label: "fnf.alice" });
    expect(await membership(pool, fnf, ali)).toMatchObject({ removedByOrganiserAt: expect.any(Date) });
  });

  scenario("a WhatsApp group admin who is not one of the club's organisers removes him: not marked, still offered", async ({ pool, page }) => {
    const fnf = await rosterClub(pool, "fnf", "FNF");
    const ali = await poolPlayer(pool, "ali", { name: "Ali Yilmaz", at: near(fnf) });
    const stranger = await pool.stranger("wa-admin", { name: "Group Admin" });
    await provisionalMember(pool, fnf, ali);

    pool.note("a player of the club who is a WhatsApp admin, then a number MatchTime does not know");
    await removedFromGroupBy(pool, fnf, ali, { phone: fnf.member("shane").phone, label: "fnf.shane" });
    expect(await membership(pool, fnf, ali)).toMatchObject({ leftAt: expect.any(Date), removedByOrganiserAt: null });
    await pool.db.run(`UPDATE "Membership" SET "leftAt" = NULL WHERE "userId" = $1 AND "orgId" = $2`, [ali.userId, fnf.group.orgId]);
    await removedFromGroupBy(pool, fnf, ali, { phone: stranger.phone, label: "wa-admin" });
    expect(await membership(pool, fnf, ali)).toMatchObject({ leftAt: expect.any(Date), removedByOrganiserAt: null });

    const ex = await organiserAsks(pool, page, fnf, { places: 1, now: at(fnf.kickoff, -8) });
    expect(ex.sent.filter((m) => m.to === "ali").map((m) => m.purpose)).toEqual(["pool-offer"]);
  });

  scenario("he leaves himself (the new Pi names him as the remover): not marked, a friend's link books him", async ({ pool }) => {
    const fnf = await rosterClub(pool, "fnf", "FNF");
    const ali = await poolPlayer(pool, "ali", { name: "Ali Yilmaz", at: near(fnf) });
    await provisionalMember(pool, fnf, ali);
    await removedFromGroupBy(pool, fnf, ali, { phone: ali.phone, label: "ali" });
    expect(await membership(pool, fnf, ali)).toMatchObject({ leftAt: expect.any(Date), removedByOrganiserAt: null });

    const token = await linkFor(pool, fnf);
    const j = await friendJoins(pool, "ali", token, { person: ali });
    expect(j.sent.map((m) => m.purpose)).toContain("friend-booked");
  });

  scenario("an organiser leaving the group himself is not marked either", async ({ pool }) => {
    const fnf = await rosterClub(pool, "fnf", "FNF");
    const alice = fnf.member("alice");
    await removedFromGroupBy(pool, fnf, { ...alice, userId: fnf.group.player("alice").userId } as Player, { phone: alice.phone, label: "fnf.alice" });
    const row = await pool.db.one<{ leftAt: Date | null; removedByOrganiserAt: Date | null }>(
      `SELECT "leftAt", "removedByOrganiserAt" FROM "Membership" WHERE "userId" = $1 AND "orgId" = $2`,
      [fnf.group.player("alice").userId, fnf.group.orgId],
    );
    expect(row).toMatchObject({ leftAt: expect.any(Date), removedByOrganiserAt: null });
  });

  scenario("an old Pi payload (no remover): not marked, exactly as before", async ({ pool, page }) => {
    const fnf = await rosterClub(pool, "fnf", "FNF");
    const ali = await poolPlayer(pool, "ali", { name: "Ali Yilmaz", at: near(fnf) });
    await provisionalMember(pool, fnf, ali);
    await leavesGroupHimself(pool, fnf, ali);
    expect(await membership(pool, fnf, ali)).toMatchObject({ leftAt: expect.any(Date), removedByOrganiserAt: null });
    const ex = await organiserAsks(pool, page, fnf, { places: 1, now: at(fnf.kickoff, -8) });
    expect(ex.sent.filter((m) => m.to === "ali").map((m) => m.purpose)).toEqual(["pool-offer"]);
  });
});

/**
 * FRIEND LINK SCENARIOS, SLICE S4: the friend sends his code and is booked
 * (2026-10-31; plan MDs/friend-link-plan-2026-10-31.md sections 1.2 and 5).
 *
 * His code makes him an active pool member (his consent) AND books him into
 * that match straight away: in, or on the bench when it is full or the
 * club's organisers pick. The players' group hears "Ali Y. (Shane's friend)
 * is in for ..." once; he gets one DM. A used link, a started or
 * called-off game, the member himself or a player already on the list is
 * not booked, and is told so. Real routes, $0.
 */
import { scenario, scenarios, expect } from "../pool/fixtures";
import { poolPlayer } from "../pool/offers-world";
import { friendClub, friendJoins, linkFor, rowOf } from "./world";

const SM = { lat: 51.36, lng: -0.19 };
const userIdOf = async (pool: Parameters<typeof friendClub>[0], phone: string) =>
  (await pool.db.one<{ id: string }>(`SELECT id FROM "User" WHERE "phoneNumber" = $1`, [phone]))?.id ?? null;

scenarios("the friend sends his code", () => {
  scenario("booked: in, the group told once, one DM to him, a pool member with consent", async ({ pool }) => {
    const fnf = await friendClub(pool, "fnf");
    const token = await linkFor(pool, fnf);
    const j = await friendJoins(pool, "ali", token);

    pool.expectSent(j.sent, [
      { to: "fnf.group", channel: "group", text: /^🙋 Ali Y\. \(Shane's friend\) is in for \w{3} \d+ \w{3}, 20:00\.$/ },
      { to: "ali", channel: "dm", purpose: "friend-booked", text: /^You're in for \*FNF\* on \w{3} \d+ \w{3}, 20:00 at Sim Arena\. Shane brought you in\.[\s\S]*You're now in the MatchTime player pool too/ },
    ]);
    const uid = (await userIdOf(pool, j.person.phone))!;
    expect(await rowOf(pool, fnf.group.matchId!, uid)).toMatchObject({ status: "CONFIRMED" });
    expect(await pool.profileOf(j.person)).toMatchObject({ status: "active", source: "friend", consentChannel: "whatsapp" });
    expect(await pool.db.one(`SELECT "guestVia", "guestMatchId" FROM "Membership" WHERE "userId" = $1 AND "orgId" = $2`, [uid, fnf.group.orgId])).toMatchObject({
      guestVia: "pool",
      guestMatchId: fnf.group.matchId,
    });
    const link = await pool.db.one<{ id: string; usedByUserId: string; outcome: string }>(`SELECT id, "usedByUserId", outcome FROM "FriendLink" WHERE "orgId" = $1`, [fnf.group.orgId]);
    expect(link).toMatchObject({ usedByUserId: uid, outcome: "in" });
    expect(await pool.db.one(`SELECT source, result FROM "GuestPlace" WHERE "friendLinkId" = $1`, [link!.id])).toMatchObject({ source: "pool", result: "booked" });
    pool.expectNoLeaks(j.person.phoneVariants(), { to: ["fnf.group"] });
  });

  scenario("the match is full: the bench, and the group and he are told so", async ({ pool }) => {
    const fnf = await friendClub(pool, "fnf", { maxPlayers: 2, confirmed: ["owner", "dan"] });
    const token = await linkFor(pool, fnf);
    const j = await friendJoins(pool, "ali", token);
    pool.expectSent(j.sent, [
      { to: "fnf.group", text: /^🙋 Ali Y\. \(Shane's friend\) is on the bench for / },
      { to: "ali", purpose: "friend-booked", text: /^You're on the bench for \*FNF\*.*The squad is full; if a place opens I'll tell you\./ },
    ]);
    expect(await rowOf(pool, fnf.group.matchId!, (await userIdOf(pool, j.person.phone))!)).toMatchObject({ status: "BENCH" });
  });

  scenario("an organiser-pick club: the bench, and the organisers are told how to put him in", async ({ pool }) => {
    const fnf = await friendClub(pool, "fnf");
    await pool.db.run(`UPDATE "Organisation" SET "benchPickMode" = 'organiser' WHERE id = $1`, [fnf.group.orgId]);
    const token = await linkFor(pool, fnf);
    const j = await friendJoins(pool, "ali", token);
    pool.expectSent(j.sent, [
      { to: "fnf.group", text: /is on the bench for .*\*@Match Time put Ali Y\. in\*/ },
      { to: "ali", text: /The organisers pick who plays from the bench\./ },
    ]);
  });

  scenario("a moved game: the link follows it and he is booked for the new time", async ({ pool }) => {
    const fnf = await friendClub(pool, "fnf");
    const token = await linkFor(pool, fnf);
    await pool.db.run(`UPDATE "Match" SET date = date + interval '1 day' WHERE id = $1`, [fnf.group.matchId]);
    const j = await friendJoins(pool, "ali", token);
    expect(j.sent.map((m) => m.purpose)).toContain("friend-booked");
  });

  scenario("a called-off game: he is a pool member, not booked, and told it was called off", async ({ pool }) => {
    const fnf = await friendClub(pool, "fnf");
    const token = await linkFor(pool, fnf);
    const ali = await pool.stranger("ali", { name: "Ali Yilmaz" });
    const a = await pool.signUp({ name: "Ali Yilmaz", friendToken: token });
    await pool.db.run(`UPDATE "Match" SET status = 'CANCELLED' WHERE id = $1`, [fnf.group.matchId]);
    const ex = await ali.dm(a.prefill!);
    pool.expectSent(ex.sent, [{ to: "ali", purpose: "friend-not-booked", text: /^You're in the MatchTime player pool now, so you'll hear about games near you\.\nThat game was called off\./ }]);
    expect(await pool.profileOf(ali)).toMatchObject({ status: "active" });
    expect(await pool.db.one(`SELECT "usedAt" FROM "FriendLink" WHERE "orgId" = $1`, [fnf.group.orgId])).toMatchObject({ usedAt: null });
  });

  scenario("after kick-off: his code has died with the game, nothing booked", async ({ pool }) => {
    const fnf = await friendClub(pool, "fnf", { upcomingMatch: { hoursFromNow: 2 } });
    const token = await linkFor(pool, fnf);
    const ali = await pool.stranger("ali", { name: "Ali Yilmaz" });
    const a = await pool.signUp({ name: "Ali Yilmaz", friendToken: token });
    await pool.db.run(`UPDATE "Match" SET date = now() - interval '1 minute' WHERE id = $1`, [fnf.group.matchId]);
    await pool.db.run(`UPDATE "PoolProfile" SET "confirmCodeExpiresAt" = now() - interval '1 minute' WHERE "confirmCode" = $1`, [a.code]);
    const ex = await ali.dm(a.prefill!);
    expect(ex.sent.map((m) => m.purpose)).toEqual(["pool-code-reply"]);
    expect(ex.sent[0].text).toMatch(/expired/);
    expect(await pool.db.count(`SELECT count(*) FROM "GuestPlace" WHERE "matchId" = $1`, [fnf.group.matchId])).toBe(0);
  });

  scenario("already a pool member: booked with his own profile, no second one", async ({ pool }) => {
    const fnf = await friendClub(pool, "fnf");
    const ali = await poolPlayer(pool, "ali", { name: "Ali Yilmaz", at: SM });
    const token = await linkFor(pool, fnf);
    const j = await friendJoins(pool, "ali", token, { person: ali });
    pool.expectSent(j.sent, [
      { to: "fnf.group", text: /Ali Y\. \(Shane's friend\) is in for/ },
      { to: "ali", purpose: "friend-booked", text: /^You're in for \*FNF\*/ },
    ]);
    expect(j.sent[1].text).not.toMatch(/now in the MatchTime player pool/);
    expect(await pool.db.count(`SELECT count(*) FROM "PoolProfile" WHERE "userId" = $1`, [ali.userId])).toBe(1);
    expect(await pool.db.count(`SELECT count(*) FROM "PoolProfile" WHERE "confirmCode" = $1`, [j.code])).toBe(0);
    expect(await rowOf(pool, fnf.group.matchId!, ali.userId)).toMatchObject({ status: "CONFIRMED" });
  });

  scenario("a stopped pool profile: his code is fresh consent, active again and booked (D6)", async ({ pool }) => {
    const fnf = await friendClub(pool, "fnf");
    const ali = await poolPlayer(pool, "ali", { name: "Ali Yilmaz", at: SM, status: "stopped" });
    const token = await linkFor(pool, fnf);
    const j = await friendJoins(pool, "ali", token, { person: ali });
    expect(j.sent.map((m) => m.purpose)).toContain("friend-booked");
    expect(await pool.profileOf(ali)).toMatchObject({ status: "active", source: "friend" });
    expect(await pool.db.count(`SELECT count(*) FROM "PoolProfile" WHERE "userId" = $1`, [ali.userId])).toBe(1);
  });

  scenario("paused for reports: not booked, told neutrally, the link still open", async ({ pool }) => {
    const fnf = await friendClub(pool, "fnf");
    const ali = await poolPlayer(pool, "ali", { name: "Ali Yilmaz", at: SM, status: "paused" });
    await pool.db.run(`UPDATE "PoolProfile" SET "pausedReason" = 'reports' WHERE "userId" = $1`, [ali.userId]);
    const token = await linkFor(pool, fnf);
    const j = await friendJoins(pool, "ali", token, { person: ali });
    pool.expectSent(j.sent, [{ to: "ali", purpose: "friend-not-booked", text: /^You're not booked into that game\./ }]);
    expect(await pool.db.one(`SELECT "usedAt" FROM "FriendLink" WHERE "orgId" = $1`, [fnf.group.orgId])).toMatchObject({ usedAt: null });
  });

  scenario("a club member's number with no pool profile: booked as a member, the profile on his account", async ({ pool }) => {
    const fnf = await friendClub(pool, "fnf");
    const token = await linkFor(pool, fnf, "shane");
    const pete = fnf.member("pete");
    const j = await friendJoins(pool, "pete", token, { person: pete, name: "Pete Power" });
    expect(j.sent.map((m) => m.purpose)).toContain("friend-booked");
    const uid = fnf.group.player("pete").userId;
    expect(await rowOf(pool, fnf.group.matchId!, uid)).toMatchObject({ status: "CONFIRMED" });
    expect(await pool.db.one(`SELECT "guestVia" FROM "Membership" WHERE "userId" = $1 AND "orgId" = $2`, [uid, fnf.group.orgId])).toMatchObject({ guestVia: null });
    expect(await pool.db.one(`SELECT status FROM "PoolProfile" WHERE "userId" = $1`, [uid])).toMatchObject({ status: "active" });
  });

  scenario("the member uses his own link: not booked, told to say IN in the group", async ({ pool }) => {
    const fnf = await friendClub(pool, "fnf");
    const token = await linkFor(pool, fnf, "shane");
    const j = await friendJoins(pool, "shane", token, { person: fnf.member("shane"), name: "Shane Smith" });
    pool.expectSent(j.sent, [{ to: "fnf.shane", purpose: "friend-not-booked", text: /That link is for a friend of yours\. To play yourself, say IN in the club's group\./ }]);
    expect(await rowOf(pool, fnf.group.matchId!, fnf.group.player("shane").userId)).toBeNull();
  });

  scenario("already on the list: not booked again, told so", async ({ pool }) => {
    const fnf = await friendClub(pool, "fnf");
    const token = await linkFor(pool, fnf, "shane");
    const j = await friendJoins(pool, "dan", token, { person: fnf.member("dan"), name: "Dan Drummer" });
    pool.expectSent(j.sent, [{ to: "fnf.dan", purpose: "friend-not-booked", text: /You're already on the list for that game\./ }]);
  });

  scenario("the same code message delivered twice: one booking, one group post, one DM", async ({ pool }) => {
    const fnf = await friendClub(pool, "fnf");
    const token = await linkFor(pool, fnf);
    const j = await friendJoins(pool, "ali", token);
    expect(j.sent).toHaveLength(2);
    const again = await j.person.dm(j.prefill, { messageId: j.messageId });
    expect(again.sent).toEqual([]);
    expect(await pool.db.count(`SELECT count(*) FROM "GuestPlace" WHERE "matchId" = $1`, [fnf.group.matchId])).toBe(1);
  });

  scenario("one link forwarded to two people: the first is booked, the second is a pool member told the place was taken", async ({ pool }) => {
    const fnf = await friendClub(pool, "fnf");
    const token = await linkFor(pool, fnf);
    const ali = await pool.stranger("ali", { name: "Ali Yilmaz" });
    const can = await pool.stranger("can", { name: "Can Demir" });
    const a1 = await pool.signUp({ name: "Ali Yilmaz", friendToken: token });
    const a2 = await pool.signUp({ name: "Can Demir", friendToken: token });
    expect((await ali.dm(a1.prefill!)).sent.map((m) => m.purpose)).toEqual([null, "friend-booked"]);
    const second = await can.dm(a2.prefill!);
    pool.expectSent(second.sent, [{ to: "can", purpose: "friend-not-booked", text: /The place on that link was already taken, so you're not booked into that game\./ }]);
    expect(await pool.profileOf(can)).toMatchObject({ status: "active" });
  });

  scenario("two friends for the last place at once: one in, one on the bench", async ({ pool }) => {
    const fnf = await friendClub(pool, "fnf", { maxPlayers: 3, confirmed: ["owner", "dan"] });
    const t1 = await linkFor(pool, fnf, "shane", "Ali");
    const t2 = await linkFor(pool, fnf, "pete", "Can");
    const ali = await pool.stranger("ali", { name: "Ali Yilmaz" });
    const can = await pool.stranger("can", { name: "Can Demir" });
    const a1 = await pool.signUp({ name: "Ali Yilmaz", friendToken: t1 });
    const a2 = await pool.signUp({ name: "Can Demir", friendToken: t2 });
    await Promise.all([ali.dm(a1.prefill!), can.dm(a2.prefill!)]);
    const rows = await pool.db.all<{ status: string }>(
      `SELECT a.status FROM "Attendance" a JOIN "GuestPlace" g ON g."userId" = a."userId" AND g."matchId" = a."matchId" WHERE a."matchId" = $1 ORDER BY a.status`,
      [fnf.group.matchId],
    );
    expect(rows.map((r) => r.status).sort()).toEqual(["BENCH", "CONFIRMED"]);
  });

  scenario("quiet hours: the group post waits, his DM does not", async ({ pool }) => {
    const fnf = await friendClub(pool, "fnf");
    await pool.db.run(`UPDATE "Organisation" SET "quietHoursEnabled" = true, "quietHoursFrom" = '00:00', "quietHoursTo" = '23:59' WHERE id = $1`, [fnf.group.orgId]);
    const token = await linkFor(pool, fnf);
    const j = await friendJoins(pool, "ali", token);
    const group = j.sent.find((m) => m.channel === "group")!;
    const dm = j.sent.find((m) => m.purpose === "friend-booked")!;
    expect(group.sendAfter).not.toBeNull();
    expect(dm.sendAfter).toBeNull();
  });

  scenario("a club with HQ: the players' group still hears it (D8), HQ is not told separately", async ({ pool }) => {
    const fnf = await friendClub(pool, "fnf", { hq: true });
    const token = await linkFor(pool, fnf);
    const j = await friendJoins(pool, "ali", token);
    pool.expectSent(j.sent, [
      { to: "fnf.group", channel: "group", text: /Ali Y\. \(Shane's friend\) is in for/ },
      { to: "ali", purpose: "friend-booked" },
    ]);
  });
});

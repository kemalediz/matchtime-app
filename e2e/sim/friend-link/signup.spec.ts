/**
 * FRIEND LINK SCENARIOS, SLICE S3: the friend fills in /play from his link
 * (2026-10-31). The sign-up waits for his code like any other, but carries
 * the link (source "friend", the member as referrer) and its code dies at
 * kick-off when that is sooner. A link that was used, or whose game started
 * or was called off, makes nothing. Nothing is sent to anyone. $0.
 */
import { scenario, scenarios, expect } from "../pool/fixtures";
import { friendClub, linkFor } from "./world";
import type { PoolWorld } from "../pool/world";

const profilesFrom = (pool: PoolWorld, orgId: string) =>
  pool.db.count(`SELECT count(*) FROM "PoolProfile" p JOIN "FriendLink" f ON f.id = p."friendLinkId" WHERE f."orgId" = $1`, [orgId]);

scenarios("the friend signs up from his link", () => {
  scenario("a sign-up from the link: waiting, source friend, Shane the referrer, nothing sent", async ({ pool }) => {
    const fnf = await friendClub(pool, "fnf");
    const token = await linkFor(pool, fnf);
    const a = await pool.signUp({ name: "Ali Yilmaz", friendToken: token });
    expect(a.status).toBe(200);
    expect(a.ok).toBe(true);
    expect(a.sent).toEqual([]);
    const row = await pool.pendingByCode(a.code!);
    expect(row).toMatchObject({ status: "pending-verify", source: "friend", referrerUserId: fnf.group.player("shane").userId, displayName: "Ali Yilmaz" });
    expect(row!.friendLinkId).toBeTruthy();
    const kickoff = (await pool.db.one<{ date: Date }>(`SELECT date FROM "Match" WHERE id = $1`, [fnf.group.matchId]))!.date;
    expect(new Date(row!.confirmCodeExpiresAt as Date).getTime()).toBeLessThanOrEqual(kickoff.getTime());
  });

  scenario("a used link makes nothing", async ({ pool }) => {
    const fnf = await friendClub(pool, "fnf");
    const token = await linkFor(pool, fnf);
    await pool.db.run(`UPDATE "FriendLink" SET "usedAt" = now(), "usedMessageId" = 'wamid.used-' || id, outcome = 'in' WHERE "orgId" = $1`, [fnf.group.orgId]);
    const a = await pool.signUp({ friendToken: token });
    expect(a).toMatchObject({ status: 409, ok: false, reason: "link-closed" });
    expect(await profilesFrom(pool, fnf.group.orgId)).toBe(0);
  });

  scenario("after kick-off, or a called-off game: nothing", async ({ pool }) => {
    const fnf = await friendClub(pool, "fnf");
    const token = await linkFor(pool, fnf);
    await pool.db.run(`UPDATE "Match" SET date = now() - interval '1 minute' WHERE id = $1`, [fnf.group.matchId]);
    expect(await pool.signUp({ friendToken: token })).toMatchObject({ status: 409, reason: "link-closed" });
    await pool.db.run(`UPDATE "Match" SET date = now() + interval '2 days', status = 'CANCELLED' WHERE id = $1`, [fnf.group.matchId]);
    expect(await pool.signUp({ friendToken: token })).toMatchObject({ status: 409, reason: "link-closed" });
    expect(await profilesFrom(pool, fnf.group.orgId)).toBe(0);
  });

  scenario("a token we did not sign is refused", async ({ pool }) => {
    const before = await pool.db.count(`SELECT count(*) FROM "PoolProfile"`);
    await friendClub(pool, "fnf");
    expect(await pool.signUp({ friendToken: "clnotreal.AAAAAAAAAAAAAAAAAAAAAA" })).toMatchObject({ status: 409, reason: "link-closed" });
    expect(await pool.db.count(`SELECT count(*) FROM "PoolProfile"`)).toBe(before);
  });
});

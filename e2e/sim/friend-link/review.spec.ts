/**
 * FRIEND LINK, THE REVIEW OF #488 (2026-11-01). The reviewer's proofs
 * (R1 to R8) as real scenarios, plus the fixes they asked for:
 *
 *   R1  a stopped profile still paused for reports or by hand: not booked,
 *       not reactivated, the pause kept.
 *   R2  a stopped profile paused for no-shows: booked, reactivated IN PLACE
 *       (same row, share code kept) with fresh consent, the pause kept.
 *   R3  the capped group message delivered twice: one resend DM.
 *   R6  an existing pool member resending his code after booking: silent.
 *   R7  his code twice at once: booked, never told the place was taken.
 *   R8  a new friend resending his code after booking: silent.
 *   8   the code follows a moved kick-off.
 *   12  he pulls out himself, by WhatsApp (his own words, the pool reply
 *       reader, stubbed) and by the button on his link's page; the group is
 *       told like any OUT; late is a late cancel.
 * $0: the reply reader is stubbed.
 */
import { scenario, scenarios, expect } from "../pool/fixtures";
import { poolPlayer } from "../pool/offers-world";
import { signInAs } from "../../fixtures";
import { clearPoolReplyStub, setPoolReplyStub } from "../../helpers/stub";
import { friendClub, friendJoins, linkFor, rowOf, say, unnamedFriend } from "./world";

const SM = { lat: 51.36, lng: -0.19 };
const NOT_A_CODE = /wrong|isn't right|not right|didn't work|expired|doesn't exist/i;

scenarios("review of #488: profiles that exist already", () => {
  scenario("R1 a stopped profile still paused for reports: not booked, not reactivated, the pause kept", async ({ pool }) => {
    const fnf = await friendClub(pool, "fnf");
    const ali = await poolPlayer(pool, "ali", { name: "Ali Yilmaz", at: SM, status: "stopped" });
    await pool.db.run(`UPDATE "PoolProfile" SET "pausedReason" = 'reports', "pausedAt" = now() WHERE "userId" = $1`, [ali.userId]);
    const token = await linkFor(pool, fnf);
    const j = await friendJoins(pool, "ali", token, { person: ali });
    pool.expectSent(j.sent, [{ to: "ali", purpose: "friend-not-booked", text: /^You're not booked into that game\./ }]);
    expect(await rowOf(pool, fnf.group.matchId!, ali.userId)).toBeNull();
    expect(await pool.db.one(`SELECT status, "pausedReason" FROM "PoolProfile" WHERE "userId" = $1`, [ali.userId])).toEqual({ status: "stopped", pausedReason: "reports" });
  });

  scenario("R2 a stopped profile paused for no-shows: booked, the same row active again with fresh consent, the pause kept", async ({ pool }) => {
    const fnf = await friendClub(pool, "fnf");
    const ali = await poolPlayer(pool, "ali", { name: "Ali Yilmaz", at: SM, status: "stopped" });
    await pool.db.run(`UPDATE "PoolProfile" SET "pausedReason" = 'no-shows', "pausedAt" = now() - interval '3 days', "shareCode" = 'ALISHARE1' WHERE "userId" = $1`, [ali.userId]);
    const before = await pool.db.one<{ id: string }>(`SELECT id FROM "PoolProfile" WHERE "userId" = $1`, [ali.userId]);
    const token = await linkFor(pool, fnf);
    const j = await friendJoins(pool, "ali", token, { person: ali });
    expect(j.sent.map((m) => m.purpose)).toContain("friend-booked");
    expect(await rowOf(pool, fnf.group.matchId!, ali.userId)).toMatchObject({ status: "CONFIRMED" });
    const after = await pool.db.one<Record<string, unknown>>(`SELECT id, status, "pausedReason", "shareCode", "consentChannel", "consentEvidence", "stoppedAt" FROM "PoolProfile" WHERE "userId" = $1`, [ali.userId]);
    expect(after).toMatchObject({ id: before!.id, status: "paused", pausedReason: "no-shows", shareCode: "ALISHARE1", consentChannel: "whatsapp", consentEvidence: j.messageId, stoppedAt: null });
    expect(await pool.db.count(`SELECT count(*) FROM "PoolConsentRecord" WHERE "userId" = $1 AND action = 'consent' AND evidence = $2`, [ali.userId, j.messageId])).toBe(1);
    expect(await pool.db.count(`SELECT count(*) FROM "PoolProfile" WHERE "confirmCode" = $1`, [j.code])).toBe(0);
  });

  scenario("R6 an existing pool member resends his code after he is booked: silent", async ({ pool }) => {
    const fnf = await friendClub(pool, "fnf");
    const ali = await poolPlayer(pool, "ali", { name: "Ali Yilmaz", at: SM });
    const token = await linkFor(pool, fnf);
    const j = await friendJoins(pool, "ali", token, { person: ali });
    const again = await ali.dm(j.prefill);
    expect(again.sent).toEqual([]);
  });

  scenario("R7 an existing pool member's code twice at once: booked, never told the place was taken", async ({ pool }) => {
    const fnf = await friendClub(pool, "fnf");
    const ali = await poolPlayer(pool, "ali", { name: "Ali Yilmaz", at: SM });
    const token = await linkFor(pool, fnf);
    const a = await pool.signUp({ name: "Ali Yilmaz", friendToken: token });
    const [x, y] = await Promise.all([ali.dm(a.prefill!), ali.dm(a.prefill!)]);
    const all = [...x.sent, ...y.sent];
    expect(await rowOf(pool, fnf.group.matchId!, ali.userId)).toMatchObject({ status: "CONFIRMED" });
    expect(all.filter((m) => m.purpose === "friend-not-booked" || NOT_A_CODE.test(m.text))).toEqual([]);
    expect(all.filter((m) => m.purpose === "friend-booked")).toHaveLength(1);
  });

  scenario("R8 a new friend resends his code after he is booked: silent", async ({ pool }) => {
    const fnf = await friendClub(pool, "fnf");
    const token = await linkFor(pool, fnf);
    const j = await friendJoins(pool, "ali", token);
    const again = await j.person.dm(j.prefill);
    expect(again.sent).toEqual([]);
  });
});

scenarios("review of #488: the link and the code", () => {
  scenario("R3 the capped group message delivered twice: ONE resend DM", async ({ pool }) => {
    const fnf = await friendClub(pool, "fnf");
    for (let i = 0; i < 3; i++) await say(pool, fnf, "shane", "+1", unnamedFriend("+1"), { route: "offer" });
    const first = await say(pool, fnf, "shane", "+1", unnamedFriend("+1"), { route: "offer", waMessageId: "capped-msg-1" });
    const again = await say(pool, fnf, "shane", "+1", unnamedFriend("+1"), { route: "offer", waMessageId: "capped-msg-1" });
    expect(first.sent).toHaveLength(1);
    expect(again.sent).toEqual([]);
  });

  scenario("8 the game moves later after he signed up: his code still works and books him", async ({ pool }) => {
    const fnf = await friendClub(pool, "fnf", { upcomingMatch: { hoursFromNow: 2 } });
    const token = await linkFor(pool, fnf);
    const ali = await pool.stranger("ali", { name: "Ali Yilmaz" });
    const a = await pool.signUp({ name: "Ali Yilmaz", friendToken: token });
    // The old kick-off has passed, the game is now tomorrow.
    await pool.db.run(`UPDATE "PoolProfile" SET "confirmCodeExpiresAt" = now() - interval '1 minute' WHERE "confirmCode" = $1`, [a.code]);
    await pool.db.run(`UPDATE "Match" SET date = now() + interval '1 day' WHERE id = $1`, [fnf.group.matchId]);
    const ex = await ali.dm(a.prefill!);
    expect(ex.sent.map((m) => m.purpose)).toContain("friend-booked");
  });

  scenario("8 the game moves earlier, to before his code: the code has died with it", async ({ pool }) => {
    const fnf = await friendClub(pool, "fnf");
    const token = await linkFor(pool, fnf);
    const ali = await pool.stranger("ali", { name: "Ali Yilmaz" });
    const a = await pool.signUp({ name: "Ali Yilmaz", friendToken: token });
    await pool.db.run(`UPDATE "Match" SET date = now() - interval '1 minute' WHERE id = $1`, [fnf.group.matchId]);
    const ex = await ali.dm(a.prefill!);
    expect(ex.sent.map((m) => m.purpose)).toEqual(["pool-code-reply"]);
    expect(ex.sent[0].text).toMatch(/expired/);
  });
});

scenarios("review of #488: he pulls out himself", () => {
  scenario.afterEach(() => clearPoolReplyStub());

  scenario("12a by WhatsApp: 'can't make it Monday' gives his place back, the group is told, he is told", async ({ pool }) => {
    const fnf = await friendClub(pool, "fnf");
    const token = await linkFor(pool, fnf);
    const j = await friendJoins(pool, "ali", token);
    const uid = (await pool.userOf(j.person))!.id;
    await pool.db.run(`UPDATE "PlatformJob" SET status = 'sent', "sentAt" = now() - interval '1 minute' WHERE purpose = 'friend-booked'`);
    pool.arm(() => setPoolReplyStub({ bodies: { "sorry can't make it Monday": "decline" } }));
    const ex = await j.person.dm("sorry can't make it Monday");
    pool.expectSent(ex.sent, [
      { to: "fnf.group", channel: "group", text: /^Ali Y\. \(Shane's friend\) can no longer play on \w{3} \d+ \w{3}, 20:00\. The place is open again\.$/ },
      { to: "ali", purpose: "friend-out", text: /^You've given your place back for \*FNF\* on .*\. You stay in the MatchTime player pool\./ },
    ]);
    expect(await rowOf(pool, fnf.group.matchId!, uid)).toMatchObject({ status: "DROPPED" });
    expect(await pool.db.one(`SELECT result FROM "GuestPlace" WHERE "matchId" = $1 AND "userId" = $2`, [fnf.group.matchId, uid])).toMatchObject({ result: "withdrawn" });
  });

  scenario("12a late, inside the club's cut-off: a late cancel", async ({ pool }) => {
    const fnf = await friendClub(pool, "fnf");
    const token = await linkFor(pool, fnf);
    const j = await friendJoins(pool, "ali", token);
    const uid = (await pool.userOf(j.person))!.id;
    await pool.db.run(`UPDATE "Match" SET date = now() + interval '1 hour' WHERE id = $1`, [fnf.group.matchId]);
    await pool.db.run(`UPDATE "PlatformJob" SET status = 'sent', "sentAt" = now() - interval '1 minute' WHERE purpose = 'friend-booked'`);
    pool.arm(() => setPoolReplyStub({ bodies: { "can't come any more": "decline" } }));
    await j.person.dm("can't come any more");
    expect(await pool.db.one(`SELECT result FROM "GuestPlace" WHERE "matchId" = $1 AND "userId" = $2`, [fnf.group.matchId, uid])).toMatchObject({ result: "late-cancel" });
  });

  scenario("12b the button on his link's page, signed in as him; a forwarded link shows no button", async ({ pool, page }) => {
    const fnf = await friendClub(pool, "fnf");
    const token = await linkFor(pool, fnf);
    const j = await friendJoins(pool, "ali", token);
    const uid = (await pool.userOf(j.person))!.id;
    expect(j.sent.find((m) => m.purpose === "friend-booked")?.text).toMatch(/Can't make it\? Give your place back here: https?:\/\/\S+/);

    await page.goto(`/play/f/${token}`);
    await expect(page.getByTestId("friend-link-closed")).toHaveAttribute("data-state", "used");
    await expect(page.getByRole("button", { name: "I can't make it" })).toHaveCount(0);

    await signInAs(page, uid, `/play/f/${token}`);
    await page.goto(`/play/f/${token}`);
    await page.getByRole("button", { name: "I can't make it" }).click();
    await expect(page.getByTestId("friend-link-held")).toHaveAttribute("data-state", "out", { timeout: 20_000 });
    expect(await rowOf(pool, fnf.group.matchId!, uid)).toMatchObject({ status: "DROPPED" });
    const sent = await pool.collect();
    expect(sent.filter((m) => m.to === "fnf.group" && /can no longer play/.test(m.text))).toHaveLength(1);
  });
});

/**
 * FRIEND LINK SCENARIOS, SLICE S5: he pays like any guest (2026-10-31).
 *
 *   - a weekly club: the card and his DM state the match fee, and after the
 *     game the club's own pay link reaches his number (payment-flow.ts
 *     releaseMatchPayments, unchanged: every CONFIRMED row but the
 *     collector's).
 *   - a monthly club (Vets MNF): the fee is the club's PAYG price, and he
 *     is a PAYG player of that one game: no month membership, no credit,
 *     not "paid by the month" (paymentMethod null), so the PAYG charge
 *     after the game is his.
 *
 * No new money code: these prove the existing flows reach him. $0 (the
 * fee reader is stubbed).
 */
import { scenario, scenarios, expect } from "../pool/fixtures";
import { E2E } from "../../helpers/env";
import { clearFeeReplyStub, setFeeReplyStub } from "../../helpers/stub";
import { formatLondon } from "@/lib/london-time";
import { friendClub, friendJoins, linkFor } from "./world";

const PI = { "x-api-key": E2E.WHATSAPP_API_KEY };

scenarios("a friend pays like any guest", () => {
  scenario("a weekly club: the fee in his DM, and the club's pay link reaches him after the game", async ({ pool }) => {
    const fnf = await friendClub(pool, "fnf");
    await pool.db.run(`UPDATE "Activity" SET "feePerPlayer" = 6 WHERE id = $1`, [fnf.group.activityId]);
    const token = await linkFor(pool, fnf);
    const j = await friendJoins(pool, "ali", token);
    expect(j.sent.find((m) => m.purpose === "friend-booked")?.text).toContain("Fee: £6, asked of you after the game.");

    pool.note("after the game: the collector confirms the fee with a ✅, as any club does");
    const owner = (await pool.userOf(fnf.member("owner")))!;
    await pool.db.run(`UPDATE "Organisation" SET "paymentCollectionEnabled" = true, "paymentTrackingEnabled" = true, "paymentHolderId" = $2 WHERE id = $1`, [fnf.group.orgId, owner.id]);
    await pool.db.run(`UPDATE "Match" SET status = 'COMPLETED', date = $2 WHERE id = $1`, [fnf.group.matchId, new Date(Date.now() - 3 * 3600_000)]);
    const ownerPhone = fnf.member("owner").phone.replace(/^\+/, "");
    setFeeReplyStub({ bodies: { "£6 each": JSON.stringify({ intent: "amount", amount: 6, amountIs: "each", confidence: 1 }) } });
    const fee = await pool.request.post("/api/whatsapp/dm-reply", { headers: PI, data: { phone: ownerPhone, body: "£6 each", waMessageId: `fee-${Date.now()}` } });
    expect((await fee.json()).handled).toBe("collector-fee");
    clearFeeReplyStub();
    const prompt = await pool.db.one<{ id: string }>(`SELECT id FROM "BotJob" WHERE "orgId" = $1 AND "aboutKey" LIKE '%:fee-confirm' ORDER BY "createdAt" DESC LIMIT 1`, [fnf.group.orgId]);
    const stanza = `3EB0FRIEND${Date.now()}`;
    const wa = `true_${ownerPhone}@c.us_${stanza}`;
    await pool.db.run(`UPDATE "BotJob" SET "sentAt" = now() WHERE id = $1`, [prompt!.id]);
    await pool.db.run(`INSERT INTO "SentNotification" (id, key, kind, "waMessageId", "waStanzaId", "createdAt") VALUES ($1, $2, 'dm', $3, $4, now())`, [`sn-friend-${stanza}`, `botjob-${prompt!.id}`, wa, stanza]);
    const react = await pool.request.post("/api/whatsapp/reaction", { headers: PI, data: { waMessageId: wa, emoji: "✅", fromPhone: ownerPhone, fromAuthorName: null } });
    expect((await react.json()).handled).toBe("fee-confirm-reaction");

    const toHim = await pool.db.all<{ text: string }>(`SELECT text FROM "BotJob" WHERE "orgId" = $1 AND kind = 'dm' AND phone = $2`, [fnf.group.orgId, j.person.phone.replace(/^\+/, "")]);
    expect(toHim).toHaveLength(1);
    expect(toHim[0].text).toContain("£6");
    expect(toHim[0].text).toMatch(/https?:\/\/\S+\/r\/\S+/);
  });

  scenario("a monthly club: the PAYG price, and he is a PAYG player of that game only", async ({ pool }) => {
    const vets = await friendClub(pool, "vets", { confirmed: [] });
    const orgId = vets.group.orgId;
    await pool.db.run(`UPDATE "Organisation" SET "squadMode" = 'monthly', "paygPricePence" = 800, "partnerAskWhen" = 'off' WHERE id = $1`, [orgId]);
    const kickoff = (await pool.db.one<{ date: Date }>(`SELECT date FROM "Match" WHERE id = $1`, [vets.group.matchId]))!.date;
    const monthId = `sim-month-friend-${Date.now()}`;
    await pool.db.run(
      `INSERT INTO "SquadMonth" (id, "orgId", "activityId", "monthStart", status, "gamesScheduled", "gamesPlayedBeforeStart", "startedMidMonthAt", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4::date, 'running', 4, 0, now() - interval '2 days', now() - interval '2 days', now())`,
      [monthId, orgId, vets.group.activityId, `${formatLondon(kickoff, "yyyy-MM")}-01`],
    );
    for (const [i, key] of ["owner", "dan"].entries()) {
      await pool.db.run(
        `INSERT INTO "SquadMonthMember" (id, "monthId", "userId", kind, slot, "gamesCovered", "paidAt", "absentMatchIds", source, "updatedAt")
         VALUES ($1, $2, $3, 'regular', $4, 4, now(), '{}', 'seed-list', now())`,
        [`${monthId}-${key}`, monthId, vets.group.player(key).userId, i + 1],
      );
    }
    const token = await linkFor(pool, vets);
    const j = await friendJoins(pool, "ali", token);
    expect(j.sent.find((m) => m.purpose === "friend-booked")?.text).toContain("Fee: £8 as a pay as you go player, asked of you after the game.");
    const uid = (await pool.userOf(j.person))!.id;
    expect(await pool.db.one(`SELECT status, "paymentMethod" FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`, [vets.group.matchId, uid])).toEqual({ status: "CONFIRMED", paymentMethod: null });
    expect(await pool.db.count(`SELECT count(*) FROM "SquadMonthMember" WHERE "monthId" = $1 AND "userId" = $2`, [monthId, uid])).toBe(0);
    expect(await pool.db.count(`SELECT count(*) FROM "SquadCredit" WHERE "orgId" = $1 AND "userId" = $2`, [orgId, uid])).toBe(0);
  });
});

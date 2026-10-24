/**
 * POOL SCENARIOS: saying yes by the tap link, and everything after it
 * (slice L5a, 2026-10-24). The offer page is driven in a real browser;
 * what MatchTime queued, to whom, and what the database holds is asserted
 * through the world. Model-free ($0).
 *
 *   yes on a first-come club: a place, the organisers told in HQ (first
 *   name, last initial, the turn-up line; never a number), the match
 *   details to him, the round closed; EN and TR. Two say yes to the last
 *   place at once: one gets it. Yes after the offer ended. An
 *   organiser-pick club: the bench. A fee club: the club's own pay link
 *   later. A reply in words: one "tap the link" line. Giving the place
 *   back. The stop link signs him in to his manage page.
 */
import { scenario, scenarios, expect } from "./fixtures";
import { E2E } from "../../helpers/env";
import { askOf, at, near, poolSwitchCookie, offersOf, openClub, organiserAsks, pollPlatform, poolPlayer, tapLinkIn, tapOffer } from "./offers-world";

const PI = { "x-api-key": E2E.WHATSAPP_API_KEY };

scenarios("saying yes to a pool offer", () => {
  scenario("yes on a first-come club: his place, the organisers told without his number, his match details, the round closed", async ({ pool, page }) => {
    const fnf = await openClub(pool, "fnf", { name: "FNF", hq: true });
    const ali = await poolPlayer(pool, "ali", { name: "Ali Kaya", at: near(fnf) });
    await poolPlayer(pool, "ben", { name: "Ben Other", at: near(fnf) });
    const ex = await organiserAsks(pool, page, fnf, { places: 1, now: at(fnf.kickoff, -8) });
    await pollPlatform(pool, { now: at(fnf.kickoff, -8) });
    const offer = ex.sent.find((m) => m.to === "ali")!;

    expect(await tapOffer(pool, page, tapLinkIn(offer), "yes")).toBe("in");
    await expect(page.getByTestId("pool-offer-state")).toContainText("You're in: FNF");

    const sent = await pool.collect();
    pool.expectSent(sent, [
      { to: "fnf.hq", channel: "hq", text: /^🙋 Ali K from the MatchTime player pool took a place for \w{3} \d+ \w{3}, 20:00\. New to MatchTime\.$/ },
      { to: "ali", channel: "dm", purpose: "pool-placed", text: /✅ You're in: \*FNF\*.*\n.*Give the place back here: https?:\/\/\S+\/play\/offer\// },
    ]);
    pool.expectNoLeaks(ali.phoneVariants(), { to: ["fnf.hq"] });
    pool.expectNoLeaks(fnf.secrets(), { to: ["ali"] });

    const row = await pool.db.one<{ status: string }>(`SELECT status FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`, [fnf.group.matchId, ali.userId]);
    expect(row?.status).toBe("CONFIRMED");
    const ev = await pool.db.one<{ cause: string }>(`SELECT cause FROM "AttendanceEvent" WHERE "matchId" = $1 AND "userId" = $2 ORDER BY at DESC LIMIT 1`, [fnf.group.matchId, ali.userId]);
    expect(ev?.cause).toBe("pool-ask");
    expect(await pool.db.one(`SELECT "guestVia", "guestFromOrgId", "guestMatchId", "leftAt" FROM "Membership" WHERE "orgId" = $1 AND "userId" = $2`, [fnf.group.orgId, ali.userId])).toEqual({
      guestVia: "pool",
      guestFromOrgId: null,
      guestMatchId: fnf.group.matchId,
      leftAt: null,
    });
    expect(await pool.db.one(`SELECT source, result FROM "GuestPlace" WHERE "matchId" = $1 AND "userId" = $2`, [fnf.group.matchId, ali.userId])).toEqual({ source: "pool", result: "booked" });
    expect(await askOf(pool, fnf)).toMatchObject({ status: "filled", closeReason: "filled" });
    expect((await offersOf(pool, ali))[0].outcome).toBe("accepted");
    expect(await pool.db.count(`SELECT count(*) FROM "PoolOffer" WHERE "orgId" = $1 AND outcome = 'expired'`, [fnf.group.orgId])).toBe(1);

    pool.note("he taps yes again: nothing new");
    await page.goto(tapLinkIn(offer));
    await expect(page.getByTestId("pool-offer-page")).toHaveAttribute("data-state", "in");
    await expect(page.getByTestId("pool-offer-yes")).toHaveCount(0);
    pool.expectSent(await pool.collect(), []);
  });

  scenario("in Turkish: the page, his details and the organisers' notice in each one's language", async ({ pool, page }) => {
    const gs = await openClub(pool, "gs", { name: "Galata FC", hq: true });
    await pool.db.run(`UPDATE "Organisation" SET language = 'tr' WHERE id = $1`, [gs.group.orgId]);
    await poolPlayer(pool, "can", { name: "Can Demir", lang: "tr", at: near(gs) });
    const ex = await organiserAsks(pool, page, gs, { places: 1, now: at(gs.kickoff, -8) });
    await pollPlatform(pool, { now: at(gs.kickoff, -8) });

    await poolSwitchCookie(page);
    await page.goto(tapLinkIn(ex.sent[0]));
    await expect(page.getByRole("heading")).toHaveText("Sana bir maç");
    await expect(page.getByTestId("pool-offer-yes")).toHaveText("Evet, oynarım");
    expect(await tapOffer(pool, page, tapLinkIn(ex.sent[0]), "yes")).toBe("in");
    await expect(page.getByTestId("pool-offer-state")).toContainText("Yerin hazır: Galata FC");

    pool.expectSent(await pool.collect(), [
      { to: "gs.hq", text: /^🙋 MatchTime oyuncu havuzundan Can D, .* maçında bir yer aldı\. MatchTime'da yeni\.$/ },
      { to: "can", purpose: "pool-placed", text: /✅ Yerin hazır: \*Galata FC\*/ },
    ]);
  });

  scenario("two say yes to the last place at the same moment: exactly one gets it, the other is told it has gone", async ({ pool, page, browser }) => {
    const fnf = await openClub(pool, "fnf", { name: "FNF", hq: true });
    const ali = await poolPlayer(pool, "ali", { at: near(fnf) });
    const ben = await poolPlayer(pool, "ben", { at: near(fnf) });
    const ex = await organiserAsks(pool, page, fnf, { places: 1, now: at(fnf.kickoff, -8) });
    await pollPlatform(pool, { now: at(fnf.kickoff, -8) });
    const [ctxA, ctxB] = await Promise.all([browser.newContext(), browser.newContext()]);
    const [pa, pb] = await Promise.all([ctxA.newPage(), ctxB.newPage()]);

    const states = await Promise.all([
      tapOffer(pool, pa, tapLinkIn(ex.sent.find((m) => m.to === "ali")!), "yes"),
      tapOffer(pool, pb, tapLinkIn(ex.sent.find((m) => m.to === "ben")!), "yes"),
    ]);
    await Promise.all([ctxA.close(), ctxB.close()]);

    expect(states.sort()).toEqual(["gone", "in"]);
    const outcomes = [(await offersOf(pool, ali))[0].outcome, (await offersOf(pool, ben))[0].outcome].sort();
    expect(outcomes).toEqual(["accepted", "filled"]);
    expect(await pool.db.count(`SELECT count(*) FROM "Attendance" WHERE "matchId" = $1 AND "userId" IN ($2, $3)`, [fnf.group.matchId, ali.userId, ben.userId])).toBe(1);
    const sent = await pool.collect();
    expect(sent.filter((m) => m.to === "fnf.hq")).toHaveLength(1);
    expect(sent.filter((m) => m.purpose === "pool-placed")).toHaveLength(1);
  });

  scenario("yes after the offer ended: the page says so and nothing is written", async ({ pool, page }) => {
    const fnf = await openClub(pool, "fnf", { name: "FNF", hq: true });
    const ali = await poolPlayer(pool, "ali", { at: near(fnf) });
    const ex = await organiserAsks(pool, page, fnf, { places: 1, now: at(fnf.kickoff, -8) });
    await pollPlatform(pool, { now: at(fnf.kickoff, -8) });
    await pool.db.run(`UPDATE "PoolOffer" SET "expiresAt" = $2 WHERE "userId" = $1`, [ali.userId, new Date(Date.now() - 60_000)]);

    await poolSwitchCookie(page);
    await page.goto(tapLinkIn(ex.sent[0]));
    await expect(page.getByTestId("pool-offer-page")).toHaveAttribute("data-state", "expired");
    await expect(page.getByTestId("pool-offer-yes")).toHaveCount(0);
    expect(await pool.db.count(`SELECT count(*) FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`, [fnf.group.matchId, ali.userId])).toBe(0);
    pool.expectSent(await pool.collect(), []);
  });

  scenario("an organiser-pick club: yes puts him on the bench for the organisers to pick, and the round stays open", async ({ pool, page }) => {
    const fnf = await openClub(pool, "fnf", { name: "FNF", hq: true, benchPickMode: "organiser" });
    const ali = await poolPlayer(pool, "ali", { name: "Ali Kaya", at: near(fnf) });
    const ex = await organiserAsks(pool, page, fnf, { places: 1, now: at(fnf.kickoff, -8) });
    await pollPlatform(pool, { now: at(fnf.kickoff, -8) });

    expect(await tapOffer(pool, page, tapLinkIn(ex.sent[0]), "yes")).toBe("bench");
    pool.expectSent(await pool.collect(), [
      { to: "fnf.hq", text: /^🙋 Ali K from the MatchTime player pool is on the bench for .*, for you to pick\. New to MatchTime\.$/ },
      { to: "ali", purpose: "pool-placed", text: /📝 You're on the bench for \*FNF\*/ },
    ]);
    const row = await pool.db.one<{ status: string }>(`SELECT status FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`, [fnf.group.matchId, ali.userId]);
    expect(row?.status).toBe("BENCH");
    expect(await askOf(pool, fnf)).toMatchObject({ status: "open" });
    for (const m of pool.sent) expect(m.text).not.toMatch(/waiting list/i);
  });

  scenario("a fee club: the offer and his details say the fee, and the club's own pay link reaches him after the game", async ({ pool, page }) => {
    const fnf = await openClub(pool, "fnf", { name: "FNF", hq: true, feePerPlayer: 6 });
    const ali = await poolPlayer(pool, "ali", { at: near(fnf) });
    const ex = await organiserAsks(pool, page, fnf, { places: 1, now: at(fnf.kickoff, -8) });
    expect(ex.sent[0].text).toContain("💷 £6 match fee");
    await pollPlatform(pool, { now: at(fnf.kickoff, -8) });
    expect(await tapOffer(pool, page, tapLinkIn(ex.sent[0]), "yes")).toBe("in");
    const placed = (await pool.collect()).find((m) => m.purpose === "pool-placed")!;
    expect(placed.text).toContain("The match fee is £6. You'll get a pay link after the game.");

    pool.note("after the game: the collector confirms the fee with a ✅, as any club does");
    const owner = (await pool.userOf(fnf.member("owner")))!;
    await pool.db.run(`UPDATE "Organisation" SET "paymentCollectionEnabled" = true, "paymentTrackingEnabled" = true, "paymentHolderId" = $2 WHERE id = $1`, [fnf.group.orgId, owner.id]);
    await pool.db.run(`UPDATE "Match" SET status = 'COMPLETED', date = $2 WHERE id = $1`, [fnf.group.matchId, new Date(Date.now() - 3 * 3600_000)]);
    const ownerPhone = fnf.member("owner").phone.replace(/^\+/, "");
    const fee = await pool.request.post("/api/whatsapp/dm-reply", { headers: PI, data: { phone: ownerPhone, body: "£6 each", waMessageId: `fee-${Date.now()}` } });
    expect((await fee.json()).handled).toBe("collector-fee");
    const prompt = await pool.db.one<{ id: string }>(`SELECT id FROM "BotJob" WHERE "orgId" = $1 AND "aboutKey" LIKE '%:fee-confirm' ORDER BY "createdAt" DESC LIMIT 1`, [fnf.group.orgId]);
    const stanza = `3EB0POOL${Date.now()}`;
    const wa = `true_${ownerPhone}@c.us_${stanza}`;
    await pool.db.run(`UPDATE "BotJob" SET "sentAt" = now() WHERE id = $1`, [prompt!.id]);
    await pool.db.run(`INSERT INTO "SentNotification" (id, key, kind, "waMessageId", "waStanzaId", "createdAt") VALUES ($1, $2, 'dm', $3, $4, now())`, [
      `sn-pool-${stanza}`,
      `botjob-${prompt!.id}`,
      wa,
      stanza,
    ]);
    const react = await pool.request.post("/api/whatsapp/reaction", { headers: PI, data: { waMessageId: wa, emoji: "✅", fromPhone: ownerPhone, fromAuthorName: null } });
    expect((await react.json()).handled).toBe("fee-confirm-reaction");

    // The club's own pay-link DM (payment-flow.ts releaseMatchPayments): a
    // club DM to him, the fee, and his signed short link to /pay/<match>.
    const toHim = await pool.db.all<{ text: string }>(`SELECT text FROM "BotJob" WHERE "orgId" = $1 AND kind = 'dm' AND phone = $2`, [fnf.group.orgId, ali.phone.replace(/^\+/, "")]);
    expect(toHim).toHaveLength(1);
    expect(toHim[0].text).toContain("£6");
    expect(toHim[0].text).toMatch(/https?:\/\/\S+\/r\/\S+/);
  });

  scenario("a reply in words gets ONE 'tap the link' line; a second gets nothing; once the place has gone, one line says so", async ({ pool, page }) => {
    const fnf = await openClub(pool, "fnf", { name: "FNF", hq: true });
    const ali = await poolPlayer(pool, "ali", { at: near(fnf) });
    await poolPlayer(pool, "ben", { at: near(fnf) });
    const ex = await organiserAsks(pool, page, fnf, { places: 1, now: at(fnf.kickoff, -8) });
    await pollPlatform(pool, { now: at(fnf.kickoff, -8) });
    await pool.db.run(`UPDATE "PoolOffer" SET "sentAt" = $2 WHERE "orgId" = $1`, [fnf.group.orgId, new Date(Date.now() - 60_000)]);

    const first = await ali.dm("yes please, I'll come");
    expect(first.json).toMatchObject({ handled: "pool-offer-tap-link" });
    pool.expectSent(first.sent, [{ to: "ali", purpose: "pool-reply", text: /^To answer the offer, tap the link: https?:\/\/\S+\/play\/offer\/\S+\n\nYou get these because/ }]);
    expect(first.sent[0].text).toContain(tapLinkIn(ex.sent.find((m) => m.to === "ali")!));

    const second = await ali.dm("hello?");
    pool.expectSent(second.sent, []);

    pool.note("Ben takes the place");
    expect(await tapOffer(pool, page, tapLinkIn(ex.sent.find((m) => m.to === "ben")!), "yes")).toBe("in");
    await pool.collect();
    const late = await ali.dm("still need someone?");
    pool.expectSent(late.sent, [{ to: "ali", purpose: "pool-reply", text: /That place with FNF has gone now/ }]);
    pool.expectSent((await ali.dm("ok")).sent, []);
  });

  scenario("he gives the place back in time: the place is free, the organisers are told, his guest place says withdrawn", async ({ pool, page }) => {
    const fnf = await openClub(pool, "fnf", { name: "FNF", hq: true });
    const ali = await poolPlayer(pool, "ali", { name: "Ali Kaya", at: near(fnf) });
    const ex = await organiserAsks(pool, page, fnf, { places: 1, now: at(fnf.kickoff, -8) });
    await pollPlatform(pool, { now: at(fnf.kickoff, -8) });
    expect(await tapOffer(pool, page, tapLinkIn(ex.sent[0]), "yes")).toBe("in");
    await pool.collect();

    expect(await tapOffer(pool, page, tapLinkIn(ex.sent[0]), "pull-out")).toBe("withdrawn");
    const sent = await pool.collect();
    expect(sent.filter((m) => m.to === "fnf.hq").map((m) => m.text)).toEqual([expect.stringMatching(/^Ali K from the MatchTime player pool can no longer play on .*\. The place is open again\.$/)]);
    const row = await pool.db.one<{ status: string }>(`SELECT status FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`, [fnf.group.matchId, ali.userId]);
    expect(row?.status).toBe("DROPPED");
    expect(await pool.db.one(`SELECT result FROM "GuestPlace" WHERE "userId" = $1`, [ali.userId])).toEqual({ result: "withdrawn" });
    expect((await pool.db.one<{ leftAt: Date | null }>(`SELECT "leftAt" FROM "Membership" WHERE "orgId" = $1 AND "userId" = $2`, [fnf.group.orgId, ali.userId]))?.leftAt).not.toBeNull();
  });

  scenario("the stop link in every pool message signs HIM in to his manage page, and names nobody", async ({ pool, page }) => {
    const fnf = await openClub(pool, "fnf", { name: "FNF" });
    const ali = await poolPlayer(pool, "ali", { at: near(fnf) });
    const ex = await organiserAsks(pool, page, fnf, { places: 1, now: at(fnf.kickoff, -8) });
    const link = /Stop or change them: (https?:\/\/\S+\/r\/(\S+))$/.exec(ex.sent[0].text);
    expect(link).toBeTruthy();
    const res = await pool.request.get(`/api/r/${link![2]}`);
    expect(res.status()).toBe(200);
    const { token } = (await res.json()) as { token: string };
    const payload = JSON.parse(Buffer.from(token.split(".")[0].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")) as Record<string, unknown>;
    expect(payload).toMatchObject({ userId: ali.userId, purpose: "sign-in", nextPath: "/play/manage" });
  });
});

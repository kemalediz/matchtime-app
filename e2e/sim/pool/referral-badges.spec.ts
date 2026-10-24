/**
 * POOL SCENARIOS: referral badges and "Brought by" (growth slice G4,
 * 2026-10-24). Pete, a club member in the pool, shares his link; friends
 * sign up through it (G1 kept the referral) and play. Through the real
 * offer page, the real complete-matches cron and the real scheduler poll
 * (claimed, as the Pi does). Model-free: $0.
 *
 * The rules under test (`src/lib/pool/referral-rules.ts`): a friend counts
 * once he has PLAYED; Recruiter (1), Scout (3), Talent Spotter (10) are
 * announced ONCE, in the club's badges post of his home club (the one he
 * plays most) and nowhere else; the highest new badge only; his privacy
 * switch keeps them out of every group and his name off "Brought by"; a
 * friend who never played, himself, or a loop count for nothing; a club
 * with the pool off hears nothing new.
 */
import { scenario, scenarios, expect } from "./fixtures";
import { near, openClub } from "./offers-world";
import { pastGuestGame, placeOf, runCompleteMatches } from "./safety-world";
import { alsoMemberOf, badgesPost, clubPlayedDaysAgo, friendTakesPlace, referralLedger, referredFriend, referrerProfile } from "./referral-world";

const H = 3600_000;

scenarios("referral badges and Brought by", () => {
  scenario("Bea, brought by Pete, plays her first game: 'Brought by Pete P.' to the organisers, then Recruiter once, in Pete's club only", async ({ pool, page }) => {
    const fnf = await openClub(pool, "fnf", { name: "FNF", hq: true });
    const vets = await openClub(pool, "vets", { name: "Vets", hq: true });
    const sutton = await openClub(pool, "sutton", { name: "Sutton", hq: true });
    const pete = fnf.member("pete");
    await alsoMemberOf(pool, vets, pete);
    const peteRef = await referrerProfile(pool, pete);
    const bea = await referredFriend(pool, "bea", peteRef, { name: "Bea Lee", at: near(sutton) });

    pool.note("Bea takes a place at Sutton: her first game, so the organisers hear who brought her");
    const placed = await friendTakesPlace(pool, page, sutton, bea);
    const notice = placed.filter((m) => m.to === "sutton.hq");
    expect(notice).toHaveLength(1);
    expect(notice[0].text).toMatch(/^🙋 Bea L from the MatchTime player pool took a place for .*New to MatchTime\. Brought by Pete P\.$/);
    pool.expectNoLeaks(["Pete Power", ...pete.phoneVariants()], { to: ["sutton.hq", "bea"] });

    pool.note("the game is played; the cron settles it after the 24 hours and counts the referral, telling nobody");
    const kickoff = new Date(Date.now() - 26 * H);
    await pool.db.run(`UPDATE "Match" SET date = $2, "attendanceDeadline" = $2 WHERE id = $1`, [sutton.group.matchId, kickoff]);
    await clubPlayedDaysAgo(pool, fnf, 3, [pete]); // Pete plays most at FNF
    await clubPlayedDaysAgo(pool, vets, 3);
    const cron = await runCompleteMatches(pool, { now: new Date() });
    expect(await placeOf(pool, sutton, bea)).toMatchObject({ result: "played" });
    expect(cron.json.referralsCounted).toBe(1);
    pool.expectSent(cron.sent, []);
    expect((await pool.profileOf(bea))?.referralCountedAt).not.toBeNull();

    pool.note("FNF's badges post names Pete as a Recruiter; Vets and Sutton say nothing about him");
    const post = await badgesPost(pool, fnf);
    expect(post?.text).toContain("🤝 *Recruiter*: *Pete Power* brought a new player to the game 🙌");
    expect(post?.text).toContain("🏅 *New badges this week*");
    expect((await badgesPost(pool, vets))?.text ?? "").not.toContain("Recruiter");
    expect((await badgesPost(pool, sutton))?.text ?? "").not.toContain("Recruiter");
    expect(await referralLedger(pool, peteRef.userId)).toEqual([{ orgId: fnf.group.orgId, badgeKey: "recruiter" }]);

    pool.note("once: the next poll and the next evening have nothing more");
    expect(await badgesPost(pool, fnf, { minute: 1 })).toBeUndefined();
    expect(await badgesPost(pool, fnf, { evening: 1 })).toBeUndefined();

    pool.note("a second game of Bea's is not her first: no 'Brought by' again (pure rule), and the cron counts her once");
    const again = await runCompleteMatches(pool, { now: new Date() });
    expect(again.json.referralsCounted).toBe(0);
  });

  scenario("three friends have played: Scout is announced, Recruiter recorded silently (one line, not two)", async ({ pool }) => {
    const fnf = await openClub(pool, "fnf", { name: "FNF", hq: true });
    const pete = fnf.member("pete");
    const peteRef = await referrerProfile(pool, pete);
    for (const k of ["cem", "dan", "eve"]) {
      const f = await referredFriend(pool, k, peteRef, { at: near(fnf) });
      await pastGuestGame(pool, f, "played", 5);
    }
    await clubPlayedDaysAgo(pool, fnf, 3);
    const cron = await runCompleteMatches(pool, { now: new Date() });
    expect(cron.json.referralsCounted).toBe(3);

    const post = await badgesPost(pool, fnf);
    expect(post?.text).toContain("🔭 *Scout*: *Pete Power* has now brought 3 players to the game 👏");
    expect(post?.text).not.toContain("Recruiter");
    expect(await referralLedger(pool, peteRef.userId)).toEqual([
      { orgId: fnf.group.orgId, badgeKey: "recruiter" },
      { orgId: fnf.group.orgId, badgeKey: "scout" },
    ]);
  });

  scenario("Pete keeps his badges and 'Brought by' private: no name to the organisers, no group post, no ledger row", async ({ pool, page }) => {
    const fnf = await openClub(pool, "fnf", { name: "FNF", hq: true });
    const sutton = await openClub(pool, "sutton", { name: "Sutton", hq: true });
    const pete = fnf.member("pete");
    const peteRef = await referrerProfile(pool, pete, { showRecognition: false });
    const fay = await referredFriend(pool, "fay", peteRef, { name: "Fay Ng", at: near(sutton) });

    const placed = await friendTakesPlace(pool, page, sutton, fay);
    const notice = placed.filter((m) => m.to === "sutton.hq");
    expect(notice).toHaveLength(1);
    expect(notice[0].text).not.toMatch(/Brought by|Pete/);

    await pool.db.run(`UPDATE "Match" SET date = $2, "attendanceDeadline" = $2 WHERE id = $1`, [sutton.group.matchId, new Date(Date.now() - 26 * H)]);
    await clubPlayedDaysAgo(pool, fnf, 3);
    expect((await runCompleteMatches(pool, { now: new Date() })).json.referralsCounted).toBe(1);

    expect(await badgesPost(pool, fnf)).toBeUndefined();
    expect(await referralLedger(pool, peteRef.userId)).toEqual([]);
  });

  scenario("a friend who signed up but never played counts for nothing: no stamp, no post", async ({ pool }) => {
    const fnf = await openClub(pool, "fnf", { name: "FNF", hq: true });
    const peteRef = await referrerProfile(pool, fnf.member("pete"));
    const gus = await referredFriend(pool, "gus", peteRef, { at: near(fnf) });
    await pastGuestGame(pool, gus, "no-show", 5);
    await clubPlayedDaysAgo(pool, fnf, 3);

    expect((await runCompleteMatches(pool, { now: new Date() })).json.referralsCounted).toBe(0);
    expect((await pool.profileOf(gus))?.referralCountedAt).toBeNull();
    expect(await badgesPost(pool, fnf)).toBeUndefined();
    expect(await referralLedger(pool, peteRef.userId)).toEqual([]);
  });

  scenario("himself, or a loop (two players who 'brought' each other), counts for nothing", async ({ pool }) => {
    const fnf = await openClub(pool, "fnf", { name: "FNF", hq: true });
    const pete = fnf.member("pete");
    const peteRef = await referrerProfile(pool, pete);
    pool.note("(rows G1's settlement never writes, as if edited by hand: the count must still refuse them)");
    const hal = await referredFriend(pool, "hal", peteRef, { at: near(fnf) });
    await pool.db.run(`UPDATE "PoolProfile" SET "referrerUserId" = $1 WHERE "userId" = $2`, [hal.userId, peteRef.userId]);
    await pastGuestGame(pool, hal, "played", 5);
    const owner = fnf.member("owner");
    const ownerRef = await referrerProfile(pool, owner);
    await pool.db.run(`UPDATE "PoolProfile" SET "referrerUserId" = $1 WHERE "userId" = $1`, [ownerRef.userId]);
    await clubPlayedDaysAgo(pool, fnf, 3, [pete, owner]);
    await runCompleteMatches(pool, { now: new Date() });
    pool.note("the owner played, so his self-referral is stamped; it still counts for nobody");
    expect((await pool.profileOf(owner))?.referralCountedAt).not.toBeNull();

    const post = await badgesPost(pool, fnf);
    expect(post?.text).toContain("On the board");
    expect(post?.text).not.toMatch(/Recruiter|Scout/);
    expect(await referralLedger(pool, peteRef.userId)).toEqual([]);
    expect(await referralLedger(pool, ownerRef.userId)).toEqual([]);
    expect(await referralLedger(pool, hal.userId)).toEqual([]);
  });

  scenario("a Turkish club: 'Getiren: Pete P.' to the organisers and the Recruiter line in Turkish", async ({ pool, page }) => {
    const fnf = await openClub(pool, "fnf", { name: "Cuma Futbolu", hq: true });
    const sutton = await openClub(pool, "sutton", { name: "Halı Saha", hq: true });
    for (const c of [fnf, sutton]) await pool.db.run(`UPDATE "Organisation" SET language = 'tr' WHERE id = $1`, [c.group.orgId]);
    const pete = fnf.member("pete");
    const peteRef = await referrerProfile(pool, pete);
    const jan = await referredFriend(pool, "jan", peteRef, { name: "Jan Su", lang: "tr", at: near(sutton) });

    const placed = await friendTakesPlace(pool, page, sutton, jan);
    const notice = placed.filter((m) => m.to === "sutton.hq");
    expect(notice).toHaveLength(1);
    expect(notice[0].text).toMatch(/ Getiren: Pete P\.$/);

    await pool.db.run(`UPDATE "Match" SET date = $2, "attendanceDeadline" = $2 WHERE id = $1`, [sutton.group.matchId, new Date(Date.now() - 26 * H)]);
    await clubPlayedDaysAgo(pool, fnf, 3);
    await runCompleteMatches(pool, { now: new Date() });

    const post = await badgesPost(pool, fnf);
    expect(post?.text).toContain("🏅 *Bu haftanın yeni rozetleri*");
    expect(post?.text).toContain("🤝 *Recruiter*: *Pete Power* oyuna bir yeni oyuncu kazandırdı 🙌");
  });

  scenario("a club with the pool switched off hears nothing new: no referral line, no ledger row", async ({ pool }) => {
    const fnf = await pool.club("fnf", { name: "FNF" });
    const peteRef = await referrerProfile(pool, fnf.member("pete"));
    const kim = await referredFriend(pool, "kim", peteRef, { at: { lat: 51.36, lng: -0.19 } });
    await pastGuestGame(pool, kim, "played", 5);
    await clubPlayedDaysAgo(pool, fnf, 3, [fnf.member("pete")]);
    expect((await runCompleteMatches(pool, { now: new Date() })).json.referralsCounted).toBe(1);

    const post = await badgesPost(pool, fnf);
    expect(post?.text).toContain("On the board"); // the club's own badges, as before
    expect(post?.text).not.toContain("Recruiter");
    expect(await referralLedger(pool, peteRef.userId)).toEqual([]);
  });
});

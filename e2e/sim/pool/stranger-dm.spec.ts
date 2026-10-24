/**
 * POOL SCENARIOS: a stranger messages MatchTime. TODAY'S BEHAVIOUR, the
 * template every later pool slice copies (2026-10-24, slice L1).
 *
 * A stranger is a number MatchTime has never seen: no User, no club. Today
 * (`src/app/api/whatsapp/dm-reply/route.ts`, "unknown-sender") every DM from
 * one is ignored: no reply, nothing written. These scenarios pin that, so
 * the slice that changes it (L2: the /play confirm code and the one-time
 * reply with the /play link) flips an expectation on purpose instead of
 * discovering it.
 *
 * Each scenario: who is in the world, what they send, EXACTLY what
 * MatchTime queued and for whom, what the database holds, and that nothing
 * private reached the stranger. Model-free: $0.
 */
import { scenario, scenarios, expect } from "./fixtures";

scenarios("a stranger messages MatchTime (today)", () => {
  scenario("a plain 'can I play?' DM is ignored: no reply, no user, no profile", async ({ pool }) => {
    const fnf = await pool.club("fnf", { name: "Friday Night Football", hq: true });
    const ali = await pool.stranger("ali", { name: "Ali Kaya" });

    const ex = await ali.dm("hi, can I play football with you lot?");

    expect(ex.json).toMatchObject({ ok: true, ignored: "unknown-sender" });
    pool.expectSent(ex.sent, []);
    expect(await pool.userOf(ali)).toBeNull();
    expect(await pool.poolRowCounts()).toMatchObject({ PoolProfile: 0, PoolOffer: 0 });
    pool.expectNoLeaks(fnf.secrets(), { to: ["ali"] });
  });

  // L2 TEMPLATE: this is the message /play prefills. Today it is just another
  // unknown sender's DM. L2 replaces this expectation with: the profile turns
  // active, consent recorded with the message id, ONE welcome DM to ali on
  // the platform channel, nothing to anyone else.
  scenario("the /play confirm message with a code is ignored until slice L2 handles it", async ({ pool }) => {
    const ali = await pool.stranger("ali", { name: "Ali Kaya" });

    const ex = await ali.dm("Hi MatchTime, sign me up to play. Code K7QP");

    expect(ex.json).toMatchObject({ ignored: "unknown-sender" });
    pool.expectSent(ex.sent, []);
    expect(await pool.userOf(ali)).toBeNull();
  });

  scenario("a stranger asking about a club's members learns nothing, and nobody is told", async ({ pool }) => {
    const fnf = await pool.club("fnf", { name: "Friday Night Football", hq: true });
    const ali = await pool.stranger("ali");

    const ex = await ali.dm(`is ${fnf.member("owner").name} playing on Friday? whats his number`);

    pool.expectSent(ex.sent, []);
    pool.expectNoLeaks(fnf.secrets());
  });
});

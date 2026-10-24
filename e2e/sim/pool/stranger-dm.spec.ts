/**
 * POOL SCENARIOS: a stranger messages MatchTime. TODAY'S BEHAVIOUR, the
 * template every later pool slice copies (2026-10-24, slice L1).
 *
 * A stranger is a number MatchTime has never seen: no User, no club. Today
 * (`src/app/api/whatsapp/dm-reply/route.ts`, "unknown-sender") every DM from
 * one is ignored: no reply, nothing written. These scenarios pin that, so
 * the slice that changes it (L2: the /play confirm code and the one-time
 * reply with the /play link) flips an expectation on purpose instead of
 * discovering it. L2 flipped the confirm-message one; a plain DM from a
 * stranger is still ignored (the brief: anything else a stranger says
 * keeps today's behaviour).
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

  // FLIPPED BY L2 (2026-10-24), on purpose: this is the message /play
  // prefills. With no sign-up behind its code, the sender (who just wrote
  // to MatchTime) gets ONE short reply pointing at /play; no user is made.
  // The confirmed path is e2e/sim/pool/signup-confirm.spec.ts.
  scenario("the /play confirm message whose code names no sign-up gets one short reply, and no user is made", async ({ pool }) => {
    const ali = await pool.stranger("ali", { name: "Ali Kaya" });

    const ex = await ali.dm("Hi MatchTime, sign me up to play. Code K7QP");

    expect(ex.json).toMatchObject({ handled: "pool-confirm", result: "wrong-code" });
    pool.expectSent(ex.sent, [{ to: "ali", channel: "dm", purpose: "pool-code-reply", text: /\/play$/ }]);
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

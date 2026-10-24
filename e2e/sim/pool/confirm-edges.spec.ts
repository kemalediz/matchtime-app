/**
 * POOL SCENARIOS: the edges of confirming a /play sign-up (slice L2,
 * 2026-10-24): wrong and expired codes, the same code twice, someone
 * else's code, a club member, a LID, and what a confirmed pool player who
 * chats on gets. Exactly what MatchTime queued, for whom, and what the
 * database holds. Model-free: $0.
 */
import { scenario, scenarios, expect } from "./fixtures";

scenarios("confirming a sign-up: the edges", () => {
  scenario("a code that names no sign-up gets ONE short reply with the /play link; no user, nothing else", async ({ pool }) => {
    const ali = await pool.stranger("ali");

    const first = await ali.dm("Hi MatchTime, sign me up to play. Code ZZZZ");
    pool.expectSent(first.sent, [{ to: "ali", purpose: "pool-code-reply", text: /^I couldn't find a sign-up with that code\.[\s\S]*\/play$/ }]);
    expect(first.json).toMatchObject({ handled: "pool-confirm", result: "wrong-code", replied: true });

    const again = await ali.dm("Hi MatchTime, sign me up to play. Code YYYY");
    pool.expectSent(again.sent, []);
    expect(again.json).toMatchObject({ result: "wrong-code", replied: false });

    expect(await pool.userOf(ali)).toBeNull();
    expect(await pool.failedAttempts(ali)).toBe(2);
  });

  scenario("the reply to a Turkish message with a wrong code is in Turkish", async ({ pool }) => {
    const can = await pool.stranger("can");
    const ex = await can.dm("Merhaba MatchTime, oynamak için kaydet. Kod ZZZZ");
    pool.expectSent(ex.sent, [{ to: "can", purpose: "pool-code-reply", text: /^Bu kodla bir kayıt bulamadım/ }]);
  });

  scenario("an expired code: told to sign up again, the sign-up stays waiting, no user", async ({ pool }) => {
    const ali = await pool.stranger("ali2");
    const form = await pool.signUp({ language: "tr" });
    await pool.db.run(`UPDATE "PoolProfile" SET "confirmCodeExpiresAt" = "createdAt" - interval '1 hour' WHERE "confirmCode" = $1`, [form.code]);

    const ex = await ali.dm(form.prefill!);

    pool.expectSent(ex.sent, [{ to: "ali2", purpose: "pool-code-reply", text: /^Bu kayıt kodunun süresi doldu/ }]);
    expect(ex.json).toMatchObject({ result: "expired" });
    expect(await pool.pendingByCode(form.code!)).toMatchObject({ status: "pending-verify", userId: null });
    expect(await pool.userOf(ali)).toBeNull();
  });

  scenario("the code sent twice (a resent message, then the same text again): one profile, one welcome", async ({ pool }) => {
    const ali = await pool.stranger("ali3");
    const form = await pool.signUp();

    const first = await ali.dm(form.prefill!);
    pool.expectSent(first.sent, [{ to: "ali3", purpose: "pool-welcome" }]);

    const retry = await ali.dm(form.prefill!, { messageId: first.messageId });
    expect(retry.json).toMatchObject({ handled: "pool-confirm", result: "duplicate" });
    pool.expectSent(retry.sent, []);

    const again = await ali.dm(form.prefill!);
    expect(again.json).toMatchObject({ handled: "pool-confirm", result: "already-in-pool" });
    pool.expectSent(again.sent, []);

    expect(await pool.db.count(`SELECT count(*) FROM "PoolProfile" p JOIN "User" u ON u.id = p."userId" WHERE u."phoneNumber" = $1`, [ali.phone])).toBe(1);
  });

  scenario("someone forwards another person's code: the number that wrote is the one recorded; the other gets nothing", async ({ pool }) => {
    const ali = await pool.stranger("ali4", { name: "Ali" });
    const bob = await pool.stranger("bob", { name: "Bob" });
    const form = await pool.signUp({ name: "Ali Kaya" });

    const ex = await bob.dm(form.prefill!);

    pool.expectSent(ex.sent, [{ to: "bob", purpose: "pool-welcome" }]);
    expect(await pool.profileOf(bob)).toMatchObject({ status: "active" });
    expect(await pool.userOf(ali)).toBeNull();
    pool.expectNoLeaks(ali.phoneVariants());
    expect(pool.sent.filter((m) => m.to === "ali4")).toEqual([]);

    pool.note("Ali sends the message herself, too late: the code is spent");
    const late = await ali.dm(form.prefill!);
    pool.expectSent(late.sent, [{ to: "ali4", purpose: "pool-code-reply", text: /couldn't find a sign-up/ }]);
    expect(await pool.userOf(ali)).toBeNull();
  });

  scenario("a club member signs up: his one User is reused, his club untouched, the welcome goes to him", async ({ pool }) => {
    const fnf = await pool.club("fnf", { name: "Friday Night Football", hq: true });
    const pete = fnf.member("pete");
    const userBefore = await pool.userOf(pete);
    const membershipsBefore = await pool.db.count(`SELECT count(*) FROM "Membership" WHERE "userId" = $1`, [userBefore!.id]);

    const form = await pool.signUp({ name: "Pete P" });
    const ex = await pete.dm(form.prefill!);

    pool.expectSent(ex.sent, [{ to: "fnf.pete", channel: "dm", purpose: "pool-welcome" }]);
    expect(await pool.db.count(`SELECT count(*) FROM "User" WHERE "phoneNumber" = $1`, [pete.phone])).toBe(1);
    expect((await pool.profileOf(pete))!.userId).toBe(userBefore!.id);
    expect(await pool.db.count(`SELECT count(*) FROM "Membership" WHERE "userId" = $1`, [userBefore!.id])).toBe(membershipsBefore);
    const others = pool.peopleOf("fnf").filter((p) => p.key !== pete.key);
    pool.expectNoLeaks(others.flatMap((p) => [...p.phoneVariants(), ...(p.name ? [p.name] : [])]), { in: ex.sent });
  });

  scenario("a LID sender resolved to his number (Contact.number) confirms; a LID alone is neither recorded nor answered", async ({ pool }) => {
    const ali = await pool.stranger("ali5");
    const form = await pool.signUp();

    const lidOnly = await ali.dm(form.prefill!, { envelope: { phone: "", senderLid: "123456789012345@lid" } });
    expect(lidOnly.json).toMatchObject({ handled: "pool-confirm", result: "no-phone" });
    pool.expectSent(lidOnly.sent, []);
    expect(await pool.pendingByCode(form.code!)).toMatchObject({ status: "pending-verify" });

    const resolved = await ali.dm(form.prefill!, { envelope: { senderLid: "123456789012345@lid" } });
    pool.expectSent(resolved.sent, [{ to: "ali5", purpose: "pool-welcome" }]);
    expect(await pool.profileOf(ali)).toMatchObject({ status: "active" });
  });

  scenario("a confirmed pool player who chats on: no pool reply, no model, nothing about anyone", async ({ pool }) => {
    const fnf = await pool.club("fnf2", { name: "Riverside Wednesday", hq: true });
    const ali = await pool.stranger("ali6");
    const form = await pool.signUp();
    await ali.dm(form.prefill!);

    const ex = await ali.dm("great, so when is the next game near me? who else is in the pool?");

    expect(ex.json.handled).not.toBe("pool-confirm");
    pool.expectSent(ex.sent, []);
    pool.expectNoLeaks(fnf.secrets(), { to: ["ali6"] });
  });

  scenario("a member asking 'what's the code then' is not answered about the pool", async ({ pool }) => {
    const fnf = await pool.club("fnf3", { name: "Tuesday Kickabout" });
    const ex = await fnf.member("pete").dm("what's the code then");
    expect(ex.json.handled).not.toBe("pool-confirm");
    expect(ex.sent.filter((m) => m.purpose === "pool-code-reply")).toEqual([]);
  });

  scenario("the self-join connect message is never taken for a pool sign-up, even with a pool code in it", async ({ pool }) => {
    const ali = await pool.stranger("ali7");
    const form = await pool.signUp();
    const ex = await ali.dm(`Connect Riverside FC, code ${form.code}`);
    expect(ex.json.handled).not.toBe("pool-confirm");
    pool.expectSent(ex.sent, []);
    expect(await pool.pendingByCode(form.code!)).toMatchObject({ status: "pending-verify" });
  });

  scenario("a number that never messaged MatchTime gets nothing, whatever the form held", async ({ pool }) => {
    const form = await pool.signUp({ name: "Never Wrote" });
    pool.expectSent(form.sent, []);
    pool.expectSent(await pool.collect(), []);
    expect(await pool.pendingByCode(form.code!)).toMatchObject({ status: "pending-verify", userId: null });
  });
});

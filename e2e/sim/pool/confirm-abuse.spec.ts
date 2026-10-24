/**
 * POOL SCENARIOS: abuse of the /play sign-up and its confirm code (slice
 * L2, 2026-10-24). A flood of codes costs one reply; a number guessing
 * codes is shut out for 24 hours (a right code too), so nobody can claim
 * another person's waiting sign-up by trying codes; one address cannot
 * fill the table with sign-ups. Model-free: $0.
 */
import { POOL_CONFIRM, POOL_SIGNUP } from "@/lib/pool/rules";
import { scenario, scenarios, expect } from "./fixtures";

scenarios("abuse of the sign-up and its code", () => {
  scenario("a stranger spamming codes: one reply in all, then locked out, even for a real code", async ({ pool }) => {
    const spammer = await pool.stranger("spammer");
    const victim = await pool.stranger("victim");
    const form = await pool.signUp({ name: "Victim V" });

    const sent = [];
    for (let i = 0; i < POOL_CONFIRM.wrongCodesPerDay + 2; i++) {
      const code = ["ZZZZ", "YYYY", "XXXX", "WWWW", "VVVV", "UUUU", "TTTT", "SSSS"][i];
      sent.push(...(await spammer.dm(`Hi MatchTime, sign me up to play. Code ${code}`)).sent);
    }
    pool.expectSent(sent, [{ to: "spammer", purpose: "pool-code-reply" }]);
    expect(await pool.failedAttempts(spammer)).toBe(POOL_CONFIRM.wrongCodesPerDay);

    pool.note("the spammer now tries the victim's real code");
    const guess = await spammer.dm(form.prefill!);
    expect(guess.json).toMatchObject({ handled: "pool-confirm", result: "locked" });
    pool.expectSent(guess.sent, []);
    expect(await pool.pendingByCode(form.code!)).toMatchObject({ status: "pending-verify", userId: null });
    expect(await pool.userOf(spammer)).toBeNull();

    pool.note("the real person still confirms from his own number");
    pool.expectSent((await victim.dm(form.prefill!)).sent, [{ to: "victim", purpose: "pool-welcome" }]);
  });

  scenario("the 'that did not work' reply is rate-limited across many minutes too", async ({ pool }) => {
    const p = await pool.stranger("repeater");
    await p.dm("Code ZZZZ");
    await pool.db.run(`UPDATE "PlatformJob" SET "createdAt" = "createdAt" - interval '11 minutes' WHERE purpose = 'pool-code-reply' AND phone = $1`, [p.phone.slice(1)]);
    const second = await p.dm("Code YYYY");
    pool.expectSent(second.sent, [{ to: "repeater", purpose: "pool-code-reply" }]);
    const third = await p.dm("Code XXXX");
    pool.expectSent(third.sent, []);
  });

  scenario("one address cannot start more than the hourly cap of sign-ups", async ({ pool }) => {
    const headers = { "x-forwarded-for": "203.0.113.9" };
    const answers = [];
    for (let i = 0; i <= POOL_SIGNUP.perIpPerHour; i++) {
      const res = await pool.request.post("/api/play/signup", {
        headers,
        data: { name: `Bot ${i}`, area: { kind: "district", district: "SM1" }, maxMiles: 3, availability: [{ day: 2, from: "19:00", to: "22:00" }], sports: [{ sport: "football" }], language: "en", adult: true, consent: true },
      });
      answers.push(res.status());
    }
    expect(answers).toEqual([...Array(POOL_SIGNUP.perIpPerHour).fill(200), 429]);
    pool.expectSent(await pool.collect(), []);
  });

  scenario("a phone number or a link typed as the name is refused", async ({ pool }) => {
    expect(await pool.signUp({ name: "07700 900123" })).toMatchObject({ status: 400, errors: { name: "required" } });
    expect(await pool.signUp({ name: "https://spam.example" })).toMatchObject({ status: 400, errors: { name: "required" } });
  });
});

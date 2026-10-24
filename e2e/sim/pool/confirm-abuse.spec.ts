/**
 * POOL SCENARIOS: abuse of the /play sign-up and its confirm code (slice
 * L2, 2026-10-24). A flood of codes costs one reply; a number guessing
 * codes is shut out for 24 hours (a right code too), so nobody can claim
 * another person's waiting sign-up by trying codes; one address cannot
 * fill the table with sign-ups. Model-free: $0.
 */
import { POOL_CONFIRM, POOL_SIGNUP } from "@/lib/pool/rules";
import { setGeocodeStub } from "../../helpers/geocode-stub";
import { scenario, scenarios, expect } from "./fixtures";

/** Google placing "ZZ9" at the country only: never stored as a centre point. */
const COUNTRY_ONLY = {
  status: "OK",
  results: [
    {
      place_id: "e2e-uk",
      formatted_address: "United Kingdom",
      geometry: { location: { lat: 55.37, lng: -3.43 }, location_type: "APPROXIMATE" },
      types: ["country", "political"],
      address_components: [{ short_name: "GB", types: ["country", "political"] }],
    },
  ],
};

scenarios("abuse of the sign-up and its code", () => {
  scenario("a stranger spamming codes: one reply in all, then locked out, even for a real code", async ({ pool }) => {
    const spammer = await pool.stranger("spammer");
    const victim = await pool.stranger("victim");
    const form = await pool.signUp({ name: "Victim V" });

    const sent = [];
    for (let i = 0; i < POOL_CONFIRM.wrongCodesPerDay + 2; i++) {
      const code = ["ZZZZZ", "YYYYY", "XXXXX", "WWWWW", "VVVVV", "UUUUU", "TTTTT", "SSSSS"][i];
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
    await p.dm("Code ZZZZZ");
    await pool.db.run(`UPDATE "PlatformJob" SET "createdAt" = "createdAt" - interval '11 minutes' WHERE purpose = 'pool-code-reply' AND phone = $1`, [p.phone.slice(1)]);
    const second = await p.dm("Code YYYYY");
    pool.expectSent(second.sent, [{ to: "repeater", purpose: "pool-code-reply" }]);
    const third = await p.dm("Code XXXXX");
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

  scenario("someone already in the pool guessing codes is counted and locked like anyone; a hit never attaches the other person's sign-up", async ({ pool }) => {
    const member = await pool.stranger("guesser");
    const stranger = await pool.stranger("owner-of-code");
    pool.expectSent((await member.dm((await pool.signUp({ name: "Guesser G" })).prefill!)).sent, [{ to: "guesser", purpose: "pool-welcome" }]);
    const theirs = await pool.signUp({ name: "Owner O" });

    pool.note("a hit on a stranger's live code: told to manage his own, counted, not attached");
    const hit = await member.dm(theirs.prefill!);
    expect(hit.json).toMatchObject({ handled: "pool-confirm", result: "already-signed-up" });
    pool.expectSent(hit.sent, [{ to: "guesser", purpose: "pool-code-reply", text: /^You're already in the MatchTime player pool/ }]);
    expect(await pool.pendingByCode(theirs.code!)).toMatchObject({ status: "pending-verify", userId: null });
    expect(await pool.failedAttempts(member)).toBe(1);

    pool.note("misses count too, then the lock: every code ignored, a right one included");
    for (const c of ["ZZZZZ", "YYYYY", "XXXXX", "WWWWW"]) await member.dm(`Code ${c}`);
    expect(await pool.failedAttempts(member)).toBe(POOL_CONFIRM.wrongCodesPerDay);
    const locked = await member.dm(theirs.prefill!);
    expect(locked.json).toMatchObject({ result: "locked" });

    pool.note("the real owner still confirms his own sign-up");
    pool.expectSent((await stranger.dm(theirs.prefill!)).sent, [{ to: "owner-of-code", purpose: "pool-welcome" }]);
  });

  scenario("two wrong codes arriving at the same moment get one reply between them", async ({ pool }) => {
    const p = await pool.stranger("double");
    const [a, b] = await Promise.all([p.dm("Code ZZZZZ"), p.dm("Code YYYYY")]);
    const replies = [...a.sent, ...b.sent, ...(await pool.collect())].filter((m) => m.purpose === "pool-code-reply");
    expect(replies).toHaveLength(1);
  });

  scenario("two first messages at the same moment from a new number: one User, one profile, one welcome, no error", async ({ pool }) => {
    const p = await pool.stranger("twice-at-once");
    const form = await pool.signUp({ name: "Twice T" });
    const [a, b] = await Promise.all([p.dm(form.prefill!), p.dm(form.prefill!)]);
    const results = [a.json.result, b.json.result].sort();
    expect(results).toContain("confirmed");
    const welcomes = [...a.sent, ...b.sent, ...(await pool.collect())].filter((m) => m.purpose === "pool-welcome");
    expect(welcomes).toHaveLength(1);
    expect(await pool.db.count(`SELECT count(*) FROM "User" WHERE "phoneNumber" = $1`, [p.phone])).toBe(1);
    expect(await pool.profileOf(p)).toMatchObject({ status: "active" });
  });

  scenario("failed sign-ups count against the address too, so nobody drives unlimited lookups", async ({ pool }) => {
    const headers = { "x-forwarded-for": "203.0.113.77" };
    const body = { name: "Bot", area: { kind: "district", district: "ZZ9" }, maxMiles: 3, availability: [{ day: 2, from: "19:00", to: "22:00" }], sports: [{ sport: "football" }], language: "en", adult: true, consent: true };
    setGeocodeStub({ geocode: { "zz9, uk": { body: COUNTRY_ONLY }, "*": { body: COUNTRY_ONLY } } });
    const statuses = [];
    for (let i = 0; i <= POOL_SIGNUP.perIpPerHour; i++) statuses.push((await pool.request.post("/api/play/signup", { headers, data: body })).status());
    expect(statuses).toEqual([...Array(POOL_SIGNUP.perIpPerHour).fill(422), 429]);
    expect(await pool.db.count(`SELECT count(*) FROM "PoolAttempt" WHERE kind = 'signup' AND key = '203.0.113.77'`)).toBe(POOL_SIGNUP.perIpPerHour);
  });
});

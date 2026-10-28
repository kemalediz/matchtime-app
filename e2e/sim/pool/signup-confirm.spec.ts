/**
 * POOL SCENARIOS: signing up on /play and confirming on WhatsApp (slice
 * L2, 2026-10-24). Each scenario: someone fills in /play (the real route
 * the page posts to), sends the prefilled message from his own WhatsApp,
 * and we assert EXACTLY what MatchTime queued, for whom, and what the
 * database holds. Model-free: $0.
 *
 * The rule under test in all of them: MatchTime never messages a number
 * first. The form sends nothing; only a number that has just written gets
 * a reply, and only one.
 */
import { PRIVACY_POLICY_VERSION } from "@/lib/privacy-policy";
import { scenario, scenarios, expect } from "./fixtures";
import { setPoolPlatform } from "../../helpers/pool-platform";

scenarios("signing up on /play and confirming on WhatsApp", () => {
  scenario("happy path, English, pool not open yet: early sign-up list, consent recorded, ONE welcome to him only", async ({ pool }) => {
    // "Not open yet": the owner's platform switch off (the fixture turns it on).
    await setPoolPlatform(pool.db, false);
    const fnf = await pool.club("fnf", { name: "Friday Night Football", hq: true });
    const ali = await pool.stranger("ali", { name: "Ali Kaya" });

    const form = await pool.signUp({ name: "Ali Kaya" });
    expect(form).toMatchObject({ status: 200, ok: true, earlyList: true });
    expect(form.prefill).toBe(`Hi MatchTime, sign me up to play. Code ${form.code}`);
    expect(form.waLink).toBe(`https://wa.me/447700900555?text=${encodeURIComponent(form.prefill!)}`);
    pool.expectSent(form.sent, []);
    expect(await pool.pendingByCode(form.code!)).toMatchObject({ status: "pending-verify", userId: null, earlyList: true, areaDistrict: "SM1" });

    const ex = await ali.dm(form.prefill!);

    expect(ex.json).toMatchObject({ ok: true, handled: "pool-confirm", result: "confirmed", replied: true });
    pool.expectSent(ex.sent, [{ to: "ali", channel: "dm", purpose: "pool-welcome", text: /^✅ Thanks Ali, you're on the early sign-up list for the MatchTime player pool/ }]);
    expect(ex.sent[0].text).toContain("Stay safe: play at public venues, and tell us here about any problem.");
    expect(ex.sent[0].text).toMatch(/\/r\/[A-Za-z0-9]+/);
    expect(ex.sent[0].text).toMatch(/\/privacy$/);
    const profile = await pool.profileOf(ali);
    expect(profile).toMatchObject({
      status: "active",
      consentVersion: PRIVACY_POLICY_VERSION,
      consentChannel: "whatsapp",
      consentEvidence: ex.messageId,
      confirmCode: null,
      signupIp: null,
      earlyList: true,
    });
    expect(profile!.consentAt).toBeTruthy();
    expect(profile!.adultConfirmedAt).toBeTruthy();
    const user = await pool.userOf(ali);
    expect(user).toMatchObject({ name: "Ali Kaya" });
    expect(await pool.db.all(`SELECT action, channel, version, evidence, code, phone FROM "PoolConsentRecord" WHERE "userId" = $1`, [user!.id])).toEqual([
      { action: "consent", channel: "whatsapp", version: PRIVACY_POLICY_VERSION, evidence: ex.messageId, code: form.code, phone: ali.phone.slice(1) },
    ]);
    pool.expectNoLeaks(fnf.secrets(), { to: ["ali"] });
  });

  scenario("happy path, Turkish, pool open: the welcome is in Turkish and not the early list", async ({ pool }) => {
    const mehmet = await pool.stranger("mehmet", { name: "Mehmet" });

    const form = await pool.signUp({ name: "Mehmet Yılmaz", language: "tr", sports: [{ sport: "football", formats: [5, 7], level: "advanced" }] }, { poolOpen: true });
    expect(form).toMatchObject({ ok: true, earlyList: false });
    expect(form.prefill).toBe(`Merhaba MatchTime, oynamak için kaydet. Kod ${form.code}`);

    const ex = await mehmet.dm(form.prefill!);

    pool.expectSent(ex.sent, [{ to: "mehmet", purpose: "pool-welcome", text: /^✅ Teşekkürler Mehmet, MatchTime oyuncu havuzuna katıldın/ }]);
    expect(await pool.profileOf(mehmet)).toMatchObject({ status: "active", language: "tr", earlyList: false });
    const sports = await pool.db.all<{ sport: string; level: string | null; formats: number[] }>(
      `SELECT s.sport, s.level, s.formats FROM "PoolSport" s JOIN "PoolProfile" p ON p.id = s."profileId" JOIN "User" u ON u.id = p."userId" WHERE u."phoneNumber" = $1 ORDER BY s.sport`,
      [mehmet.phone],
    );
    expect(sports).toEqual([{ sport: "football", level: "advanced", formats: [5, 7] }]);
  });

  scenario("a sport that is not offered (football only, LIVE_SPORTS) is refused, and nothing is written or sent", async ({ pool }) => {
    const before = (await pool.poolRowCounts()).PoolProfile;
    for (const sports of [[{ sport: "basketball", formats: [5] }], [{ sport: "football", formats: [7] }, { sport: "padel" }], [{ sport: "other", otherName: "Frisbee" }]]) {
      const form = await pool.signUp({ sports });
      expect(form).toMatchObject({ status: 400, ok: false, reason: "invalid", errors: { sports: "bad-sport" } });
      expect(form.code).toBeUndefined();
      pool.expectSent(form.sent, []);
    }
    expect((await pool.poolRowCounts()).PoolProfile).toBe(before);
  });

  scenario("the form refuses without the 18+ and consent ticks, and writes nothing", async ({ pool }) => {
    const before = (await pool.poolRowCounts()).PoolProfile;
    const form = await pool.signUp({ adult: false, consent: false });
    expect(form).toMatchObject({ status: 400, ok: false, reason: "invalid", errors: { adult: "required", consent: "required" } });
    expect(form.code).toBeUndefined();
    pool.expectSent(form.sent, []);
    expect((await pool.poolRowCounts()).PoolProfile).toBe(before);
  });

  scenario("a full postcode is refused: the district only is ever held", async ({ pool }) => {
    const before = (await pool.poolRowCounts()).PoolProfile;
    const form = await pool.signUp({ area: { kind: "district", district: "SM1 1AA" } });
    expect(form).toMatchObject({ status: 400, errors: { area: "district" } });
    expect((await pool.poolRowCounts()).PoolProfile).toBe(before);
  });

  scenario("a campaign code on the URL is stamped as the source; an unknown one is just the web", async ({ pool }) => {
    await pool.db.run(`INSERT INTO "PoolCampaign" (code, source, label) VALUES ('li-kemal', 'linkedin', 'Kemal LinkedIn post')`);
    const a = await pool.signUp({ source: { c: "li-kemal" } });
    const b = await pool.signUp({ source: { c: "no-such-thing" } });
    expect(await pool.pendingByCode(a.code!)).toMatchObject({ source: "campaign", sourceCode: "li-kemal" });
    expect(await pool.pendingByCode(b.code!)).toMatchObject({ source: "web", sourceCode: null });
  });
});

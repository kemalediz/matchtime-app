/**
 * POOL SCENARIOS: the /play sign-up funnel's server steps (2026-11-04).
 * "sent" is counted where the waiting sign-up is made (the real
 * `POST /api/play/signup`), "confirmed" where his WhatsApp message makes it
 * active (the real /api/whatsapp/dm-reply), each under the bucket the
 * sign-up is attributed to, once. A count is never a person: the table
 * holds the bucket, the day, the step and a number. The page's own steps
 * (opened, started) are e2e/web/pool-funnel-steps.spec.ts. Model-free: $0.
 */
import { poolVisitDay } from "@/lib/pool/visit-rules";
import { scenario, scenarios, expect } from "./fixtures";
import type { TestDb } from "../../helpers/test-db";

const CODE = "e2e-funnel-fb";

/** Today's count for a bucket and step (0 when no row). */
async function step(db: TestDb, code: string, s: string): Promise<number> {
  const row = await db.one<{ n: number }>(`SELECT count AS n FROM "PoolCampaignVisit" WHERE code = $1 AND day = $2::date AND step = $3`, [code, poolVisitDay(new Date()), s]);
  return row?.n ?? 0;
}

scenarios("the sign-up funnel's server steps", () => {
  scenario("a campaign sign-up counts sent once under its code, and confirmed once when his WhatsApp message lands", async ({ pool }) => {
    await pool.db.run(`INSERT INTO "PoolCampaign" (code, source, label) VALUES ($1, 'facebook', 'Funnel e2e') ON CONFLICT DO NOTHING`, [CODE]);
    await pool.db.run(`DELETE FROM "PoolCampaignVisit" WHERE code IN ($1, '_direct')`, [CODE]);
    const ali = await pool.stranger("ali", { name: "Ali Kaya" });

    const form = await pool.signUp({ name: "Ali Kaya", source: { c: CODE } });
    expect(form).toMatchObject({ status: 200, ok: true });
    expect(await step(pool.db, CODE, "sent")).toBe(1);
    expect(await step(pool.db, CODE, "confirmed")).toBe(0);
    expect(await step(pool.db, "_direct", "sent")).toBe(0);

    const ex = await ali.dm(form.prefill!);
    expect(ex.json).toMatchObject({ handled: "pool-confirm", result: "confirmed" });
    expect(await step(pool.db, CODE, "confirmed")).toBe(1);

    // The same message again (a Pi retry): confirmed is not counted twice.
    await ali.dm(form.prefill!, { messageId: ex.messageId });
    expect(await step(pool.db, CODE, "confirmed")).toBe(1);
    expect(await step(pool.db, CODE, "sent")).toBe(1);
  });

  scenario("plain /play counts as direct; a refused form counts nothing; a purge of the waiting sign-up keeps the count", async ({ pool }) => {
    await pool.db.run(`DELETE FROM "PoolCampaignVisit" WHERE code = '_direct'`);
    const refused = await pool.signUp({ sports: [{ sport: "basketball", formats: [5] }] });
    expect(refused.ok).toBe(false);
    expect(await step(pool.db, "_direct", "sent")).toBe(0);

    const form = await pool.signUp({ name: "Bob Plain" });
    expect(form.ok).toBe(true);
    expect(await step(pool.db, "_direct", "sent")).toBe(1);
    await pool.db.run(`DELETE FROM "PoolProfile" WHERE "confirmCode" = $1`, [form.code]);
    expect(await step(pool.db, "_direct", "sent")).toBe(1);
  });

  // Round 3 of #607: the staff cookie is unsigned, so it never makes a
  // staff test: a sign-up with it alone is an ordinary one and is counted.
  // (A staff test needs a verified staff session: e2e/web/pool-staff-test-excluded.spec.ts.)
  scenario("a hand-set staff cookie, with no session, makes an ordinary sign-up: counted as sent", async ({ pool }) => {
    await pool.db.run(`INSERT INTO "PoolCampaign" (code, source, label) VALUES ($1, 'facebook', 'Funnel e2e') ON CONFLICT DO NOTHING`, [CODE]);
    await pool.db.run(`DELETE FROM "PoolCampaignVisit" WHERE code IN ($1, '_direct')`, [CODE]);
    for (const [n, cookie] of [[1, "mt-staff=2"], [2, "mt-staff=1"]] as const) {
      const form = await pool.signUp({ name: `Cookie Only ${n}`, source: { c: CODE } }, { cookie });
      expect(form).toMatchObject({ status: 200, ok: true });
      expect(await pool.pendingByCode(form.code!)).toMatchObject({ staffTest: false, source: "campaign", sourceCode: CODE });
      expect(await step(pool.db, CODE, "sent")).toBe(n);
    }
  });

  // The confirm is a WhatsApp message, with no cookie and no session: the
  // flag the sign-up stored decides. A staff test still confirms and is
  // still a pool player (he can be offered games), just not counted.
  scenario("a staff test confirms as any other on WhatsApp, and is not counted as confirmed", async ({ pool }) => {
    await pool.db.run(`INSERT INTO "PoolCampaign" (code, source, label) VALUES ($1, 'facebook', 'Funnel e2e') ON CONFLICT DO NOTHING`, [CODE]);
    await pool.db.run(`DELETE FROM "PoolCampaignVisit" WHERE code IN ($1, '_direct')`, [CODE]);
    const kemal = await pool.stranger("kemal-test", { name: "Staff Test" });
    const form = await pool.signUp({ name: "Staff Test", source: { c: CODE } });
    // As a verified staff session's sign-up stores it (the web spec proves that path).
    await pool.db.run(`UPDATE "PoolProfile" SET "staffTest" = true WHERE "confirmCode" = $1`, [form.code]);
    const ex = await kemal.dm(form.prefill!);
    expect(ex.json).toMatchObject({ handled: "pool-confirm", result: "confirmed" });
    expect(await pool.db.one(`SELECT status, "staffTest" FROM "PoolProfile" WHERE "sourceCode" = $1 AND "displayName" LIKE 'Staff%'`, [CODE])).toMatchObject({ status: "active", staffTest: true });
    expect(await step(pool.db, CODE, "confirmed")).toBe(0);
  });

  scenario("the table holds nothing about the person: only the bucket, the day, the step and the count", async ({ pool }) => {
    const cols = await pool.db.all<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'PoolCampaignVisit' ORDER BY column_name`,
    );
    expect(cols.map((c) => c.column_name)).toEqual(["code", "count", "day", "step"]);
  });
});

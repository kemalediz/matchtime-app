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

  scenario("the table holds nothing about the person: only the bucket, the day, the step and the count", async ({ pool }) => {
    const cols = await pool.db.all<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'PoolCampaignVisit' ORDER BY column_name`,
    );
    expect(cols.map((c) => c.column_name)).toEqual(["code", "count", "day", "step"]);
  });
});

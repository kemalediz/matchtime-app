/**
 * POOL SCENARIOS: the daily housekeeping (review of PR #399, finding 6). The
 * daily cron deletes a sign-up never confirmed on WhatsApp once it is
 * POOL_RETENTION.pendingExpiryDays old, and old rate-limit records; a newer
 * sign-up and every consent record stay. Model-free: $0.
 */
import { E2E } from "../../helpers/env";
import { scenario, scenarios, expect } from "./fixtures";

scenarios("the daily housekeeping", () => {
  scenario("an old unconfirmed sign-up and old attempts go; a recent sign-up and the consent record stay", async ({ pool }) => {
    const old = await pool.signUp({ name: "Old O" });
    const recent = await pool.signUp({ name: "New N" });
    await pool.db.run(`UPDATE "PoolProfile" SET "createdAt" = "createdAt" - interval '8 days' WHERE "confirmCode" = $1`, [old.code]);
    await pool.db.run(`INSERT INTO "PoolAttempt" (id, kind, key, result, "createdAt") VALUES ('e2e-old-attempt', 'confirm', '447700900001', 'wrong', now() - interval '40 days')`);
    await pool.db.run(
      `INSERT INTO "PoolConsentRecord" (id, "userId", action, version, channel, evidence, "createdAt") VALUES ('e2e-old-consent', 'gone-user', 'consent', 1, 'whatsapp', 'wamid-old', now() - interval '400 days')`,
    );

    const res = await pool.request.get("/api/cron/close-ratings", { headers: { authorization: `Bearer ${E2E.CRON_SECRET}` } });
    expect(res.status()).toBe(200);
    expect((await res.json()).pool).toMatchObject({ pendingDeleted: 1 });

    expect(await pool.pendingByCode(old.code!)).toBeNull();
    expect(await pool.pendingByCode(recent.code!)).toMatchObject({ status: "pending-verify" });
    expect(await pool.db.one(`SELECT id FROM "PoolAttempt" WHERE id = 'e2e-old-attempt'`)).toBeNull();
    expect(await pool.db.one(`SELECT id FROM "PoolConsentRecord" WHERE id = 'e2e-old-consent'`)).toEqual({ id: "e2e-old-consent" });
    pool.expectSent(await pool.collect(), []);
  });

  scenario("without the cron secret it does nothing", async ({ pool }) => {
    expect((await pool.request.get("/api/cron/close-ratings")).status()).toBe(401);
  });
});

/**
 * POOL SCENARIOS: the self-join connect code is never the pool's (review of
 * PR #399, finding 1, 2026-10-25). An organiser of a draft club may send
 * just "Code 7KQ2" (or "Kod 7KQ2", "kodu 7KQ2") with no "connect" verb, and
 * the connect handler takes it today. A pool code is FIVE characters and a
 * connect code four, so the pool never reads it: no pool reply, no failed
 * attempt counted, and the connect handler verifies the club. Model-free: $0.
 */
import { scenario, scenarios, expect } from "./fixtures";

const SELF_JOIN_ON = { "x-mt-test-self-join": "1" };

scenarios("a bare self-join connect code reaches the connect handler", () => {
  for (const [i, body] of ["Code 7KQ2", "Kod 7KQ3", "kodu 7KQ4"].entries()) {
    scenario(`"${body}" from the organiser: verified by the connect handler, nothing from the pool`, async ({ pool }) => {
      const org = await pool.stranger(`organiser${i}`, { name: "Organiser" });
      const digits = org.phone.slice(1);
      const code = body.split(" ")[1];
      const orgId = `e2e-pool-cc-org-${i}`;
      const userId = `e2e-pool-cc-user-${i}`;
      await pool.db.run(
        `INSERT INTO "Organisation" (id,name,slug,"inviteCode","approvalStatus",language,"createdAt","updatedAt") VALUES ($1,'Riverside FC',$1,$2,'draft','en',now(),now())`,
        [orgId, `${orgId}-invite`],
      );
      await pool.db.run(`INSERT INTO "User" (id,name,email,"phoneNumber",onboarded,"isActive","updatedAt") VALUES ($1,'Organiser',$2,$3,true,true,now())`, [
        userId,
        `${userId}@e2e-test.invalid`,
        org.phone,
      ]);
      await pool.db.run(`INSERT INTO "Membership" (id,"userId","orgId",role) VALUES ($1,$2,$3,'OWNER')`, [`${userId}-mem`, userId, orgId]);
      await pool.db.run(
        `INSERT INTO "ClubConnect" (id,"orgId","userId",phone,code,status,"issuedAt","expiresAt","updatedAt") VALUES ($1,$2,$3,$4,$5,'issued',now(),now() + interval '60 minutes',now())`,
        [`e2e-pool-cc-${i}`, orgId, userId, digits, code],
      );

      const ex = await org.dm(body, { headers: SELF_JOIN_ON });

      expect(ex.json).toMatchObject({ handled: "connect-dm", result: "verified" });
      expect(ex.sent.filter((m) => m.purpose === "pool-code-reply")).toEqual([]);
      expect(await pool.failedAttempts(org)).toBe(0);
      expect(await pool.db.one(`SELECT status FROM "ClubConnect" WHERE id = $1`, [`e2e-pool-cc-${i}`])).toEqual({ status: "dm_verified" });
    });
  }

  scenario("a bare 4-character code from a stranger, or a LID alone, is not the pool's either: nothing sent, nothing counted", async ({ pool }) => {
    const p = await pool.stranger("someone");
    const a = await p.dm("Code 7KQ9");
    const b = await p.dm("Kod 7KQ9", { envelope: { phone: "", senderLid: "158055467598000@lid" } });
    expect(a.json.handled).not.toBe("pool-confirm");
    expect(b.json.handled).not.toBe("pool-confirm");
    pool.expectSent([...a.sent, ...b.sent], []);
    expect(await pool.failedAttempts(p)).toBe(0);
  });
});

/**
 * THE OWNER'S INTRO MESSAGES, LIVE-LLM, END TO END (2026-10-29).
 *
 * The free spec (`api/dm-owner-intro.spec.ts`) proves the gate, the order
 * and the queue with the model stubbed. This drives the REAL model through
 * the REAL /api/whatsapp/dm-reply route: the owner's Turkish ask for
 * category 3 queues its two DMs to him, and a club admin's identical ask
 * queues none. Once each (Kemal's cheap test plan). Opt-in: only runs when
 * MT_SIM_LIVE_LLM=1, on the developer key.
 *
 *   MT_SIM_LIVE_LLM=1 MT_E2E_APP_PORT=3472 npm run test:e2e -- e2e/sim/owner-intro-live.spec.ts
 */
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import type { TestDb } from "../helpers/test-db";
import { ORG_ID, PHONE } from "../helpers/constants";
import { E2E } from "../helpers/env";

const LIVE = process.env.MT_SIM_LIVE_LLM === "1";
const ASK = "kategori 3 tanıtım mesajını gönder";

let n = 0;
async function postDm(request: APIRequestContext, phone: string, body: string) {
  const res = await request.post("/api/whatsapp/dm-reply", {
    headers: { "x-api-key": E2E.WHATSAPP_API_KEY },
    data: { phone, body, waMessageId: `live-intro-${Date.now()}-${++n}`, authorName: null },
  });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

const introJobs = (db: TestDb) =>
  db.all<{ phone: string; text: string }>(`SELECT phone, text FROM "PlatformJob" WHERE purpose = 'owner-intro' ORDER BY "createdAt" ASC`);

(LIVE ? test.describe : test.describe.skip)("owner intro messages LIVE (real Anthropic model)", () => {
  test.describe.configure({ mode: "serial" });
  test.beforeAll(resetDb);

  test("the owner's ask for category 3 queues its four DMs to him (EN part 1 and 2, TR part 1 and 2)", async ({ request, db }) => {
    await db.run(
      `INSERT INTO "User" (id, email, name, "phoneNumber", "updatedAt") VALUES ('live-intro-owner', 'live-intro-owner@e2e.test', 'Kemal Owner', $1, now())`,
      [`+${E2E.APPROVER_PHONE}`],
    );
    await db.run(`INSERT INTO "Membership" (id, "userId", "orgId", role) VALUES ('live-intro-owner-m', 'live-intro-owner', $1, 'PLAYER')`, [ORG_ID]);
    const json = await postDm(request, `+${E2E.APPROVER_PHONE}`, ASK);
    console.log(`[owner-intro-live] OWNER: ${JSON.stringify(json)}`);
    expect(json).toMatchObject({ handled: "owner-intro-dm", categories: [3] });
    const jobs = await introJobs(db);
    expect(jobs.map((j) => j.phone)).toEqual(Array(4).fill(E2E.APPROVER_PHONE));
    expect(jobs[0].text).toContain("Some new MatchTime features");
    expect(jobs[3].text).toContain("Başka yerlerde de oyna");
  });

  test("a club admin's identical ask queues no intro message", async ({ request, db }) => {
    const before = (await introJobs(db)).length;
    const json = await postDm(request, PHONE.admin, ASK);
    console.log(`[owner-intro-live] ADMIN: ${JSON.stringify(json)}`);
    expect(json.handled).not.toBe("owner-intro-dm");
    expect(await introJobs(db)).toHaveLength(before);
  });
});

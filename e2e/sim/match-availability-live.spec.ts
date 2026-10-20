/**
 * A PLAYER ANSWERS MATCHTIME'S DM IN THEIR OWN WORDS — LIVE-LLM, END TO END
 * (2026-10-18).
 *
 * The match-availability classifier now reads what MatchTime actually said
 * to the player last (its words) instead of a yes/no "asked to play" flag.
 * This drives the REAL model through the REAL /api/whatsapp/dm-reply route
 * against the seeded upcoming match, with the invite (or the rating DM)
 * queued as the player's last DM. No stub.
 *
 *   - "why not, coming" after the invite: registered (the model path, not
 *     the fast path).
 *   - "sorry mate, away" after the invite, already in: dropped.
 *   - a bare "yes" whose last DM was the rating request: nothing written.
 *     A wrong "in" puts somebody in a squad they never joined.
 *
 * Once each (Kemal's cheap test plan). Opt-in: only runs when
 * MT_SIM_LIVE_LLM=1, on the developer key.
 *
 *   MT_SIM_LIVE_LLM=1 npx tsx e2e/run.ts sim/match-availability-live.spec.ts
 */
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import type { TestDb } from "../helpers/test-db";
import { U, ORG_ID, PHONE, MATCH } from "../helpers/constants";
import { E2E } from "../helpers/env";

const LIVE = process.env.MT_SIM_LIVE_LLM === "1";
const DM_PHONE = PHONE.fresh.replace(/^\+/, "");

const INVITE =
  "👋 Ian, we're putting the squad together for *E2E 5-a-side* on Tue 20 Oct, 20:00. 2 spots left.\n\n" +
  "Playing? Reply *IN* or tap 👍 on this message.\n" +
  "Can't make it? Reply *OUT* or tap 👎 and I'll stop asking 🙌";
const RATING =
  "⭐ How did *E2E 5-a-side* go on Tue 13 Oct? Rate your teammates and vote for Man of the Match: https://mt.example/s/rate";

(LIVE ? test.describe : test.describe.skip)("DM match availability LIVE (real Anthropic model)", () => {
  test.describe.configure({ mode: "serial" });
  test.beforeEach(resetDb);

  async function postDm(request: APIRequestContext, body: string) {
    const res = await request.post("/api/whatsapp/dm-reply", {
      headers: { "x-api-key": E2E.WHATSAPP_API_KEY },
      data: { phone: PHONE.fresh, body, waMessageId: `false_447700900009@c.us_LIVEAVAIL${Date.now()}`, authorName: null },
    });
    expect(res.status(), await res.text()).toBe(200);
    return res.json();
  }

  /** MatchTime's DMs to Ian, oldest first, a minute apart. */
  async function lastDms(db: TestDb, texts: string[]) {
    let i = 0;
    for (const text of texts) {
      await db.run(
        `INSERT INTO "BotJob" (id, "orgId", kind, phone, text, "createdAt", "sentAt")
         VALUES ($1, $2, 'dm', $3, $4, NOW() - ($5 || ' minutes')::interval, NOW() - ($5 || ' minutes')::interval)`,
        [`live-avail-${Date.now()}-${i}`, ORG_ID, DM_PHONE, text, String(10 - i++)],
      );
    }
  }
  async function preRegister(db: TestDb) {
    await db.run(
      `INSERT INTO "Attendance" (id, "matchId", "userId", status, position, "respondedAt", "updatedAt")
       VALUES ($1, $2, $3, 'CONFIRMED', 20, NOW(), NOW())`,
      [`live-avail-att-${Date.now()}`, MATCH.upcoming, U.fresh],
    );
  }
  const statusOf = (db: TestDb) =>
    db.one<{ status: string }>(`SELECT status FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`, [
      MATCH.upcoming,
      U.fresh,
    ]);

  test("IN: 'why not, coming' after the invite registers him", async ({ request, db }) => {
    await lastDms(db, [INVITE]);
    const r = await postDm(request, "why not, coming");
    console.log(`[match-availability-live] IN: ${JSON.stringify(r)}`);
    expect(r.handled).toBe("dm-self-attendance");
    expect(r.via).toBe("llm");
    expect(r.decision).toBe("in");
    expect((await statusOf(db))?.status).toBe("CONFIRMED");
  });

  test("OUT: 'sorry mate, away' after the invite drops him", async ({ request, db }) => {
    await lastDms(db, [INVITE]);
    await preRegister(db);
    const r = await postDm(request, "sorry mate, away");
    console.log(`[match-availability-live] OUT: ${JSON.stringify(r)}`);
    expect(r.handled).toBe("dm-self-attendance");
    expect(r.via).toBe("llm");
    expect(r.decision).toBe("out");
    expect((await statusOf(db))?.status).toBe("DROPPED");
  });

  test("NEGATIVE: a bare 'yes' to the rating DM writes nothing", async ({ request, db }) => {
    await lastDms(db, [INVITE, RATING]);
    const r = await postDm(request, "yes");
    console.log(`[match-availability-live] NEGATIVE: ${JSON.stringify(r)}`);
    expect(r.handled).not.toBe("dm-self-attendance");
    expect(await statusOf(db)).toBeNull();
  });
});

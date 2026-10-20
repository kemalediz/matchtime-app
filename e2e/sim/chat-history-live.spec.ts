/**
 * THE STORED CHAT, LIVE: the two fixes of 2026-10-20 against the REAL
 * model, through the real /api/whatsapp/analyze route and a real database.
 *
 *   1. A Pi restart (no history sent), then an OUT like Naim's: the
 *      earlier lines come from the database, the sender's own line is not
 *      shown back to him, and his OUT is read (👋, DROPPED).
 *   2. A match-day injury line that the rating adjuster used to drop: 400
 *      messages in the week, the injury the newest. The adjuster used to
 *      read the OLDEST 300 and never saw it; it now reads the newest 300.
 *
 * Opt in: MT_SIM_LIVE_LLM=1 (spends ANTHROPIC_API_KEY_DEV). Skipped otherwise.
 *
 *   MT_SIM_LIVE_LLM=1 npx tsx e2e/run.ts sim/chat-history-live.spec.ts
 *
 * Prints the model calls and cost the club was billed (OrgAiUsage).
 */
import { test, expect, resetDb } from "../fixtures";
import { createGroup, type SimGroup } from "./group";
import type { TestDb } from "../helpers/test-db";

const LIVE = process.env.MT_SIM_LIVE_LLM === "1";

const usage = (db: TestDb, orgId: string) =>
  db.one<{ calls: number; cost: number }>(
    `SELECT coalesce(sum(calls), 0)::int AS calls, coalesce(sum("costUsd"), 0)::float AS cost FROM "OrgAiUsage" WHERE "orgId" = $1`,
    [orgId],
  );

/** Rows the server would have stored for earlier batches, written directly
 *  (no model call): `lines[i]` is `minutesAgo[i]` minutes old. */
async function seedStored(g: SimGroup, lines: Array<{ key: string; body: string; minutesAgo: number }>) {
  for (const [i, l] of lines.entries()) {
    const p = g.player(l.key);
    await g.db.run(
      `INSERT INTO "AnalyzedMessage" (id, "waMessageId", "orgId", "groupId", "authorUserId", "authorName", body, "handledBy", "createdAt")
       VALUES ($1, $1, $2, $3, $4, $5, $6, 'ignored', now() - make_interval(mins => $7::int))`,
      [`seed-${g.groupId}-${i}`, g.orgId, g.groupId, p.userId, p.name, l.body, l.minutesAgo],
    );
  }
}

const BANTER = [
  "anyone watching the game tonight",
  "😂😂😂",
  "who's got the bibs this week",
  "traffic on the A217 is mad",
  "great goal on Sunday",
  "what time are we starting",
  "lol",
  "same pitch as last week?",
];

(LIVE ? test.describe : test.describe.skip)("the stored chat, LIVE (real model)", () => {
  test.describe.configure({ mode: "serial" });
  test.beforeAll(resetDb);
  test.afterAll(() => resetDb());

  test("a Pi restart, then a repeated OUT like Naim's: read, 👋, still DROPPED", async ({ request, db }) => {
    test.setTimeout(180_000);
    const g = await createGroup(request, db, {
      attendance: [
        { key: "dan", status: "CONFIRMED" as const },
        { key: "felix", status: "CONFIRMED" as const },
        { key: "pete", status: "DROPPED" as const },
      ],
    });
    // FNF's shape: another member's "@Match Time out" a few minutes before,
    // and the organisers already took Pete out.
    await seedStored(g, [
      { key: "felix", body: "who's still coming tonight?", minutesAgo: 9 },
      { key: "dan", body: "@Match Time out", minutesAgo: 6 },
    ]);
    const before = await usage(db, g.orgId);
    // The Pi has just restarted: no history at all.
    const r = await g.post("pete", "@Match Time out", { tag: true });
    const after = await usage(db, g.orgId);
    console.log(`[live] restart+OUT: ${JSON.stringify({ react: r.react, reply: r.reply, handledBy: r.handledBy, intent: r.intent })}`);
    console.log(`[live] restart+OUT model calls: ${(after?.calls ?? 0) - (before?.calls ?? 0)}, cost: $${((after?.cost ?? 0) - (before?.cost ?? 0)).toFixed(5)}`);
    expect(r.react).toBe("👋");
    expect(r.reply ?? null).toBeNull();
    expect((await g.attendanceOf("pete"))?.status).toBe("DROPPED");
  });

  test("a match-day injury beyond the oldest 300 of the week reaches the rating adjuster", async ({ request, db }) => {
    test.setTimeout(240_000);
    const g = (
      await createGroup(request, db, {
        maxPlayers: 8,
        upcomingMatch: { daysFromNow: 0 },
        attendance: ["owner", "alice", "pete", "dan", "felix", "greg", "henry", "ivan"].map((key) => ({
          key,
          status: "CONFIRMED" as const,
        })),
      })
    ).attach(request);
    const keys = ["alice", "dan", "felix", "greg", "henry", "ivan"];
    // 399 lines of banter across the week (oldest ~6.5 days ago), then the
    // injury, the newest line of all, an hour ago.
    const lines = Array.from({ length: 399 }, (_, i) => ({
      key: keys[i % keys.length],
      body: BANTER[i % BANTER.length],
      minutesAgo: 9360 - i * 23,
    }));
    lines.push({ key: "pete", body: "pulled my hamstring this morning, I'll play tonight but I can barely run", minutesAgo: 60 });
    await seedStored(g, lines);

    const before = await usage(db, g.orgId);
    const r = await g.post("alice", "@Match Time generate the teams", { tag: true });
    const after = await usage(db, g.orgId);
    const adj = await db.one<{ delta: number; reason: string }>(
      `SELECT delta, reason FROM "RatingAdjustment" WHERE "matchId" = $1 AND "userId" = $2`,
      [g.matchId, g.player("pete").userId],
    );
    console.log(`[live] adjuster: pete ${JSON.stringify(adj)}; teams post ${r.reply ? "yes" : "no"}`);
    console.log(`[live] adjuster model calls: ${(after?.calls ?? 0) - (before?.calls ?? 0)}, cost: $${((after?.cost ?? 0) - (before?.cost ?? 0)).toFixed(5)}`);
    expect(adj, "the adjuster wrote an audit row for Pete").toBeTruthy();
    expect(adj!.delta).toBeLessThan(0);
  });
});

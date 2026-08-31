/**
 * DM SELF-ATTENDANCE — LIVE-LLM validation (2026-08-31).
 *
 * Drives the REAL Anthropic model through the REAL /api/whatsapp/dm-reply
 * route. No stub. This exists because the repo has been bitten before by a
 * stubbed sim passing while the live model still got the classification
 * wrong (see MDs/ + the global TDD rule): for a classification change a
 * stubbed test proves the wiring and NOTHING about the behaviour.
 *
 * The behaviour under test: an older, non-technical player ignores the
 * magic link in the recruit DM and just replies in their own words. Every
 * IN phrase must register them; every OUT phrase must drop them; every
 * hedge or question must write NOTHING.
 *
 * Each phrase runs RUNS times because the model is non-deterministic. An IN
 * that is missed even once is a player who thinks they are playing and
 * isn't — so these assertions are EVERY-RUN. Never weaken them; tighten the
 * prompt in src/lib/match-availability-classifier.ts instead.
 *
 * Opt-in: only runs when MT_SIM_LIVE_LLM=1.
 *
 * Run:
 *   set -a; source .env; set +a
 *   npm run test:sim:live:dm-in
 *   # or: MT_SIM_LIVE_LLM=1 npx tsx e2e/run.ts sim/dm-self-attendance-live.spec.ts
 */
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import type { TestDb } from "../helpers/test-db";
import { U, ORG_ID, PHONE, MATCH } from "../helpers/constants";
import { E2E } from "../helpers/env";

const LIVE = process.env.MT_SIM_LIVE_LLM === "1";
const RUNS = 5;

interface DmResponse {
  handled?: string;
  ignored?: string;
  decision?: string;
  via?: string;
  status?: string | null;
  matchId?: string;
}

(LIVE ? test.describe : test.describe.skip)(
  "DM self-attendance LIVE (real Anthropic model)",
  () => {
    test.describe.configure({ mode: "serial" });
    test.beforeAll(resetDb);

    let n = 0;
    async function postDm(request: APIRequestContext, body: string): Promise<DmResponse> {
      const res = await request.post("/api/whatsapp/dm-reply", {
        headers: { "x-api-key": E2E.WHATSAPP_API_KEY },
        data: {
          phone: PHONE.fresh,
          body,
          waMessageId: `live-dm-${Date.now()}-${++n}`,
          authorName: null,
        },
      });
      expect(res.status(), await res.text()).toBe(200);
      return res.json();
    }

    /**
     * Put the world back to "Ian Innes has been DM'd about the upcoming
     * match and has not answered yet", optionally pre-registering him so an
     * OUT has something to drop.
     */
    async function reset(db: TestDb, opts: { preRegistered?: boolean } = {}) {
      await db.run(`DELETE FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`, [
        MATCH.upcoming,
        U.fresh,
      ]);
      await db.run(`DELETE FROM "BenchSlotOffer" WHERE "matchId" = $1`, [MATCH.upcoming]);
      await db.run(`DELETE FROM "TentativeAvailability" WHERE "matchId" = $1`, [MATCH.upcoming]);
      // Clear the announcement rate ledger + the squad-full latch so a long
      // run isn't throttled by its own earlier iterations.
      await db.run(`DELETE FROM "SentNotification" WHERE kind = 'oob-attend'`);
      await db.run(`DELETE FROM "SentNotification" WHERE key = $1`, [
        `${MATCH.upcoming}:squad-locked`,
      ]);
      await db.run(`DELETE FROM "BotJob" WHERE "orgId" = $1`, [ORG_ID]);
      // The recruit DM we are pretending he is replying to.
      await db.run(
        `INSERT INTO "SentNotification" (id, key, kind, "matchId", "targetUser")
         VALUES ($1, $2, 'recruit-dm', $3, $4)
         ON CONFLICT (key) DO NOTHING`,
        [
          `live-recruit-${MATCH.upcoming}`,
          `${MATCH.upcoming}:recruit-dm:${U.fresh}`,
          MATCH.upcoming,
          U.fresh,
        ],
      );
      if (opts.preRegistered) {
        await db.run(
          `INSERT INTO "Attendance" (id, "matchId", "userId", status, position, "respondedAt", "updatedAt")
           VALUES ($1, $2, $3, 'CONFIRMED', 20, NOW(), NOW())`,
          [`live-att-${Date.now()}`, MATCH.upcoming, U.fresh],
        );
      }
    }

    const statusOf = (db: TestDb) =>
      db.one<{ status: string }>(
        `SELECT status FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`,
        [MATCH.upcoming, U.fresh],
      );

    // ── IN phrases: every single run must register ────────────────────
    const IN_PHRASES = [
      "yeah sure count me in",
      "why not, coming",
      "go on then",
      "I'll be there mate",
      "yep im in",
      "count me in 👍",
    ];

    for (const phrase of IN_PHRASES) {
      test(`IN: "${phrase}" registers every run (×${RUNS})`, async ({ request, db }) => {
        test.setTimeout(240_000);
        let hits = 0;
        const vias: string[] = [];
        for (let i = 0; i < RUNS; i++) {
          await reset(db);
          const r = await postDm(request, phrase);
          const att = await statusOf(db);
          const ok = r.handled === "dm-self-attendance" && r.decision === "in" && att?.status === "CONFIRMED";
          if (ok) hits++;
          vias.push(`${r.via ?? r.handled ?? r.ignored}`);
        }
        console.log(`[dm-in-live] IN "${phrase}": ${hits}/${RUNS} registered (via: ${vias.join(", ")})`);
        expect(hits, `"${phrase}" must register on EVERY run — a miss is a player who thinks they are playing`).toBe(RUNS);
      });
    }

    // ── OUT phrases: every single run must drop ───────────────────────
    const OUT_PHRASES = [
      "can't tomorrow sorry",
      "not this week",
      "sorry mate, away",
      "nah cant make it",
    ];

    for (const phrase of OUT_PHRASES) {
      test(`OUT: "${phrase}" drops every run (×${RUNS})`, async ({ request, db }) => {
        test.setTimeout(240_000);
        let hits = 0;
        const vias: string[] = [];
        for (let i = 0; i < RUNS; i++) {
          await reset(db, { preRegistered: true });
          const r = await postDm(request, phrase);
          const att = await statusOf(db);
          const ok = r.handled === "dm-self-attendance" && r.decision === "out" && att?.status === "DROPPED";
          if (ok) hits++;
          vias.push(`${r.via ?? r.handled ?? r.ignored}`);
        }
        console.log(`[dm-in-live] OUT "${phrase}": ${hits}/${RUNS} dropped (via: ${vias.join(", ")})`);
        expect(hits, `"${phrase}" must drop on EVERY run`).toBe(RUNS);
      });
    }

    // ── UNCLEAR: must never write, in either direction ────────────────
    const UNCLEAR_PHRASES = [
      "what time is it again?",
      "who else is playing?",
      "maybe, I'll let you know",
    ];

    for (const phrase of UNCLEAR_PHRASES) {
      test(`UNCLEAR: "${phrase}" writes nothing, every run (×${RUNS})`, async ({ request, db }) => {
        test.setTimeout(240_000);
        let clean = 0;
        for (let i = 0; i < RUNS; i++) {
          await reset(db);
          const r = await postDm(request, phrase);
          const att = await statusOf(db);
          const ok = r.handled !== "dm-self-attendance" && att === null;
          if (ok) clean++;
        }
        console.log(`[dm-in-live] UNCLEAR "${phrase}": ${clean}/${RUNS} left untouched`);
        expect(clean, `"${phrase}" must never be guessed at`).toBe(RUNS);
      });
    }

    // ── The tentative follow-up path must also understand natural yes ──
    //   Requirement 2: the hand-rolled regex there is now a fast-path only;
    //   an unmatched reply goes to the same classifier instead of
    //   triggering a "gentle re-ask".
    test(`tentative follow-up: "yeah go on then" is understood, not re-asked (×${RUNS})`, async ({
      request,
      db,
    }) => {
      test.setTimeout(240_000);
      let hits = 0;
      for (let i = 0; i < RUNS; i++) {
        await reset(db);
        await db.run(
          `INSERT INTO "TentativeAvailability" (id, "matchId", "userId", "dueAt", "updatedAt")
           VALUES ($1, $2, $3, NOW(), NOW())`,
          [`live-tent-${Date.now()}-${i}`, MATCH.upcoming, U.fresh],
        );
        const r = await postDm(request, "yeah go on then");
        const att = await statusOf(db);
        if (r.handled === "tentative-followup" && att?.status === "CONFIRMED") hits++;
      }
      console.log(`[dm-in-live] tentative "yeah go on then": ${hits}/${RUNS} understood`);
      expect(hits, "a natural yes must not trigger the re-ask").toBe(RUNS);
    });
  },
);

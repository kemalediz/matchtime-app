/**
 * TENTATIVE AVAILABILITY FOLLOW-UP — LIVE-LLM validation.
 *
 * Drives the REAL Anthropic model (no stubbed verdict) to confirm that
 * genuine personal-uncertainty messages classify as conditional_in
 * (flavour b: tentative, NO attendance write, NO tag required) — so the
 * tentative-follow-up machinery actually engages on real wording. Each
 * case runs several times because the model is non-deterministic; the
 * classification must hold EVERY run.
 *
 * Opt-in: this whole block only runs when MT_SIM_LIVE_LLM=1.
 *
 * Run:
 *   set -a; source .env; set +a
 *   npm run test:sim:live:tentative
 *   # or: MT_SIM_LIVE_LLM=1 npx tsx e2e/run.ts sim/tentative-followup-live.spec.ts
 *
 * NEVER weaken these assertions — tune the analyzer prompt until reliable.
 */
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import type { TestDb } from "../helpers/test-db";
import { createGroup } from "./group";

const LIVE = process.env.MT_SIM_LIVE_LLM === "1";
const RUNS = 5; // repeat each classification-sensitive case 5×

(LIVE ? test.describe : test.describe.skip)(
  "tentative availability follow-up LIVE (real Anthropic model)",
  () => {
    test.describe.configure({ mode: "serial" });
    test.beforeAll(resetDb);

    const mkGroup = (request: APIRequestContext, db: TestDb) =>
      createGroup(request, db, {
        maxPlayers: 14,
        upcomingMatch: { daysFromNow: 3 },
        attendance: [
          { key: "owner", status: "CONFIRMED" },
          { key: "alice", status: "CONFIRMED" },
          { key: "pete", status: "CONFIRMED" },
        ],
      });

    async function tentativeCount(db: TestDb, matchId: string): Promise<number> {
      const rows = await db.all<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM "TentativeAvailability" WHERE "matchId" = $1`,
        [matchId],
      );
      return Number(rows[0]?.n ?? "0");
    }

    // Kemal's exact example.
    test(`leg-hurting "I'll check close to the match and let you know" → tentative, NOT registered (×${RUNS})`, async ({
      request,
      db,
    }) => {
      test.setTimeout(240_000);
      let tentativeRuns = 0;
      for (let i = 0; i < RUNS; i++) {
        const grp = (await mkGroup(request, db)).attach(request);
        const matchId = grp.matchId!;
        const r = await grp.post(
          "henry",
          "my leg is hurting from yesterday's match, i will check how i am close to the match and will let you know",
        );
        const recorded = await tentativeCount(db, matchId);
         
        console.log(`[tentative-live] leg-hurting run ${i + 1}: intent=${r.intent} react=${r.react} tentativeRows=${recorded}`);

        // MUST NOT be a plain IN (no confirmed/bench attendance).
        const att = await grp.attendanceOf("henry");
        expect(
          att?.status === "CONFIRMED",
          `run ${i + 1}: must NOT be a plain confirmed IN`,
        ).toBe(false);

        // Classified as conditional_in AND recorded as tentative.
        if (r.intent === "conditional_in" && recorded === 1) tentativeRuns++;
      }
      expect(
        tentativeRuns,
        `leg-hurting must classify as conditional_in + record tentative every run`,
      ).toBe(RUNS);
    });

    test(`"maybe, I'll confirm later" → tentative, NOT registered (×${RUNS})`, async ({
      request,
      db,
    }) => {
      test.setTimeout(240_000);
      let tentativeRuns = 0;
      for (let i = 0; i < RUNS; i++) {
        const grp = (await mkGroup(request, db)).attach(request);
        const matchId = grp.matchId!;
        const r = await grp.post("greg", "maybe, I'll confirm later");
        const recorded = await tentativeCount(db, matchId);
         
        console.log(`[tentative-live] maybe-later run ${i + 1}: intent=${r.intent} tentativeRows=${recorded}`);

        const att = await grp.attendanceOf("greg");
        expect(att?.status === "CONFIRMED", `run ${i + 1}: must NOT be a plain IN`).toBe(false);
        if (r.intent === "conditional_in" && recorded === 1) tentativeRuns++;
      }
      expect(tentativeRuns, `"maybe later" must be tentative every run`).toBe(RUNS);
    });

    // Control: a plain "In" must register normally — NOT become tentative.
    test(`control plain "In" → registers, NO tentative row (×${RUNS})`, async ({
      request,
      db,
    }) => {
      test.setTimeout(240_000);
      for (let i = 0; i < RUNS; i++) {
        const grp = (await mkGroup(request, db)).attach(request);
        const matchId = grp.matchId!;
        const r = await grp.post("dan", "In");
        const recorded = await tentativeCount(db, matchId);
         
        console.log(`[tentative-live] control-IN run ${i + 1}: intent=${r.intent} react=${r.react} tentativeRows=${recorded}`);

        const att = await grp.attendanceOf("dan");
        expect(att, `run ${i + 1}: plain IN must register`).not.toBeNull();
        expect(["CONFIRMED", "BENCH"]).toContain(att!.status);
        expect(recorded, `run ${i + 1}: plain IN must NOT create a tentative row`).toBe(0);
      }
    });
  },
);

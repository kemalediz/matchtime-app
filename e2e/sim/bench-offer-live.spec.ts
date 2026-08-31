/**
 * BENCH SLOT OFFER — LIVE-LLM validation that we never ask for a 👍.
 *
 * WHY (2026-08-31): the bench copy told a benched player "React 👍 here
 * to take it" while inbound reactions were completely dead on the Pi
 * (`reaction-forwarding is unavailable`, zero forwards ever, and
 * `SentNotification.waMessageId` NULL since 18 July). A player tapped 👍,
 * believed they had the slot, and the team turned up short.
 *
 * The copy constants are gated by BENCH_PROMPT_MENTION_REACTIONS and
 * unit-tested. This file covers the half a unit test CANNOT: the LLM
 * writes the group reply to the drop itself, so if SYSTEM_PROMPT still
 * suggests "👍/👎 above" the model keeps saying it however the constants
 * are set. A stubbed sim has passed here before while the real model
 * still misbehaved, so this runs the REAL model, several times, because
 * it is non-deterministic. The assertion must hold EVERY run.
 *
 * Opt-in: only runs when MT_SIM_LIVE_LLM=1.
 *
 * Run:
 *   set -a; source .env; set +a
 *   npm run test:sim:live:bench
 *   # or: MT_SIM_LIVE_LLM=1 npx tsx e2e/run.ts sim/bench-offer-live.spec.ts
 *
 * NEVER weaken these assertions — tune the analyzer prompt until reliable.
 */
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import type { TestDb } from "../helpers/test-db";
import { createGroup } from "./group";

const LIVE = process.env.MT_SIM_LIVE_LLM === "1";
const RUNS = 3;

const ROSTER = [
  { key: "owner", name: "Oscar Owner", role: "OWNER" as const },
  { key: "alice", name: "Alice Admin", role: "ADMIN" as const },
  { key: "pete", name: "Pete Power" },
  { key: "dan", name: "Dan Drummer" },
  { key: "ehtisham", name: "Ehtisham Ekin" },
  { key: "aydin", name: "Aydın Arslan" },
  { key: "salman", name: "Salman Saric" },
];

(LIVE ? test.describe : test.describe.skip)(
  "bench slot offer LIVE (real Anthropic model)",
  () => {
    test.describe.configure({ mode: "serial" });
    test.beforeAll(resetDb);

    const mkGroup = (request: APIRequestContext, db: TestDb) =>
      createGroup(request, db, {
        maxPlayers: 5,
        players: ROSTER,
        attendance: [
          { key: "owner", status: "CONFIRMED" },
          { key: "alice", status: "CONFIRMED" },
          { key: "pete", status: "CONFIRMED" },
          { key: "dan", status: "CONFIRMED" },
          { key: "ehtisham", status: "CONFIRMED" }, // 5/5
          { key: "aydin", status: "BENCH" },
          { key: "salman", status: "BENCH" },
        ],
      });

    test(`OPEN-CALL drop with a bench: the reply never asks anyone to react (×${RUNS})`, async ({
      request,
      db,
    }) => {
      test.setTimeout(240_000);

      for (let i = 0; i < RUNS; i++) {
        const grp = (await mkGroup(request, db)).attach(request);
        // Plain unconditional drop, nobody named. This is the OPEN-CALL
        // case: the slot goes to the whole bench, first to claim it.
        const r = await grp.post("ehtisham", "sorry lads can't make it tonight");
        const text = [r.reply ?? "", ...r.groupPosts, ...r.dms.map((d) => d.text)].join("\n");

        console.log(`[bench-live] run ${i + 1}: intent=${r.intent} reply=${JSON.stringify(r.reply)}`);

        // The slot really did open (otherwise the assertions below are vacuous).
        expect((await grp.openOffers()).length, `run ${i + 1}: a slot must open`).toBe(1);

        // THE POINT: no instruction to react, in any shape.
        expect(text, `run ${i + 1}: must not ask for a 👍`).not.toContain("👍");
        expect(text, `run ${i + 1}: must not ask for a 👎`).not.toContain("👎");
        expect(text, `run ${i + 1}: must not tell anyone to react`).not.toMatch(
          /\breact(ing|ion|s)?\b/i,
        );
        expect(text, `run ${i + 1}: must not tell anyone to tap an emoji`).not.toMatch(
          /\btap\b/i,
        );

        // Pre-existing hard rule, re-pinned: the bench is tagged IN THE
        // GROUP by the analyzer path. The reply must never claim a DM.
        expect(text, `run ${i + 1}: must not claim a DM was sent`).not.toMatch(
          /\bdm'?d\b|\bin dms\b|\bvia dm\b|privately/i,
        );
      }
    });
  },
);

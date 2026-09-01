/**
 * RECRUIT CLASSIFICATION — LIVE-LLM validation.
 *
 * WHY (production, 2026-09-01, Sutton FC, in front of the club). The
 * owner posted at 11:39:
 *
 *     "Najib is out. We need one more player.
 *
 *      Can someone pls come forward"
 *
 * MatchTime recorded `intent=recruit_recent action=recruit:0
 * handledBy=fast-path conf=1` and replied:
 *
 *     "The squad for *Tuesday 5-a-side* is already full — no open spots
 *      to recruit for."
 *
 * Najib was never dropped. `looksLikeRecruitRequest` — a REGEX — matched
 * the second sentence and the recruit fast path peeled the whole message
 * off the LLM batch, so the third-party OUT was never analysed by
 * anything. The squad stayed 10/10, so the recruit action correctly found
 * zero open spots and the bot contradicted the sentence above it.
 *
 * THE FIX MOVED THE CLASSIFICATION TO THE MODEL. `recruitRequest` is now
 * an extracted verdict FACT — deliberately a FLAG, not an intent, because
 * `intent` is single-valued and this message carries two facts. The
 * server still performs the blast deterministically and still writes the
 * sentence describing it, so the 2026-06-05 guarantee (the model must
 * never *claim* "I'll DM the recent players" with nothing behind it) is
 * untouched.
 *
 * THAT MAKES THIS A PROMPT CHANGE, AND THE LIVE RESULT IS THE AUTHORITY.
 * A stubbed case can only prove the server executes a hand-written
 * verdict correctly; whether the real model sets the flag on the right
 * messages, and leaves it off roster questions, is only answerable here.
 * The model is non-deterministic, so every case runs RUNS times and the
 * assertion must hold on EVERY run.
 *
 * Opt-in: only runs when MT_SIM_LIVE_LLM=1.
 *
 * Run:
 *   set -a; source .env; set +a
 *   npm run test:sim:live:recruit
 *   # or: MT_SIM_RUNS=5 MT_SIM_LIVE_LLM=1 npx tsx e2e/run.ts sim/recruit-live.spec.ts
 *
 * NEVER weaken these assertions — tune the analyzer prompt until reliable.
 */
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import type { TestDb } from "../helpers/test-db";
import { createGroup, SimGroup } from "./group";

const LIVE = process.env.MT_SIM_LIVE_LLM === "1";
/** The model is non-deterministic — repeat every case. Raise with
 *  MT_SIM_RUNS=<n> when hunting a low-frequency misclassification. */
const RUNS = Number(process.env.MT_SIM_RUNS ?? 3);

(LIVE ? test.describe : test.describe.skip)(
  "recruit classification LIVE (real Anthropic model)",
  () => {
    // NOT serial: every case builds its own group, and a hit-rate report
    // is worthless if the first failure skips the rest.
    test.describe.configure({ mode: "default" });
    test.beforeAll(resetDb);

    /** The incident's world: 5-a-side, squad FULL at 10/10, Najib in it.
     *  liam + mike played last week and have not responded, so there is a
     *  real pool for the blast — without one the case could pass for the
     *  wrong reason. */
    const mkFullSquad = (request: APIRequestContext, db: TestDb) =>
      createGroup(request, db, {
        maxPlayers: 10, // 5-a-side
        players: [
          { key: "owner", name: "Oscar Owner", role: "OWNER" },
          { key: "alice", name: "Alice Admin", role: "ADMIN" },
          { key: "najib", name: "Najib Ahmadi" },
          { key: "pete", name: "Pete Power" },
          { key: "dan", name: "Dan Drummer" },
          { key: "felix", name: "Felix Fox" },
          { key: "greg", name: "Greg Gale" },
          { key: "henry", name: "Henry Hill" },
          { key: "ivan", name: "Ivan Ice" },
          { key: "jake", name: "Jake Jolly" },
          { key: "liam", name: "Liam Lake" },
          { key: "mike", name: "Mike Moon" },
        ],
        attendance: [
          { key: "owner", status: "CONFIRMED" },
          { key: "alice", status: "CONFIRMED" },
          { key: "najib", status: "CONFIRMED" },
          { key: "pete", status: "CONFIRMED" },
          { key: "dan", status: "CONFIRMED" },
          { key: "felix", status: "CONFIRMED" },
          { key: "greg", status: "CONFIRMED" },
          { key: "henry", status: "CONFIRMED" },
          { key: "ivan", status: "CONFIRMED" },
          { key: "jake", status: "CONFIRMED" },
        ],
        completedMatch: { daysAgo: 7, confirmedKeys: ["owner", "pete", "liam", "mike"] },
      });

    /** A SHORT squad: 6/10, so a recruit ask has somewhere to go. */
    const mkShortSquad = (request: APIRequestContext, db: TestDb) =>
      createGroup(request, db, {
        maxPlayers: 10,
        attendance: [
          { key: "owner", status: "CONFIRMED" },
          { key: "alice", status: "CONFIRMED" },
          { key: "brian", status: "CONFIRMED" },
          { key: "pete", status: "CONFIRMED" },
          { key: "dan", status: "CONFIRMED" },
          { key: "felix", status: "CONFIRMED" },
        ],
        completedMatch: { daysAgo: 7, confirmedKeys: ["owner", "pete", "liam", "mike"] },
      });

    const recruitDms = (grp: SimGroup) =>
      grp.db.count(
        `SELECT COUNT(*) FROM "BotJob" WHERE "orgId" = $1 AND kind = 'dm' AND text ILIKE '%reply *IN*%'`,
        [grp.orgId],
      );

    /** The Pi forwards its chat buffer on EVERY analyze call, so a
     *  context-free message is not the production prompt. The last thing
     *  in the buffer was MatchTime's own roster post saying the squad was
     *  FULL — which is exactly the context that made "already full" feel
     *  like a reasonable answer. */
    const FULL_SQUAD_HISTORY = [
      {
        authorName: "MatchTime",
        body:
          "🗓 *Tuesday 5-a-side* — Tue, 20:00.\n\n*Confirmed (10/10):*\n" +
          "1. Oscar Owner\n2. Alice Admin\n3. Najib Ahmadi\n4. Pete Power\n5. Dan Drummer\n" +
          "6. Felix Fox\n7. Greg Gale\n8. Henry Hill\n9. Ivan Ice\n10. Jake Jolly\n\n" +
          "Squad is full. 🙌",
      },
      { authorName: "Pete Power", body: "🔥🔥" },
    ];

    // ── THE PRODUCTION REGRESSION, replayed with its real context ──────
    test(`PRODUCTION REPLAY: "Najib is out. We need one more player." → Najib drops AND the recruit runs at 9/10 (×${RUNS})`, async ({
      request,
      db,
    }) => {
      test.setTimeout(420_000);
      let hits = 0;
      const failures: string[] = [];
      for (let i = 0; i < RUNS; i++) {
        const grp = (await mkFullSquad(request, db)).attach(request);
        // UNTAGGED, exactly as production was. The owner is an admin, so
        // his recruit command addresses the bot; that is what lets the
        // third-party OUT in the same message through the tag gate.
        const res = await grp.postBatch(
          [
            {
              player: "owner",
              body: "Najib is out. We need one more player.\n\nCan someone pls come forward",
            },
          ],
          { history: FULL_SQUAD_HISTORY },
        );
        const najib = await grp.attendanceOf("najib");
        const counts = await grp.counts();
        const dms = await recruitDms(grp);
        const replies = res.results.map((r) => r.reply).filter((r): r is string => !!r?.trim());
        const said = [...replies, ...res.groupPosts];
        console.log(
          `[recruit-live] PROD REPLAY run ${i + 1}: najib=${najib?.status ?? "NO ROW"} ` +
            `confirmed=${counts.confirmed} recruitDms=${dms} sends=${said.length} ` +
            `reply=${JSON.stringify((replies[0] ?? "").slice(0, 140))}`,
        );
        const problems: string[] = [];
        // 1. The attendance half must not be swallowed.
        if (najib?.status !== "DROPPED") problems.push(`najib=${najib?.status ?? "no row"}`);
        // 2. The recruit must see the CORRECTED squad.
        if (counts.confirmed !== 9) problems.push(`confirmed=${counts.confirmed}`);
        // 3. It must have actually recruited, not reported a full squad.
        if (dms === 0) problems.push("no invite DMs");
        // 4. ONE send for one message. Two is the nagging the interaction
        //    contract exists to prevent.
        if (said.length !== 1) problems.push(`${said.length} sends`);
        // 5. The incident's actual reply, which must never appear again.
        if (/already full|no open spots/i.test(said.join("\n"))) {
          problems.push("said the squad was full");
        }
        if (problems.length === 0) hits++;
        else failures.push(`run ${i + 1}: ${problems.join(", ")}`);
      }
      console.log(`[recruit-live] HIT-RATE production replay: ${hits}/${RUNS}`);
      expect(failures.join(" | "), "the drop and the recruit must BOTH happen, in that order, once").toBe(
        "",
      );
      expect(hits).toBe(RUNS);
    });

    // ── MUST FIRE: a bare shortage ask from an admin ───────────────────
    test(`a plain shortage ask from an admin fires the blast (×${RUNS})`, async ({ request, db }) => {
      test.setTimeout(420_000);
      let hits = 0;
      const failures: string[] = [];
      for (let i = 0; i < RUNS; i++) {
        const grp = (await mkShortSquad(request, db)).attach(request);
        await grp.postBatch([{ player: "owner", body: "lads we're 4 short for tuesday, anyone free?" }]);
        const dms = await recruitDms(grp);
        console.log(`[recruit-live] SHORTAGE ASK run ${i + 1}: recruitDms=${dms}`);
        if (dms > 0) hits++;
        else failures.push(`run ${i + 1}: no invite DMs`);
      }
      console.log(`[recruit-live] HIT-RATE shortage ask: ${hits}/${RUNS}`);
      expect(failures.join(" | ")).toBe("");
      expect(hits).toBe(RUNS);
    });

    // ── MUST NOT FIRE: a roster question is answered, never blasted ────
    //   This is the distinction `looksLikeRecruitRequest` tried to draw
    //   with a "hard exclusions" regex. It is language understanding, and
    //   it is now the model's job. Prove the model does it.
    test(`a roster question is NEVER a recruit blast (×${RUNS})`, async ({ request, db }) => {
      test.setTimeout(420_000);
      let hits = 0;
      const failures: string[] = [];
      for (let i = 0; i < RUNS; i++) {
        const grp = (await mkShortSquad(request, db)).attach(request);
        const res = await grp.postBatch([
          { player: "owner", body: "@Match Time can you list the players for tuesday?", tag: true },
        ]);
        const dms = await recruitDms(grp);
        const said = [
          ...res.results.map((r) => r.reply ?? ""),
          ...res.groupPosts,
        ].join("\n");
        console.log(
          `[recruit-live] ROSTER Q run ${i + 1}: recruitDms=${dms} reply=${JSON.stringify(said.slice(0, 140))}`,
        );
        const problems: string[] = [];
        if (dms !== 0) problems.push(`${dms} invite DMs`);
        // …and it must not CLAIM to have messaged anyone either. That
        // false promise is the 2026-06-05 defect the fast path was built
        // for; giving the model the flag back must not bring it back.
        if (/I'?ll\s+(dm|message|text|ping|ask)\b|I'?ve\s+(dm'?d|messaged|texted)\b/i.test(said)) {
          problems.push("promised a DM it did not send");
        }
        if (problems.length === 0) hits++;
        else failures.push(`run ${i + 1}: ${problems.join(", ")}`);
      }
      console.log(`[recruit-live] HIT-RATE roster question: ${hits}/${RUNS}`);
      expect(failures.join(" | ")).toBe("");
      expect(hits).toBe(RUNS);
    });

    // ── MUST NOT FIRE: a statement of fact with no ask ─────────────────
    test(`"we're a bit short but it's fine" is not an ask (×${RUNS})`, async ({ request, db }) => {
      test.setTimeout(420_000);
      let hits = 0;
      const failures: string[] = [];
      for (let i = 0; i < RUNS; i++) {
        const grp = (await mkShortSquad(request, db)).attach(request);
        await grp.postBatch([
          { player: "owner", body: "we're a bit short this week but it'll be fine, we'll just play 3-a-side" },
        ]);
        const dms = await recruitDms(grp);
        console.log(`[recruit-live] NO-ASK STATEMENT run ${i + 1}: recruitDms=${dms}`);
        if (dms === 0) hits++;
        else failures.push(`run ${i + 1}: ${dms} invite DMs on a statement with no ask`);
      }
      console.log(`[recruit-live] HIT-RATE no-ask statement: ${hits}/${RUNS}`);
      expect(failures.join(" | ")).toBe("");
      expect(hits).toBe(RUNS);
    });
  },
);

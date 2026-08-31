/**
 * THIRD-PARTY OFFER SUBJECT — LIVE-LLM validation.
 *
 * WHY (production, 2026-08-31): Amir posted in the club group
 *
 *     "@Kemal Ediz my brother can play if needed"
 *
 * offering his BROTHER. The analyzer read it as the STANDING-OFFER
 * flavour of `conditional_in` — availability contingent on squad state,
 * "if needed" — and benched AMIR, who was never playing at all. The
 * error then leaked into the 17:00 roster the bot posted to the whole
 * group ("Bench (1): 1. Amir") and the club owner had to spot it.
 *
 * Root cause: the `conditional_in` rule defined the category by the
 * SHAPE of the offer and never required the offer to be about the
 * SENDER. "my brother can play if needed" matches the shape exactly.
 *
 * The contract this file pins — the SUBJECT of the offer decides:
 *   • Offer about the SENDER   → conditional_in + BENCH (unchanged).
 *   • Offer about a THIRD PARTY, unnamed → NO attendance write for the
 *     sender at all; ask warmly for the name.
 *   • Offer about a THIRD PARTY, named   → registerFor IN for them, and
 *     still no row for the sender.
 *   • MIXED ("me and my brother") → the sender IS included.
 *
 * A stubbed sim CANNOT cover this: the classification itself is the
 * bug, so the verdict must come from the REAL model. It is
 * non-deterministic, so every case runs RUNS times and the assertion
 * must hold on EVERY run.
 *
 * Opt-in: only runs when MT_SIM_LIVE_LLM=1.
 *
 * Run:
 *   set -a; source .env; set +a
 *   npm run test:sim:live:third-party
 *   # or: MT_SIM_LIVE_LLM=1 npx tsx e2e/run.ts sim/third-party-offer-live.spec.ts
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
const RUNS = Number(process.env.MT_SIM_RUNS ?? 5);

(LIVE ? test.describe : test.describe.skip)(
  "third-party offer subject LIVE (real Anthropic model)",
  () => {
    // NOT serial: every case builds its own group, and a hit-rate
    // report is worthless if the first failure skips the rest.
    test.describe.configure({ mode: "default" });
    test.beforeAll(resetDb);

    // 8/14 with one drop — the real Sutton squad state at 30/08 23:03
    // London, the moment the bug fired. Amir/Enayem are deliberately NOT
    // seeded; noah/quinn/ryan drive the standalone cases below.
    const mkGroup = (request: APIRequestContext, db: TestDb) =>
      createGroup(request, db, {
        maxPlayers: 14,
        players: [
          { key: "owner", name: "Oscar Owner", role: "OWNER" },
          { key: "alice", name: "Alice Admin", role: "ADMIN" },
          { key: "amir", name: "Amir Ahmadi" },
          { key: "enayem", name: "Enayem Rashid" },
          { key: "pete", name: "Pete Power" },
          { key: "dan", name: "Dan Drummer" },
          { key: "felix", name: "Felix Fox" },
          { key: "greg", name: "Greg Gale" },
          { key: "henry", name: "Henry Hill" },
          { key: "ivan", name: "Ivan Ice" },
          { key: "jake", name: "Jake Jolly" },
          { key: "noah", name: "Noah North" },
          { key: "quinn", name: "Quinn Quick" },
          { key: "ryan", name: "Ryan Reef" },
        ],
        attendance: [
          { key: "owner", status: "CONFIRMED" },
          { key: "alice", status: "CONFIRMED" },
          { key: "pete", status: "CONFIRMED" },
          { key: "dan", status: "CONFIRMED" },
          { key: "felix", status: "CONFIRMED" },
          { key: "greg", status: "CONFIRMED" },
          { key: "henry", status: "CONFIRMED" },
          { key: "ivan", status: "CONFIRMED" },
          { key: "jake", status: "DROPPED" },
        ],
      });

    const attendanceByName = (grp: SimGroup, name: string) =>
      grp.db.one<{ status: string }>(
        `SELECT a.status FROM "Attendance" a JOIN "User" u ON u.id = a."userId"
         WHERE a."matchId" = $1 AND u.name ILIKE $2`,
        [grp.matchId, `%${name}%`],
      );

    // ── THE PRODUCTION REGRESSION, replayed with its real context ──────
    //
    // A context-free single message is NOT the production prompt: the Pi
    // forwards its last-15 in-memory chat buffer on every analyze call,
    // and the last thing in Sutton's buffer was MT's own roster post
    // saying the squad was SEVEN short. That "we need 7 more" framing
    // sitting above the message is what makes "if needed" read as a
    // squad-state contingency — the standing-offer shape — and it is the
    // half a bare sim misses.
    //
    // Note there is NO @Match Time tag: "@Kemal Ediz" tags a human, and
    // conditional_in with no registerFor is tag-free self-attendance, so
    // the bench write went straight in with nothing to stop it.
    const PROD_HISTORY = [
      {
        authorName: "MatchTime",
        body:
          "🗓 *Tuesday 7-a-side* — Tue 1 Sept, 21:30 at Goals North Cheam.\n\n" +
          "*Confirmed (7/14):*\n1. Oscar Owner\n2. Alice Admin\n3. Pete Power\n4. Dan Drummer\n" +
          "5. Felix Fox\n6. Greg Gale\n7. Henry Hill\n\n" +
          "We need *7 more*. Reply *IN* to grab a spot.",
      },
      { authorName: "Ivan Ice", body: "IN" },
      { authorName: "Quinn Quick", body: "https://www.instagram.com/reel/DaClAuzs1eQ/" },
      { authorName: "Ryan Reef", body: "Happy Holiday" },
    ];

    test(`PRODUCTION REPLAY: Amir offers his brother, squad 7 short → Amir gets NO row (×${RUNS})`, async ({
      request,
      db,
    }) => {
      test.setTimeout(420_000);
      let hits = 0;
      const failures: string[] = [];
      for (let i = 0; i < RUNS; i++) {
        const grp = (await mkGroup(request, db)).attach(request);
        // The batch as the Pi flushed it: Enayem's plain IN, then Amir's
        // offer. The name ("Shahrokh") only arrived in a LATER flush, so
        // it must not be in this one — that is what made the model guess.
        const r = await grp.postBatch(
          [
            { player: "enayem", body: "In" },
            { player: "amir", body: "@Kemal Ediz my brother can play if needed" },
          ],
          { history: PROD_HISTORY },
        );
        const amir = await grp.attendanceOf("amir");
        const intent = r.results[1].intent;
        // eslint-disable-next-line no-console
        console.log(
          `[third-party-live] PROD REPLAY run ${i + 1}: intents=${r.results.map((x) => x.intent).join(",")} ` +
            `amir=${amir ? amir.status : "NO ROW"} reply=${JSON.stringify((r.results[1].reply ?? "").slice(0, 90))}`,
        );
        // TWO assertions, and the second is the one that matters most.
        // "no row" alone is luck: `conditional_in` is a SELF-attendance
        // intent, so the moment the model pairs it with the standing-offer
        // BENCH — which is exactly what it did in production — the write
        // lands with no tag gate and no seatbelt in the way. Reaching that
        // classification AT ALL is the defect; the write is the symptom.
        const ok = amir === null && intent !== "conditional_in";
        if (ok) hits++;
        else
          failures.push(
            `run ${i + 1}: amir=${amir ? amir.status : "no row"} intent=${intent}`,
          );
      }
      // eslint-disable-next-line no-console
      console.log(`[third-party-live] HIT-RATE production replay: ${hits}/${RUNS}`);
      expect(
        failures.join(" | "),
        `Amir offered his BROTHER — he must never be written to the squad or the bench`,
      ).toBe("");
      expect(hits).toBe(RUNS);
    });

    test(`PRODUCTION REPLAY, second flush: the name arrives → Shahrokh IN, Amir still no row (×${RUNS})`, async ({
      request,
      db,
    }) => {
      test.setTimeout(420_000);
      let hits = 0;
      const failures: string[] = [];
      for (let i = 0; i < RUNS; i++) {
        const grp = (await mkGroup(request, db)).attach(request);
        const r = await grp.postBatch(
          [
            { player: "owner", body: "yes pls, can you share the name?" },
            { player: "amir", body: "Shahrokh" },
          ],
          {
            history: [
              ...PROD_HISTORY,
              { authorName: "Enayem Rashid", body: "In" },
              { authorName: "Amir Ahmadi", body: "@Kemal Ediz my brother can play if needed" },
            ],
          },
        );
        const amir = await grp.attendanceOf("amir");
        const shahrokh = await attendanceByName(grp, "Shahrokh");
        // eslint-disable-next-line no-console
        console.log(
          `[third-party-live] PROD REPLAY 2 run ${i + 1}: intents=${r.results.map((x) => x.intent).join(",")} ` +
            `shahrokh=${shahrokh ? shahrokh.status : "NO ROW"} amir=${amir ? amir.status : "NO ROW"}`,
        );
        if (shahrokh && amir === null) hits++;
        else
          failures.push(
            `run ${i + 1}: shahrokh=${shahrokh ? shahrokh.status : "NOT registered"} amir=${amir ? amir.status : "no row"}`,
          );
      }
      // eslint-disable-next-line no-console
      console.log(`[third-party-live] HIT-RATE production replay (name flush): ${hits}/${RUNS}`);
      expect(
        failures.join(" | "),
        `the NAMED guest is registered; the sender who named him is not`,
      ).toBe("");
      expect(hits).toBe(RUNS);
    });

    // ── STANDALONE REGRESSIONS — sender must get NO attendance row ──────
    //
    // Tagged (botMentioned) on purpose: an untagged third-party offer is
    // ALSO stopped by the @Match Time gate, which would mask a wrong
    // classification. Tagging removes the safety net so these cases test
    // the classification itself.

    const NO_WRITE_CASES: Array<{ label: string; sender: string; body: string }> = [
      {
        // The production wording, on its own.
        label: "my brother can play if needed",
        sender: "noah",
        body: "@Match Time my brother can play if needed",
      },
      {
        label: "my mate could fill in if you're short",
        sender: "quinn",
        body: "my mate could fill in if you're short",
      },
      {
        label: "I can bring someone if you need",
        sender: "ryan",
        body: "I can bring someone if you need",
      },
    ];

    for (const c of NO_WRITE_CASES) {
      test(`third-party offer "${c.label}" → sender gets NO attendance row (×${RUNS})`, async ({
        request,
        db,
      }) => {
        test.setTimeout(300_000);
        let hits = 0;
        const failures: string[] = [];
        for (let i = 0; i < RUNS; i++) {
          const grp = (await mkGroup(request, db)).attach(request);
          const r = await grp.post(c.sender, c.body, {
            botMentioned: true,
            history: PROD_HISTORY, // "we need 7 more" — the framing that misled the model
          });
          const att = await grp.attendanceOf(c.sender);
          // eslint-disable-next-line no-console
          console.log(
            `[third-party-live] "${c.label}" run ${i + 1}: intent=${r.intent} react=${r.react} ` +
              `sender=${att ? att.status : "NO ROW"} reply=${JSON.stringify((r.reply ?? "").slice(0, 90))}`,
          );
          // Same pair as the production replay: no row, AND not classified
          // as the sender's own conditional — see the note there.
          if (att === null && r.intent !== "conditional_in") hits++;
          else
            failures.push(
              `run ${i + 1}: sender=${att ? att.status : "no row"} intent=${r.intent}`,
            );
        }
        // eslint-disable-next-line no-console
        console.log(`[third-party-live] HIT-RATE "${c.label}": ${hits}/${RUNS}`);
        expect(
          failures.join(" | "),
          `the sender only offered a THIRD PARTY — they must never get an attendance row`,
        ).toBe("");
        expect(hits).toBe(RUNS);
      });
    }

    // ── POSITIVE CONTROLS — standing offers about the SENDER still bench ──

    const BENCH_CASES: Array<{ label: string; sender: string; body: string }> = [
      { label: "I'll be the 14th if you're short", sender: "noah", body: "I'll be the 14th if you're short" },
      { label: "ping me if you need one more", sender: "quinn", body: "ping me if you need one more" },
    ];

    for (const c of BENCH_CASES) {
      test(`self standing offer "${c.label}" → sender BENCHED (×${RUNS})`, async ({
        request,
        db,
      }) => {
        test.setTimeout(300_000);
        let hits = 0;
        const failures: string[] = [];
        for (let i = 0; i < RUNS; i++) {
          const grp = (await mkGroup(request, db)).attach(request);
          const r = await grp.post(c.sender, c.body, { history: PROD_HISTORY });
          const att = await grp.attendanceOf(c.sender);
          // eslint-disable-next-line no-console
          console.log(
            `[third-party-live] "${c.label}" run ${i + 1}: intent=${r.intent} react=${r.react} ` +
              `sender=${att ? att.status : "NO ROW"}`,
          );
          if (att?.status === "BENCH") hits++;
          else failures.push(`run ${i + 1}: sender was ${att ? att.status : "NOT registered"}`);
        }
        // eslint-disable-next-line no-console
        console.log(`[third-party-live] HIT-RATE "${c.label}": ${hits}/${RUNS}`);
        expect(
          failures.join(" | "),
          `a standing offer about the SENDER must still take a bench slot`,
        ).toBe("");
        expect(hits).toBe(RUNS);
      });
    }

    // ── MIXED — the sender is included when they say so ────────────────

    test(`mixed "me and my brother are both in" → sender registered IN (×${RUNS})`, async ({
      request,
      db,
    }) => {
      test.setTimeout(300_000);
      let hits = 0;
      const failures: string[] = [];
      for (let i = 0; i < RUNS; i++) {
        const grp = (await mkGroup(request, db)).attach(request);
        const r = await grp.post("ryan", "me and my brother are both in", {
          history: PROD_HISTORY,
        });
        const att = await grp.attendanceOf("ryan");
        // eslint-disable-next-line no-console
        console.log(
          `[third-party-live] "me and my brother" run ${i + 1}: intent=${r.intent} react=${r.react} ` +
            `sender=${att ? att.status : "NO ROW"}`,
        );
        if (att && (att.status === "CONFIRMED" || att.status === "BENCH")) hits++;
        else failures.push(`run ${i + 1}: sender was ${att ? att.status : "NOT registered"}`);
      }
      // eslint-disable-next-line no-console
      console.log(`[third-party-live] HIT-RATE "me and my brother are both in": ${hits}/${RUNS}`);
      expect(
        failures.join(" | "),
        `"me and my brother" includes the sender — they must be registered`,
      ).toBe("");
      expect(hits).toBe(RUNS);
    });

    // ── NAMED THIRD PARTY — registerFor IN, still no row for the sender ──

    test(`named third party "my brother Shahrokh can play" → Shahrokh IN, sender no row (×${RUNS})`, async ({
      request,
      db,
    }) => {
      test.setTimeout(300_000);
      let hits = 0;
      const failures: string[] = [];
      for (let i = 0; i < RUNS; i++) {
        const grp = (await mkGroup(request, db)).attach(request);
        const r = await grp.post("noah", "my brother Shahrokh can play", {
          history: PROD_HISTORY,
        });
        const guest = await attendanceByName(grp, "Shahrokh");
        const sender = await grp.attendanceOf("noah");
        // eslint-disable-next-line no-console
        console.log(
          `[third-party-live] "Shahrokh" run ${i + 1}: intent=${r.intent} react=${r.react} ` +
            `guest=${guest ? guest.status : "NO ROW"} sender=${sender ? sender.status : "NO ROW"}`,
        );
        const ok = !!guest && (guest.status === "CONFIRMED" || guest.status === "BENCH") && sender === null;
        if (ok) hits++;
        else
          failures.push(
            `run ${i + 1}: guest=${guest ? guest.status : "NOT registered"} sender=${sender ? sender.status : "no row"}`,
          );
      }
      // eslint-disable-next-line no-console
      console.log(`[third-party-live] HIT-RATE "my brother Shahrokh can play": ${hits}/${RUNS}`);
      expect(
        failures.join(" | "),
        `a NAMED third party is registered; the sender is not`,
      ).toBe("");
      expect(hits).toBe(RUNS);
    });
  },
);

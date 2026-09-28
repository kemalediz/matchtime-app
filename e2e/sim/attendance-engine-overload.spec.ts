/**
 * WHAT AN OVERLOADED API COSTS, UNDER PRODUCTION-SHAPED LOAD.
 *
 * §10 step 6 changed the SHAPE of the pipeline's exposure to a bad minute
 * at the API. The analyzer made one call per BATCH and rode an overload
 * window out; the engine makes one per MESSAGE, fanned out in parallel,
 * and does not. PR #44's first live corpus sweep measured that exactly:
 * 27 `529 Overloaded` and 3 `500`s across 10 of 177 messages at the SDK
 * default of two retries, taking two corpus cases from 3/3 to 0/3 without
 * the engine ever deciding them wrongly.
 *
 * `maxRetries: 4` took that to zero — and that is the problem this file
 * exists for. **The fallback never fired in the corpus sweep**, because
 * the retry absorbed everything. For a path a real club depends on,
 * "the second line of defence has never been exercised in anger" is not
 * a state to ship in.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ⚠️ INVERTED 2026-09-06 (§10 STEP 8). THERE IS NO SECOND LINE OF
 *    DEFENCE. THIS FILE NOW MEASURES THE LOSS.
 * ═══════════════════════════════════════════════════════════════════════
 *
 * What this header promised until today, and what every case asserted:
 *
 *     1. every attendance write still LANDS — by the other decider;
 *     2. nothing is silently DROPPED;
 *     3. no message is decided TWICE;
 *     4. the degradation is LOUD.
 *
 * (1) IS GONE. `attendance-engine-batch.ts` still drops a failed
 * extraction out of `ownedIds`, and the message still reaches
 * `analyze/route.ts`'s "NOBODY OWNED IT" branch — where the analyzer used
 * to be. §10 step 8 deleted it. So a player who said IN is not in the
 * squad, because the API was busy. That is the exact failure step 6
 * refused to accept, and it is now the shipped behaviour whenever an
 * extractor call fails after the SDK's four retries.
 *
 * (2), (3) and (4) survive intact and are what every case below still
 * proves: one `AnalyzedMessage` row per message whatever failed, one
 * decider each, a `reasoning` string naming the stage that failed, and
 * one deduped operator DM. Silence with no signal is §9's signature
 * failure; silence WITH a signal is the accepted one.
 *
 * WHAT WOULD MAKE THIS ACCEPTABLE is not a fallback decider (there is
 * none to build) but a RETRY or a REPLAY of the failed id, and neither
 * exists yet. The numbers below are what it costs until one does — the
 * sustained sweep prints a measured loss RATE rather than a fallback
 * rate, and that number is the argument for building one.
 *
 * WHAT MAKES THE INJECTED FAILURE HONEST. The extractor stub throws
 * `OVERLOADED_MESSAGE`, and that string is not invented here: it is
 * pinned in `src/lib/pipeline/__tests__/overload.test.ts` against a REAL
 * 529 answered by a real loopback HTTP server, through the real
 * `anthropicModel()`, after the real SDK retry ladder (measured: 5
 * attempts over ~7s). If the SDK ever changes what it throws, that test
 * fails rather than this suite quietly testing a fiction.
 */
import { test, expect, resetDb } from "../fixtures";
import { createGroup, type BatchItem } from "./group";
import { claim, clearExtractorStub, clearRouterStub, facts, otherFacts, selfIn } from "../helpers/stub";

import type { TestDb } from "../helpers/test-db";

const LIVE = process.env.MT_SIM_LIVE_LLM === "1";

/** The operator notes recorded for one org (the owner's /admin/health
 *  page). Since 2026-09-28 they are rows, never DMs. */
const operatorNotes = (db: TestDb, orgId: string) =>
  db.all<{ title: string; detail: string }>(
    `SELECT title, detail FROM "OpsAlert" WHERE "orgId" = $1 AND kind = 'operator-note'`,
    [orgId],
  );

// Skipped under MT_SIM_LIVE_LLM=1 for the same reason as the rest of the
// step-6 specs: that flag pins both stub seams empty on purpose, so
// there is no way to inject a deterministic overload. A live sweep
// measures whether the model is right; this measures what happens when
// it cannot be reached at all, which is not a question money answers.
(LIVE ? test.describe.skip : test.describe)(
  "§10 step 6 — an overloaded extractor, and what it loses",
  () => {
    test.describe.configure({ mode: "serial" });
    test.beforeAll(resetDb);
    test.afterEach(() => {
      clearRouterStub();
      clearExtractorStub();
    });

    /** A batch mix shaped like a real chase window rather than a demo:
     *  two self INs, a self OUT, an admin's third-party drop, a question,
     *  and two lines of banter. Seven messages, four of them attendance,
     *  which is roughly what production's own intent mix looks like. */
    function chaseWindow(): { items: BatchItem[]; owned: string[] } {
      const items: BatchItem[] = [
        { player: "pete", body: "im in lads", route: "self_att", facts: selfIn() },
        { player: "dan", body: "in for me too", route: "self_att", facts: selfIn() },
        {
          player: "felix",
          body: "sorry cant make it this week",
          route: "self_att",
          facts: facts([claim({ polarity: "out" })]),
        },
        {
          player: "alice",
          body: "@Match Time take Greg out he is injured",
          tag: true,
          route: "other_att",
          facts: otherFacts("Greg", "out"),
        },
        { player: "henry", body: "😂😂😂", route: "none" },
        { player: "ivan", body: "that was never a penalty", route: "none" },
        {
          player: "jake",
          body: "who is playing this week",
          route: "question",
          facts: { topic: "squad", personRef: null, statedCount: null },
        },
      ];
      return {
        items,
        owned: [
          "im in lads",
          "in for me too",
          "sorry cant make it this week",
          "@Match Time take Greg out he is injured",
        ],
      };
    }

    /** Every message that went in came out with exactly one row, and the
     *  row names exactly one decider. This is assertions 2 and 3, and
     *  they are the ones that survived. */
    async function oneRowPerMessage(
      db: { all: <T>(sql: string, params?: unknown[]) => Promise<T[]> },
      orgId: string,
      bodies: string[],
    ): Promise<Record<string, string>> {
      const rows = await db.all<{ body: string; handledBy: string; n: string }>(
        `SELECT body, "handledBy", count(*)::text AS n
           FROM "AnalyzedMessage" WHERE "orgId" = $1
          GROUP BY body, "handledBy"`,
        [orgId],
      );
      const byBody: Record<string, string> = {};
      for (const r of rows) {
        expect(r.n, `"${r.body}" was analyzed ${r.n} times`).toBe("1");
        expect(byBody[r.body], `"${r.body}" has two deciders`).toBeUndefined();
        byBody[r.body] = r.handledBy;
      }
      for (const b of bodies) {
        expect(Object.keys(byBody), `"${b}" produced no AnalyzedMessage row`).toContain(b);
      }
      return byBody;
    }

    // ── the worst case first ──────────────────────────────────────────

    test("TOTAL overload: every write is LOST, and every loss is on the record", async ({
      request,
      db,
    }) => {
      // ── THE INVERSION, IN ONE TEST ──────────────────────────────────
      // WAS: "every extraction fails and the analyzer takes the whole
      // batch", asserting pete/dan CONFIRMED, felix/greg DROPPED and
      // `handledBy === "llm"` on all four. Every one of those five
      // assertions has flipped, because the decider they named is
      // deleted. Nothing about the injection changed.
      const g = await createGroup(request, db, {
        attendance: [
          { key: "felix", status: "CONFIRMED" },
          { key: "greg", status: "CONFIRMED" },
        ],
      });
      const w = chaseWindow();

      const res = await g.postBatch(w.items, { extractorFailAll: true });

      // 1 — THE LOSS. Two players said they were in and are not in the
      // squad; one said he was out and is still down as playing.
      expect(await g.attendanceOf("pete"), "pete said IN and is not in the squad").toBeNull();
      expect(await g.attendanceOf("dan")).toBeNull();
      expect(
        await g.attendanceOf("felix"),
        "felix said he cannot make it and is still counted as playing",
      ).toMatchObject({ status: "CONFIRMED" });
      expect(await g.attendanceOf("greg")).toMatchObject({ status: "CONFIRMED" });

      // …and nothing cheerful is said about a write that did not happen.
      for (const r of res.results) expect(r.reply).toBeNull();

      // 2 + 3 — one row per message, one decider each, none the engine.
      const by = await oneRowPerMessage(db, g.orgId, w.items.map((i) => i.body));
      for (const b of w.owned) {
        expect(by[b], `"${b}" should have reached nobody`).toBe("ignored");
      }
      expect(Object.values(by)).not.toContain("attendance-engine");
      expect(res.results).toHaveLength(w.items.length);

      // 4 — the row says WHICH STAGE failed, so an extractor outage is
      // distinguishable from ordinary banter nobody owned. The two want
      // completely different responses from a human.
      const failed = await db.all<{ reasoning: string }>(
        `SELECT reasoning FROM "AnalyzedMessage" WHERE "orgId" = $1 AND body = 'im in lads'`,
        [g.orgId],
      );
      expect(failed[0].reasoning).toContain("no owner:");
      expect(failed[0].reasoning).toMatch(/extractor|degraded|failed|Overloaded/i);

      // …and the operator hears about it, once for the batch, on the
      // owner's /admin/health page (2026-09-28), never as a DM.
      const notes = await operatorNotes(db, g.orgId);
      expect(
        notes,
        "an unowned attendance message must raise the operator note: silence with no " +
          "signal is §9's signature failure and is the only thing making this loss survivable",
      ).toHaveLength(1);
      expect(notes[0].title).toContain("routed to an action but nothing handled");
      expect(res.dms.map((d) => d.text).join("\n")).not.toContain(
        "routed to an action but nothing handled",
      );

      // NO AttendanceEvent rows, because there were no transitions. This
      // used to assert four. It is the same assertion — one event per
      // transition — against a world where no transition happened.
      const ev = await db.all<{ n: string }>(
        `SELECT count(*)::text AS n FROM "AttendanceEvent" WHERE "matchId" = $1`,
        [g.matchId],
      );
      expect(Number(ev[0].n)).toBe(0);
    });

    test("PARTIAL overload: the engine keeps what it could extract, and loses the rest", async ({
      request,
      db,
    }) => {
      const g = await createGroup(request, db, {
        attendance: [
          { key: "felix", status: "CONFIRMED" },
          { key: "greg", status: "CONFIRMED" },
        ],
      });
      const w = chaseWindow();
      // Half the owned population fails — the shape of a real overload
      // window, where some calls get through and some do not.
      const failing = ["in for me too", "@Match Time take Greg out he is injured"];

      await g.postBatch(w.items, { extractorFail: failing });

      // What got through is written, exactly as if nothing had gone wrong.
      expect(await g.attendanceOf("pete")).toMatchObject({ status: "CONFIRMED" });
      expect(await g.attendanceOf("felix")).toMatchObject({ status: "DROPPED" });
      // What failed is lost, and only what failed.
      expect(await g.attendanceOf("dan"), "dan's IN failed and is lost").toBeNull();
      expect(await g.attendanceOf("greg"), "greg's drop failed and is lost").toMatchObject({
        status: "CONFIRMED",
      });

      const by = await oneRowPerMessage(db, g.orgId, w.items.map((i) => i.body));
      for (const b of failing) expect(by[b], `"${b}" reached nobody`).toBe("ignored");
      for (const b of w.owned.filter((x) => !failing.includes(x))) {
        expect(by[b], `"${b}" stayed with the engine`).toBe("attendance-engine");
      }

      // A partly-failed batch is exactly the state that could write a
      // squad place twice. Two transitions landed, so there are two
      // events — one per transition, never two per.
      const ev = await db.all<{ n: string }>(
        `SELECT count(*)::text AS n FROM "AttendanceEvent" WHERE "matchId" = $1`,
        [g.matchId],
      );
      expect(Number(ev[0].n)).toBe(2);
    });

    test("the failure lands on the ONE message carrying a write, in a batch of noise", async ({
      request,
      db,
    }) => {
      // The edge that decides how bad this is. Everything else in the
      // window is banter; the single message that moves a squad place is
      // the one the API cannot answer, so the batch looks entirely normal
      // and one player quietly loses their slot.
      const g = await createGroup(request, db, { attendance: [] });

      const res = await g.postBatch(
        [
          { player: "henry", body: "😂😂😂", route: "none" },
          { player: "ivan", body: "wembley was better", route: "none" },
          { player: "pete", body: "im in lads", route: "self_att", facts: selfIn() },
          { player: "jake", body: "anyone watching the derby", route: "none" },
        ],
        { extractorFail: ["im in lads"] },
      );

      expect(await g.attendanceOf("pete")).toBeNull();
      const by = await oneRowPerMessage(db, g.orgId, ["im in lads"]);
      expect(by["im in lads"]).toBe("ignored");
      // The banter around it raises NOTHING — `composeOperatorNote` drops
      // every `none` route — so the note that does fire is about the one
      // message that mattered, and is not buried in six lines of noise.
      const notes = await operatorNotes(db, g.orgId);
      expect(notes).toHaveLength(1);
      expect(notes[0].title).toContain("routed to an action but nothing handled");
      expect(notes[0].detail).toContain("im in lads");
      expect(notes[0].detail).not.toContain("wembley was better");
      expect(res.dms.map((d) => d.text).join("\n")).not.toContain("routed to an action");
    });

    test("a failure on a message the engine does NOT own changes nothing", async ({
      request,
      db,
    }) => {
      // The control. `none` never reaches an extractor at all, so an
      // overloaded API cannot make it worse, and the attendance message
      // beside it is still written.
      const g = await createGroup(request, db, { attendance: [] });

      await g.postBatch(
        [
          { player: "pete", body: "im in lads", route: "self_att", facts: selfIn() },
          { player: "jake", body: "😂😂😂", route: "none" },
        ],
        { extractorFail: ["😂😂😂"] },
      );

      expect(await g.attendanceOf("pete")).toMatchObject({ status: "CONFIRMED" });
      const by = await oneRowPerMessage(db, g.orgId, ["im in lads"]);
      expect(by["im in lads"]).toBe("attendance-engine");
    });

    // ── sustained, and measured ───────────────────────────────────────

    test("SUSTAINED overload across 10 windows: the measured LOSS rate", async ({
      request,
      db,
    }) => {
      // Ten consecutive analyze windows against one live world, with a
      // deterministic ~50% failure pattern that moves between messages
      // window to window.
      //
      // ⚠️ THE NUMBER THIS PRINTS INVERTED WITH §10 STEP 8. It was a
      // FALLBACK rate — how often the analyzer had to take over, with
      // every write still landing. It is now a LOSS rate: how many of the
      // ten players who said they were in are not in the squad. Five, on
      // this pattern. That figure is the argument for the retry or the
      // replay that does not exist yet, and it is printed rather than
      // merely asserted so a reader of the log sees it.
      const g = await createGroup(request, db, { attendance: [] });
      const joiners = ["pete", "dan", "felix", "greg", "henry", "ivan", "jake", "kyle", "liam", "mike"];

      let ownedTotal = 0;
      let lost = 0;
      let messagesTotal = 0;

      for (let round = 0; round < joiners.length; round++) {
        const who = joiners[round];
        const inBody = `im in lads ${round}`;
        const banter = `banter line ${round}`;
        const chat = `who is playing this week ${round}`;
        // Alternate which round loses its write-carrying message.
        const failThisRound = round % 2 === 0 ? [inBody] : [];

        await g.postBatch(
          [
            { player: who, body: inBody, route: "self_att", facts: selfIn() },
            { player: "quinn", body: banter, route: "none" },
            {
              player: "ryan",
              body: chat,
              route: "question",
              facts: { topic: "squad", personRef: null, statedCount: null },
            },
          ],
          { extractorFail: failThisRound },
        );

        messagesTotal += 3;
        ownedTotal += 1; // one engine-owned body per round
        if (failThisRound.length > 0) lost += 1;

        // 1 — the write lands only when the extractor answered.
        const row = await g.attendanceOf(who);
        if (failThisRound.length > 0) {
          expect(row, `round ${round}: ${who}'s IN should have been LOST`).toBeNull();
        } else {
          expect(row, `round ${round}: ${who} is not in the squad`).toMatchObject({
            status: "CONFIRMED",
          });
        }
      }

      const rate = (lost / ownedTotal) * 100;
      console.log(
        `[overload] sustained sweep: ${messagesTotal} messages · ${ownedTotal} engine-owned · ` +
          `${lost} registrations LOST (${rate.toFixed(1)}% loss rate) · ` +
          `${joiners.length - lost} of ${joiners.length} writes landed`,
      );
      expect(rate).toBe(50);

      // 2 — nothing silently dropped: every message has a row.
      const total = await db.all<{ n: string }>(
        `SELECT count(*)::text AS n FROM "AnalyzedMessage" WHERE "orgId" = $1`,
        [g.orgId],
      );
      expect(Number(total[0].n)).toBe(messagesTotal);

      // 3 — no message decided twice, and the split is exactly what the
      // injected failures say it should be.
      const split = await db.all<{ handledBy: string; n: string }>(
        `SELECT "handledBy", count(*)::text AS n FROM "AnalyzedMessage"
          WHERE "orgId" = $1 AND body LIKE 'im in lads %' GROUP BY "handledBy"`,
        [g.orgId],
      );
      const byDecider = Object.fromEntries(split.map((r) => [r.handledBy, Number(r.n)]));
      expect(byDecider["ignored"]).toBe(lost);
      expect(byDecider["attendance-engine"]).toBe(ownedTotal - lost);

      // …and one squad-place transition per SURVIVING joiner.
      const ev = await db.all<{ n: string }>(
        `SELECT count(*)::text AS n FROM "AttendanceEvent" WHERE "matchId" = $1`,
        [g.matchId],
      );
      expect(Number(ev[0].n)).toBe(joiners.length - lost);
      expect((await g.counts()).confirmed).toBe(joiners.length - lost);
    });
  },
);

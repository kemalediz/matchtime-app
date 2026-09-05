/**
 * THE FAIL-OPEN FALLBACK, UNDER PRODUCTION-SHAPED LOAD.
 *
 * §10 step 6 changes the SHAPE of the pipeline's exposure to a bad
 * minute at the API. The analyzer makes one call per BATCH and rides an
 * overload window out; the engine makes one per MESSAGE, fanned out in
 * parallel, and does not. PR #44's first live corpus sweep measured that
 * exactly: 27 `529 Overloaded` and 3 `500`s across 10 of 177 messages at
 * the SDK default of two retries, taking two corpus cases from 3/3 to
 * 0/3 without the engine ever deciding them wrongly.
 *
 * `maxRetries: 4` took that to zero — and that is the problem this file
 * exists for. **The fallback never fired in the corpus sweep**, because
 * the retry absorbed everything. It fired once in a replay run. It has
 * three unit tests and one e2e test, all of which stub a single throw.
 * For a flag about to be turned on for a real club, "the second line of
 * defence has never been exercised in anger" is not a state to ship in.
 *
 * So: sustained failure, across a realistic batch mix, through the REAL
 * analyze route and a REAL database, measuring the four things that
 * actually matter.
 *
 *   1. every attendance write still LANDS — by the other decider;
 *   2. nothing is silently DROPPED — one `AnalyzedMessage` row per
 *      message, always, whatever failed;
 *   3. no message is decided TWICE — one row, one decider, and one
 *      `AttendanceEvent` per squad-place transition;
 *   4. the degradation is LOUD — the batch reports the failure count,
 *      the rate, and the id of every message it handed back.
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
import {
  claim,
  clearExtractorStub,
  clearRouterStub,
  facts,
  setExtractorStub,
  setRouterStub,
  type ExtractorStub,
} from "../helpers/stub";

const LIVE = process.env.MT_SIM_LIVE_LLM === "1";

// Skipped under MT_SIM_LIVE_LLM=1 for the same reason as the rest of the
// step-6 specs: that flag pins both stub seams empty on purpose, so
// there is no way to inject a deterministic overload. A live sweep
// measures whether the model is right; this measures what happens when
// it cannot be reached at all, which is not a question money answers.
(LIVE ? test.describe.skip : test.describe)(
  "§10 step 6 — the fail-open fallback under load",
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
    function chaseWindow(): {
      items: BatchItem[];
      routes: Record<string, string>;
      factBodies: Record<string, Record<string, unknown>>;
      /** Bodies the ENGINE would own, i.e. the fallback's population. */
      owned: string[];
    } {
      const items: BatchItem[] = [
        { player: "pete", body: "im in lads", verdict: { intent: "in", registerAttendance: "IN", react: "✅" } },
        { player: "dan", body: "in for me too", verdict: { intent: "in", registerAttendance: "IN", react: "✅" } },
        { player: "felix", body: "sorry cant make it this week", verdict: { intent: "out", registerAttendance: "OUT", react: "👋" } },
        {
          player: "alice",
          body: "@Match Time take Greg out he is injured",
          tag: true,
          verdict: { intent: "out", registerFor: [{ name: "Greg Gale", action: "OUT" }] },
        },
        { player: "henry", body: "😂😂😂", verdict: { intent: "noise" } },
        { player: "ivan", body: "that was never a penalty", verdict: { intent: "noise" } },
        { player: "jake", body: "who is playing this week", verdict: { intent: "question" } },
      ];
      const routes: Record<string, string> = {
        "im in lads": "self_att",
        "in for me too": "self_att",
        "sorry cant make it this week": "self_att",
        "@Match Time take Greg out he is injured": "other_att",
        "😂😂😂": "none",
        "that was never a penalty": "none",
        "who is playing this week": "question",
      };
      const factBodies: Record<string, Record<string, unknown>> = {
        "im in lads": facts([claim()]),
        "in for me too": facts([claim()]),
        "sorry cant make it this week": facts([claim({ polarity: "out" })]),
        "@Match Time take Greg out he is injured": facts([
          claim({ subject: "other", personRef: "Greg", personNamed: true, polarity: "out" }),
        ]),
      };
      return {
        items,
        routes,
        factBodies,
        owned: [
          "im in lads",
          "in for me too",
          "sorry cant make it this week",
          "@Match Time take Greg out he is injured",
        ],
      };
    }

    function arm(routes: Record<string, string>, stub: ExtractorStub): void {
      setRouterStub({ enabled: false, floor: false, engine: true, bodies: routes });
      setExtractorStub(stub);
    }

    /** Every message that went in came out with exactly one row, and the
     *  row names exactly one decider. This is assertions 2 and 3. */
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

    test("TOTAL overload: every extraction fails and the analyzer takes the whole batch", async ({
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
      arm(w.routes, { bodies: w.factBodies, failAll: true });

      const res = await g.postBatch(w.items);

      // 1 — every write lands, by the other decider.
      expect(await g.attendanceOf("pete")).toMatchObject({ status: "CONFIRMED" });
      expect(await g.attendanceOf("dan")).toMatchObject({ status: "CONFIRMED" });
      expect(await g.attendanceOf("felix")).toMatchObject({ status: "DROPPED" });
      expect(await g.attendanceOf("greg")).toMatchObject({ status: "DROPPED" });

      // 2 + 3 — one row per message, one decider each, none the engine.
      const by = await oneRowPerMessage(db, g.orgId, w.items.map((i) => i.body));
      for (const b of w.owned) {
        expect(by[b], `"${b}" should have fallen back to the analyzer`).toBe("llm");
      }
      expect(Object.values(by)).not.toContain("attendance-engine");
      expect(res.results).toHaveLength(w.items.length);

      // 3 — one AttendanceEvent per transition, not two. If both
      // deciders had run, this is where it would show.
      const ev = await db.all<{ n: string }>(
        `SELECT count(*)::text AS n FROM "AttendanceEvent" e
           JOIN "Match" m ON m.id = e."matchId" WHERE m.id = $1`,
        [g.matchId],
      );
      expect(Number(ev[0].n)).toBe(4);
    });

    test("PARTIAL overload: the engine keeps what it could extract, the rest falls back", async ({
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
      arm(w.routes, { bodies: w.factBodies, fail: failing });

      await g.postBatch(w.items);

      expect(await g.attendanceOf("pete")).toMatchObject({ status: "CONFIRMED" });
      expect(await g.attendanceOf("dan")).toMatchObject({ status: "CONFIRMED" });
      expect(await g.attendanceOf("felix")).toMatchObject({ status: "DROPPED" });
      expect(await g.attendanceOf("greg")).toMatchObject({ status: "DROPPED" });

      const by = await oneRowPerMessage(db, g.orgId, w.items.map((i) => i.body));
      for (const b of failing) expect(by[b], `"${b}" fell back`).toBe("llm");
      for (const b of w.owned.filter((x) => !failing.includes(x))) {
        expect(by[b], `"${b}" stayed with the engine`).toBe("attendance-engine");
      }

      // Two deciders in one batch is exactly the state that could write
      // a squad place twice. One event per transition says it did not.
      const ev = await db.all<{ n: string }>(
        `SELECT count(*)::text AS n FROM "AttendanceEvent" WHERE "matchId" = $1`,
        [g.matchId],
      );
      expect(Number(ev[0].n)).toBe(4);
    });

    test("the failure lands on the ONE message carrying a write, in a batch of noise", async ({
      request,
      db,
    }) => {
      // The edge that decides whether the fallback is worth anything.
      // Everything else in the window is banter; the single message that
      // moves a squad place is the one the API cannot answer.
      const g = await createGroup(request, db, { attendance: [] });
      arm(
        {
          "😂😂😂": "none",
          "wembley was better": "none",
          "im in lads": "self_att",
          "anyone watching the derby": "none",
        },
        { bodies: { "im in lads": facts([claim()]) }, fail: ["im in lads"] },
      );

      await g.postBatch([
        { player: "henry", body: "😂😂😂", verdict: { intent: "noise" } },
        { player: "ivan", body: "wembley was better", verdict: { intent: "noise" } },
        {
          player: "pete",
          body: "im in lads",
          verdict: { intent: "in", registerAttendance: "IN", react: "✅" },
        },
        { player: "jake", body: "anyone watching the derby", verdict: { intent: "noise" } },
      ]);

      expect(await g.attendanceOf("pete")).toMatchObject({ status: "CONFIRMED" });
      const by = await oneRowPerMessage(db, g.orgId, ["im in lads"]);
      expect(by["im in lads"]).toBe("llm");
    });

    test("a failure on a message the engine does NOT own changes nothing", async ({
      request,
      db,
    }) => {
      // The control. `none` and `question` routes never reach an
      // extractor, so an overloaded API cannot make them worse, and the
      // engine must still keep the attendance message beside them.
      const g = await createGroup(request, db, { attendance: [] });
      arm(
        { "im in lads": "self_att", "who is playing this week": "question" },
        {
          bodies: { "im in lads": facts([claim()]) },
          fail: ["who is playing this week", "😂😂😂"],
        },
      );

      await g.postBatch([
        { player: "pete", body: "im in lads" },
        { player: "jake", body: "who is playing this week", verdict: { intent: "question" } },
      ]);

      expect(await g.attendanceOf("pete")).toMatchObject({ status: "CONFIRMED" });
      const by = await oneRowPerMessage(db, g.orgId, ["im in lads"]);
      expect(by["im in lads"]).toBe("attendance-engine");
    });

    // ── sustained, and measured ───────────────────────────────────────

    test("SUSTAINED overload across 10 windows: the measured fallback rate, and no loss", async ({
      request,
      db,
    }) => {
      // Ten consecutive analyze windows against one live world, with a
      // deterministic ~50% failure pattern that moves between messages
      // window to window — because a failure that always lands on the
      // same body would only ever test one code path.
      //
      // The assertion is not "it survived". It is: the engine's owned
      // population, the number handed back, and the number of writes are
      // all EXACTLY predictable, and every single message that entered
      // the route left it with a row and a decider.
      const g = await createGroup(request, db, { attendance: [] });
      const joiners = ["pete", "dan", "felix", "greg", "henry", "ivan", "jake", "kyle", "liam", "mike"];

      let ownedTotal = 0;
      let fellBack = 0;
      let messagesTotal = 0;

      for (let round = 0; round < joiners.length; round++) {
        const who = joiners[round];
        const inBody = `im in lads ${round}`;
        const banter = `banter line ${round}`;
        const chat = `who is playing this week ${round}`;
        // Alternate which of the two engine-owned bodies fails, so half
        // the rounds lose the write-carrying message and half do not.
        const failThisRound = round % 2 === 0 ? [inBody] : [];
        arm(
          { [inBody]: "self_att", [banter]: "none", [chat]: "question" },
          { bodies: { [inBody]: facts([claim()]) }, fail: failThisRound },
        );

        await g.postBatch([
          {
            player: who,
            body: inBody,
            verdict: { intent: "in", registerAttendance: "IN", react: "✅" },
          },
          { player: "quinn", body: banter, verdict: { intent: "noise" } },
          { player: "ryan", body: chat, verdict: { intent: "question" } },
        ]);

        messagesTotal += 3;
        ownedTotal += 1; // one engine-owned body per round
        if (failThisRound.length > 0) fellBack += 1;

        // 1 — the write lands every round, whichever decider took it.
        expect(await g.attendanceOf(who), `round ${round}: ${who} is not in the squad`).toMatchObject({
          status: "CONFIRMED",
        });
      }

      const rate = (fellBack / ownedTotal) * 100;
      console.log(
        `[overload] sustained sweep: ${messagesTotal} messages · ${ownedTotal} engine-owned · ` +
          `${fellBack} handed back to the analyzer (${rate.toFixed(1)}% fallback rate) · ` +
          `${joiners.length} of ${joiners.length} writes landed`,
      );
      expect(rate).toBe(50);

      // 2 — nothing silently dropped: every message has a row.
      const total = await db.all<{ n: string }>(
        `SELECT count(*)::text AS n FROM "AnalyzedMessage" WHERE "orgId" = $1`,
        [g.orgId],
      );
      expect(Number(total[0].n)).toBe(messagesTotal);

      // 3 — no message decided twice, and the deciders split exactly the
      // way the injected failures say they should.
      const split = await db.all<{ handledBy: string; n: string }>(
        `SELECT "handledBy", count(*)::text AS n FROM "AnalyzedMessage"
          WHERE "orgId" = $1 AND body LIKE 'im in lads %' GROUP BY "handledBy"`,
        [g.orgId],
      );
      const byDecider = Object.fromEntries(split.map((r) => [r.handledBy, Number(r.n)]));
      expect(byDecider["llm"]).toBe(fellBack);
      expect(byDecider["attendance-engine"]).toBe(ownedTotal - fellBack);

      // …and one squad-place transition per joiner, never two.
      const ev = await db.all<{ n: string }>(
        `SELECT count(*)::text AS n FROM "AttendanceEvent" WHERE "matchId" = $1`,
        [g.matchId],
      );
      expect(Number(ev[0].n)).toBe(joiners.length);
      expect((await g.counts()).confirmed).toBe(joiners.length);
    });
  },
);

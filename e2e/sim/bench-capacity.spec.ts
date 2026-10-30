/**
 * BENCH CAPACITY — a bench may not exist while the squad has room.
 *
 * Drives the REAL analyze pipeline (router + extractor stubbed, so this
 * is deterministic) and asserts the end state the 17:00 roster renders
 * from.
 *
 * The incident this pins (production, 2026-08-31): a 7-a-side match
 * (maxPlayers 14) sat at 10 confirmed with 4 open slots. A third-party
 * offer was misread as the sender's own standing offer, which classified
 * as registerAttendance:"BENCH", and the old write path benched them
 * without ever checking capacity. The roster then posted as
 * "Confirmed (10/14)" followed by "Bench (1): Amir" — the squad
 * contradicting its own header.
 *
 * The rule now: a BENCH row means the squad is FULL, or a human
 * EXPLICITLY asked for the bench. Never "the classifier inferred it".
 *
 * ── PORTED 2026-09-06, §10 STEP 8. THE CASE GOT STRONGER. ────────────
 *
 * It used to feed a verdict that had ALREADY made the wrong call —
 * `registerAttendance: "BENCH"` on a 10/14 squad — and assert that the
 * write path overrode it. There is no verdict any more, and there is no
 * override either: the extractor reports the two facts the text really
 * carries (`contingent: true`, `conditionOn: "squad"`) and
 * `pipeline/engine.ts` computes the status from capacity. So this file
 * no longer proves "a bad decision is corrected downstream"; it proves
 * the decision is made once, in the place that can see the squad. The
 * distinction the file exists for — INFERRED bench vs a human asking for
 * one — is now a field (`polarity: "bench"`) rather than an intent name,
 * which is exactly §9's "becomes a schema field".
 */
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import type { TestDb } from "../helpers/test-db";
import { createGroup } from "./group";
import { selfIn } from "../helpers/stub";

/** "I'll be the 14th if you're short" — a standing offer. Nobody said
 *  "bench"; the text says the commitment is conditional on the SQUAD
 *  being short. Whether that becomes a bench row is capacity's business.
 *  INFERRED. */
const STANDING_OFFER = {
  route: "offer",
  facts: selfIn({ contingent: true, conditionOn: "squad", tense: "future", confidence: 0.9 }),
};

/** "in but stick me on the bench" — the sender named the bench
 *  themselves, so `polarity` carries it. EXPLICIT. */
const EXPLICIT_BENCH = { route: "self_att", facts: selfIn({ polarity: "bench", benchAsked: true }) };

const TEN = ["owner", "alice", "brian", "pete", "dan", "felix", "greg", "henry", "ivan", "jake"];
const FOURTEEN = [...TEN, "kyle", "liam", "mike", "noah"];

const mkGroup = (
  request: APIRequestContext,
  db: TestDb,
  confirmedKeys: string[],
) =>
  createGroup(request, db, {
    maxPlayers: 14,
    attendance: confirmedKeys.map((key) => ({ key, status: "CONFIRMED" as const })),
  });

async function squadCounts(db: TestDb, matchId: string) {
  const rows = await db.all<{ status: string; n: string }>(
    `SELECT status, COUNT(*)::text AS n FROM "Attendance"
     WHERE "matchId" = $1 GROUP BY status`,
    [matchId],
  );
  const of = (s: string) => Number(rows.find((r) => r.status === s)?.n ?? 0);
  return { confirmed: of("CONFIRMED"), bench: of("BENCH") };
}

test.describe("a bench alongside open slots is impossible", () => {
  test.beforeEach(resetDb);

  test("the incident: standing offer on a 10/14 squad confirms, it does NOT bench", async ({
    request,
    db,
  }) => {
    const grp = (await mkGroup(request, db, TEN)).attach(request);

    const r = await grp.post("ryan", "I'll be the 14th if you're short", STANDING_OFFER);

    expect((await grp.attendanceOf("ryan"))?.status).toBe("CONFIRMED");
    expect(r.react).toBe("✅");

    // The state the roster renders from: 11/14 and an EMPTY bench.
    const counts = await squadCounts(db, grp.matchId!);
    expect(counts).toEqual({ confirmed: 11, bench: 0 });

    // And the bot must not announce a bench it didn't create. Nothing
    // upstream can say "bench" any more — the composer writes the reply
    // from the write the engine actually made — so this is now an
    // assertion about the composer rather than about a patcher.
    expect((r.reply ?? "").toLowerCase()).not.toContain("bench");
    // It used to end `expect(r.reply).toContain("11/14")`, because a
    // self IN posted the whole roster. Since 2026-09-09 it does not
    // (S36b — the tick is the acknowledgement), so Ryan gets his ✅ and
    // the group gets no post at all. The 🪑-that-never-happened is now
    // asserted as SILENCE rather than as a roster that says 11/14, which
    // is the stronger form of the same claim.
    expect(r.reply ?? "").toBe("");
    for (const t of r.groupPosts) expect(t.toLowerCase()).not.toContain("bench");
  });

  test("standing offer on a FULL squad still goes to the bench (unchanged)", async ({
    request,
    db,
  }) => {
    const grp = (await mkGroup(request, db, FOURTEEN)).attach(request);

    const r = await grp.post("ryan", "I'll be the 14th if you're short", STANDING_OFFER);

    expect((await grp.attendanceOf("ryan"))?.status).toBe("BENCH");
    expect(r.react).toBe("🪑");
    expect(await squadCounts(db, grp.matchId!)).toEqual({ confirmed: 14, bench: 1 });
  });

  test("an EXPLICIT bench request is still respected with slots open", async ({
    request,
    db,
  }) => {
    const grp = (await mkGroup(request, db, TEN)).attach(request);

    // "in but on bench" — the player named the bench themselves, so we do
    // not promote them into a slot they didn't ask for.
    const r = await grp.post("ryan", "in but stick me on the bench", EXPLICIT_BENCH);

    expect((await grp.attendanceOf("ryan"))?.status).toBe("BENCH");
    expect(r.react).toBe("🪑");
    expect(await squadCounts(db, grp.matchId!)).toEqual({ confirmed: 10, bench: 1 });
  });

  test("a standing offer from an ALREADY-CONFIRMED player never demotes them", async ({
    request,
    db,
  }) => {
    const grp = (await mkGroup(request, db, TEN)).attach(request);

    const r = await grp.post("jake", "happy to fill in if anyone drops", STANDING_OFFER);

    expect((await grp.attendanceOf("jake"))?.status).toBe("CONFIRMED");
    expect(await squadCounts(db, grp.matchId!)).toEqual({ confirmed: 10, bench: 0 });
    expect((r.reply ?? "").toLowerCase()).not.toContain("bench");
    // ── ONE ASSERTION CHANGED HERE, AND IT IS A MEASURED DIFFERENCE ──
    //
    // This used to require `react === "✅"`. It is now `null`, because
    // Jake was already CONFIRMED: no row moved, so the engine emits no
    // react. The old ✅ came from the verdict's own `react` field being
    // recomputed against the slot Jake already had — a reaction to a
    // write that did not happen.
    //
    // The load-bearing assertion is unchanged and is the one this test
    // is named for: the 🪑 must never appear, because a 🪑 on a
    // confirmed player is MatchTime announcing a demotion it did not
    // make. Whether a no-op self offer should still get a friendly tick
    // is a product question and is in the PR report, not smuggled in
    // here as an expectation.
    expect(r.react, "a bench emoji would announce a demotion that never happened").not.toBe("🪑");
  });
});

/**
 * BENCH CAPACITY — a bench may not exist while the squad has room.
 *
 * Drives the REAL analyze pipeline (LLM verdict stubbed, so this is
 * deterministic) and asserts the end state the 17:00 roster renders from.
 *
 * The incident this pins (production, 2026-08-31): a 7-a-side match
 * (maxPlayers 14) sat at 10 confirmed with 4 open slots. A third-party
 * offer was misread as the sender's own standing offer, which classifies
 * as registerAttendance:"BENCH", and the old write path benched them
 * without ever checking capacity. The roster then posted as
 * "Confirmed (10/14)" followed by "Bench (1): Amir" — the squad
 * contradicting its own header.
 *
 * The rule now: a BENCH row means the squad is FULL, or a human
 * EXPLICITLY asked for the bench. Never "the classifier inferred it".
 */
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import type { TestDb } from "../helpers/test-db";
import { createGroup } from "./group";
import type { StubVerdict } from "./group";

/** conditional_in flavour (a): "I'll be the 14th if you're short".
 *  Nobody said "bench" — the classifier decided it is one. INFERRED. */
const STANDING_OFFER: StubVerdict = {
  intent: "conditional_in",
  registerAttendance: "BENCH",
  react: "👍",
  reply: "Thanks Ryan, putting you on the bench. If we drop below 14, you're first up 🙏",
  confidence: 0.9,
  reasoning: "sim: standing-offer conditional → bench commitment",
};

/** intent "in" + BENCH: the sender asked for the bench in so many words.
 *  A human named it. EXPLICIT. */
const EXPLICIT_BENCH: StubVerdict = {
  intent: "in",
  registerAttendance: "BENCH",
  react: "👍",
  reply: "Bench: Ryan 🪑",
  confidence: 0.95,
  reasoning: "sim: explicit bench self-declaration",
};

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

    const r = await grp.post("ryan", "I'll be the 14th if you're short", {
      verdict: STANDING_OFFER,
    });

    expect((await grp.attendanceOf("ryan"))?.status).toBe("CONFIRMED");
    expect(r.react).toBe("✅");

    // The state the roster renders from: 11/14 and an EMPTY bench.
    const counts = await squadCounts(db, grp.matchId!);
    expect(counts).toEqual({ confirmed: 11, bench: 0 });

    // And the bot must not announce a bench it didn't create. The LLM's
    // reply said "putting you on the bench"; the server replaces it.
    expect((r.reply ?? "").toLowerCase()).not.toContain("bench");
    expect(r.reply).toContain("11/14");
  });

  test("standing offer on a FULL squad still goes to the bench (unchanged)", async ({
    request,
    db,
  }) => {
    const grp = (await mkGroup(request, db, FOURTEEN)).attach(request);

    const r = await grp.post("ryan", "I'll be the 14th if you're short", {
      verdict: STANDING_OFFER,
    });

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
    const r = await grp.post("ryan", "in but stick me on the bench", {
      verdict: EXPLICIT_BENCH,
    });

    expect((await grp.attendanceOf("ryan"))?.status).toBe("BENCH");
    expect(r.react).toBe("🪑");
    expect(await squadCounts(db, grp.matchId!)).toEqual({ confirmed: 10, bench: 1 });
  });

  test("a standing offer from an ALREADY-CONFIRMED player never demotes them", async ({
    request,
    db,
  }) => {
    const grp = (await mkGroup(request, db, TEN)).attach(request);

    const r = await grp.post("jake", "happy to fill in if anyone drops", {
      verdict: { ...STANDING_OFFER, reply: "Thanks Jake, putting you on the bench 🙏" },
    });

    expect((await grp.attendanceOf("jake"))?.status).toBe("CONFIRMED");
    expect(r.react).toBe("✅");
    expect(await squadCounts(db, grp.matchId!)).toEqual({ confirmed: 10, bench: 0 });
    expect((r.reply ?? "").toLowerCase()).not.toContain("bench");
  });
});

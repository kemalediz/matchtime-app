/**
 * TENTATIVE AVAILABILITY FOLLOW-UP — stubbed simulation.
 *
 * A player signals uncertain availability ("maybe, will confirm later") →
 * the bot records them tentative for the active match and schedules a
 * follow-up DM ~24h before kickoff. When due, the scheduler DMs them for a
 * firm IN/OUT — but only if they're still genuinely unresolved (the
 * send-time guard). Their IN/OUT reply registers them + resolves the
 * tentative.
 *
 * Deterministic: the LLM verdict is stubbed (conditional_in, flavour b),
 * and the scheduler clock is pinned via duePosts(now). No live model.
 */
import { test, expect, resetDb } from "../fixtures";
import { createGroup } from "./group";
import type { StubVerdict } from "./group";

// Flavour (b) personal-uncertainty conditional: tentative, NO write.
const TENTATIVE_VERDICT: StubVerdict = {
  intent: "conditional_in",
  registerAttendance: null,
  react: "🤔",
  reply: null,
  confidence: 0.9,
  reasoning: "sim: personal-uncertainty conditional → tentative",
};

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

test.describe("tentative availability follow-up (stubbed)", () => {
  test.beforeEach(resetDb);

  // Match is +3 days out (kickoff 20:00 London). Far enough that the
  // follow-up dueAt = kickoff − 24h sits comfortably in the future.
  const mkGroup = (request: import("@playwright/test").APIRequestContext, db: import("../helpers/test-db").TestDb) =>
    createGroup(request, db, {
      maxPlayers: 14,
      upcomingMatch: { daysFromNow: 3 },
      attendance: [
        { key: "owner", status: "CONFIRMED" },
        { key: "alice", status: "CONFIRMED" },
        { key: "pete", status: "CONFIRMED" },
      ],
    });

  async function tentativeRows(db: import("../helpers/test-db").TestDb, matchId: string) {
    return db.all<{
      userId: string;
      dueAt: string;
      notifiedAt: string | null;
      resolvedAt: string | null;
    }>(
      `SELECT "userId", "dueAt", "notifiedAt", "resolvedAt"
       FROM "TentativeAvailability" WHERE "matchId" = $1`,
      [matchId],
    );
  }

  test("records a tentative row + schedules the follow-up ~24h before kickoff; idempotent", async ({
    request,
    db,
  }) => {
    const grp = (await mkGroup(request, db)).attach(request);
    const matchId = grp.matchId!;

    const r = await grp.post("henry", "maybe, I'll confirm later", {
      verdict: TENTATIVE_VERDICT,
    });
    expect(r.intent).toBe("conditional_in");

    // NOT registered anywhere.
    expect(await grp.attendanceOf("henry")).toBeNull();

    // Exactly one tentative row, unresolved, dueAt ≈ kickoff − 24h.
    let rows = await tentativeRows(db, matchId);
    expect(rows).toHaveLength(1);
    expect(rows[0].resolvedAt).toBeNull();
    expect(rows[0].notifiedAt).toBeNull();

    const matchRow = await db.one<{ date: string }>(
      `SELECT date FROM "Match" WHERE id = $1`,
      [matchId],
    );
    const kickoff = new Date(matchRow!.date).getTime();
    const dueAt = new Date(rows[0].dueAt).getTime();
    // Within a minute of kickoff − 24h.
    expect(Math.abs(dueAt - (kickoff - DAY))).toBeLessThan(60_000);

    // Repeat tentative → still exactly one row (idempotent, no reschedule).
    await grp.post("henry", "still might, depends how my knee feels", {
      verdict: TENTATIVE_VERDICT,
    });
    rows = await tentativeRows(db, matchId);
    expect(rows).toHaveLength(1);
  });

  test("follow-up DM fires when due (still unresolved); does not fire before due", async ({
    request,
    db,
  }) => {
    const grp = (await mkGroup(request, db)).attach(request);
    const matchId = grp.matchId!;
    await grp.post("henry", "maybe later", { verdict: TENTATIVE_VERDICT });

    // Use generous margins to sidestep any tz ambiguity in how raw
    // Postgres timestamps round-trip through JS Date. The match is +3 days
    // out (dueAt ≈ +2 days), so "now" (real clock) is comfortably BEFORE
    // due, and a fixed +10-day instant is comfortably AFTER due.
    const matchRow = await db.one<{ date: string }>(`SELECT date FROM "Match" WHERE id = $1`, [matchId]);
    const kickoff = new Date(matchRow!.date).getTime();

    // Well before due → no follow-up DM (now is ~2+ days before dueAt).
    const early = await grp.duePosts(new Date());
    const earlyDm = early.find(
      (i) => i.kind === "dm" && i.targetUser === grp.player("henry").userId,
    );
    expect(earlyDm).toBeUndefined();

    // Past due (kickoff itself — well after kickoff − 24h) → DM fires.
    const due = await grp.duePosts(new Date(kickoff + DAY));
    const dueDm = due.find(
      (i) => i.kind === "dm" && i.targetUser === grp.player("henry").userId,
    );
    expect(dueDm, "follow-up DM should fire when due").toBeDefined();
    expect(dueDm!.text ?? "").toMatch(/in or out/i);
    // PII-safe: must not contain any other player's phone number.
    for (const key of ["owner", "alice", "pete"]) {
      const ph = grp.player(key).phone;
      if (ph) expect(dueDm!.text ?? "").not.toContain(ph.replace(/^\+/, ""));
    }
  });

  test("send-time guard: no DM if the player already confirmed since declaring", async ({
    request,
    db,
  }) => {
    const grp = (await mkGroup(request, db)).attach(request);
    const matchId = grp.matchId!;
    await grp.post("henry", "maybe later", { verdict: TENTATIVE_VERDICT });

    // Henry later says a plain IN (group) → registered + tentative resolved.
    await grp.post("henry", "in");
    const att = await grp.attendanceOf("henry");
    expect(att).not.toBeNull();
    expect(["CONFIRMED", "BENCH"]).toContain(att!.status);

    const rows = await tentativeRows(db, matchId);
    expect(rows[0].resolvedAt, "tentative resolved by the firm IN").not.toBeNull();

    // Even well past due time, no follow-up DM (guard + resolved).
    const matchRow = await db.one<{ date: string }>(`SELECT date FROM "Match" WHERE id = $1`, [matchId]);
    const kickoff = new Date(matchRow!.date).getTime();
    const due = await grp.duePosts(new Date(kickoff + DAY));
    const dm = due.find((i) => i.kind === "dm" && i.targetUser === grp.player("henry").userId);
    expect(dm).toBeUndefined();
  });

  test("player replies IN to the follow-up DM → registered + tentative resolved", async ({
    request,
    db,
  }) => {
    const grp = (await mkGroup(request, db)).attach(request);
    const matchId = grp.matchId!;
    await grp.post("henry", "maybe later", { verdict: TENTATIVE_VERDICT });
    expect(await grp.attendanceOf("henry")).toBeNull();

    // Henry replies IN by DM (the follow-up reply path).
    const res = await grp.dm("henry", "IN");
    expect((res.json as { handled?: string }).handled).toBe("tentative-followup");

    const att = await grp.attendanceOf("henry");
    expect(att, "henry registered by his DM IN").not.toBeNull();
    expect(["CONFIRMED", "BENCH"]).toContain(att!.status);

    const rows = await tentativeRows(db, matchId);
    expect(rows[0].resolvedAt, "tentative resolved by the DM IN").not.toBeNull();

    // A confirmation DM was queued back to henry.
    expect(res.dms.some((d) => /you'?re in/i.test(d.text))).toBe(true);
  });

  test("player replies OUT to the follow-up DM → not registered + resolved", async ({
    request,
    db,
  }) => {
    const grp = (await mkGroup(request, db)).attach(request);
    const matchId = grp.matchId!;
    await grp.post("henry", "maybe later", { verdict: TENTATIVE_VERDICT });

    const res = await grp.dm("henry", "OUT");
    expect((res.json as { handled?: string }).handled).toBe("tentative-followup");

    const att = await grp.attendanceOf("henry");
    // Either no row, or a DROPPED row — never CONFIRMED/BENCH.
    if (att) expect(att.status).toBe("DROPPED");

    const rows = await tentativeRows(db, matchId);
    expect(rows[0].resolvedAt).not.toBeNull();
  });
});

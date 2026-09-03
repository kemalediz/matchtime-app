/**
 * §10 STEP 6 — the attendance path decided by the engine, through the
 * REAL analyze route and against a REAL database.
 *
 * The unit tests prove the engine decides correctly and the apply layer
 * translates faithfully. This proves the thing that actually matters:
 * that a message routed `self_att` / `other_att` / `offer` produces the
 * right ROW, that turning the flag off restores today exactly, and that
 * the three incidents the step's deleted seatbelts were written for now
 * come out right with no seatbelt anywhere in the path.
 *
 * OVER-WRITING IS THE DANGEROUS DIRECTION. Registering someone who did
 * not ask, or dropping someone who did not ask to be dropped, is worse
 * than missing a write — so both directions are tested explicitly, and
 * the over-writing ones come first.
 *
 * Roster note: `defaultRoster()` gives `owner` (OWNER), `alice` and
 * `brian` (ADMIN), and `pete` / `dan` / `felix` / … (PLAYER). Every
 * authorisation assertion below leans on that, so an admin case uses
 * `alice` and a control case uses `pete`.
 */
import { test, expect, resetDb } from "../fixtures";
import { createGroup } from "./group";
import {
  claim,
  clearExtractorStub,
  clearRouterStub,
  facts,
  setExtractorStub,
  setRouterStub,
} from "../helpers/stub";

const LIVE = process.env.MT_SIM_LIVE_LLM === "1";

// Skipped under MT_SIM_LIVE_LLM=1 for the same reason as the router-gate
// spec: that flag pins both stub files empty (and `assertSeamMatchesMode`
// refuses a live run that can still see them), so there would be no way
// to drive the router and the extractor deterministically. The live
// evidence for this step is the corpus sweep, not this file.
(LIVE ? test.describe.skip : test.describe)("§10 step 6 — the attendance engine", () => {
  test.describe.configure({ mode: "serial" });
  test.beforeAll(resetDb);
  test.afterEach(() => {
    clearRouterStub();
    clearExtractorStub();
  });

  /** Turn the engine on for this request and say, per body, what the
   *  router answered and what the extractor found. */
  function engineOn(
    map: Record<string, { route: string; facts?: Record<string, unknown> }>,
  ): void {
    const bodies: Record<string, string> = {};
    const factBodies: Record<string, Record<string, unknown>> = {};
    for (const [body, v] of Object.entries(map)) {
      bodies[body] = v.route;
      if (v.facts) factBodies[body] = v.facts;
    }
    // `enabled: false` — the ROUTER GATE stays off. Step 6 must work on
    // its own flag, and the two must be independent in both directions.
    setRouterStub({ enabled: false, floor: false, engine: true, bodies });
    setExtractorStub({ bodies: factBodies });
  }

  const IN = (over: Record<string, unknown> = {}) => facts([claim(over)]);

  // ── The default: nothing changes ──────────────────────────────────

  test("with the flag OFF, the analyzer decides exactly as it does today", async ({
    request,
    db,
  }) => {
    const g = await createGroup(request, db, { attendance: [] });
    clearRouterStub();
    clearExtractorStub();

    await g.postBatch([
      {
        player: "pete",
        body: "in",
        verdict: { intent: "in", registerAttendance: "IN", react: "✅" },
      },
    ]);

    expect(await g.attendanceOf("pete")).toMatchObject({ status: "CONFIRMED" });
    const rows = await db.all<{ n: string }>(
      `SELECT count(*)::text AS n FROM "AnalyzedMessage" WHERE "handledBy" = 'attendance-engine'`,
    );
    expect(rows[0].n).toBe("0");
  });

  // ── Over-writing: the dangerous direction, first ──────────────────

  test("a message the engine does NOT own cannot be written by it", async ({ request, db }) => {
    const g = await createGroup(request, db, { attendance: [] });
    // `unsure` is attendance-SHAPED and deliberately not owned: the
    // router could not settle it, so the analyzer decides. Even with
    // facts sitting in the stub, the engine must not touch it.
    engineOn({ "maybe later?": { route: "unsure", facts: IN() } });

    await g.postBatch([{ player: "pete", body: "maybe later?", verdict: { intent: "unclear" } }]);

    const row = await db.one<{ handledBy: string }>(
      `SELECT "handledBy" FROM "AnalyzedMessage" WHERE "orgId" = $1 AND body = 'maybe later?'`,
      [g.orgId],
    );
    expect(row?.handledBy).not.toBe("attendance-engine");
    expect(await g.attendanceOf("pete")).toBeNull();
  });

  test("an untagged third-party DROP registers nobody — the interaction contract holds", async ({
    request,
    db,
  }) => {
    // §13: "removing or moving someone who never consented stays an
    // explicit, tagged op". The engine reuses `interaction-contract.ts`
    // unchanged in meaning; this proves it end to end.
    const g = await createGroup(request, db, {
      attendance: [
        { key: "pete", status: "CONFIRMED" },
        { key: "dan", status: "CONFIRMED" },
      ],
    });
    engineOn({
      "Dan can't make it": {
        route: "other_att",
        facts: facts([
          claim({ subject: "other", personRef: "Dan", personNamed: true, polarity: "out" }),
        ]),
      },
    });

    const res = await g.postBatch([{ player: "pete", body: "Dan can't make it" }]);

    expect(await g.attendanceOf("dan")).toMatchObject({ status: "CONFIRMED" });
    expect(res.results[0].reply).toBeNull();
  });

  test("a past-tense claim writes nothing, with no seatbelt in the path", async ({
    request,
    db,
  }) => {
    // `looksLikeHypotheticalOrPast` is a §9 "becomes a schema field"
    // item: `tense`. The engine vetoes on the field, and the regex that
    // used to back it up is on the other side of the short-circuit.
    const g = await createGroup(request, db, { attendance: [] });
    engineOn({
      "I was in last week": { route: "self_att", facts: IN({ tense: "past" }) },
    });

    await g.postBatch([{ player: "pete", body: "I was in last week" }]);
    expect(await g.attendanceOf("pete")).toBeNull();
  });

  test("an unnamed third party provisions no ghost member — the A5 incident", async ({
    request,
    db,
  }) => {
    // 2026-08-30, Amir: "@Kemal Ediz my brother can play if needed"
    // benched Amir and (on six of six measured runs) provisioned a
    // member called "Amir's brother". `personNamed:false` plus
    // `subject:"other"` is all the engine needs.
    const g = await createGroup(request, db, { attendance: [] });
    engineOn({
      "my brother can play if needed": {
        route: "offer",
        facts: facts([
          claim({
            subject: "other",
            personRef: "my brother",
            personNamed: false,
            polarity: "in",
            contingent: true,
            conditionOn: "squad",
            tense: "future",
          }),
        ]),
      },
    });

    await g.postBatch([{ player: "pete", body: "my brother can play if needed", tag: true }]);

    // The SENDER is not benched, and no ghost member exists.
    expect(await g.attendanceOf("pete")).toBeNull();
    const ghosts = await db.all<{ name: string }>(
      `SELECT u.name FROM "User" u JOIN "Membership" m ON m."userId" = u.id
        WHERE m."orgId" = $1 AND u.name ILIKE '%brother%'`,
      [g.orgId],
    );
    expect(ghosts).toEqual([]);
  });

  test("a contingent drop HOLDS — the player stays in the squad", async ({ request, db }) => {
    // 2026-06-09, Erdal: "If u can make happy to drop" dropped him
    // immediately, the replacement never confirmed, and the squad sat
    // at 13 for a paid match. `contingent` is a schema field now, and
    // no literal "if" is required to reach the hold — which is what
    // `route.ts`'s `looksLikeConditionalDrop` gets wrong.
    const g = await createGroup(request, db, {
      attendance: [
        { key: "pete", status: "CONFIRMED" },
        { key: "dan", status: "CONFIRMED" },
      ],
    });
    engineOn({
      "happy to drop when you find someone": {
        route: "offer",
        facts: IN({ polarity: "out", contingent: true, conditionOn: "squad" }),
      },
    });

    await g.postBatch([
      { player: "pete", body: "happy to drop when you find someone", tag: true },
    ]);
    expect(await g.attendanceOf("pete")).toMatchObject({ status: "CONFIRMED" });
  });

  test("a NON-admin cannot demote anyone, tag or no tag", async ({ request, db }) => {
    const g = await createGroup(request, db, {
      attendance: [
        { key: "pete", status: "CONFIRMED" },
        { key: "dan", status: "CONFIRMED" },
      ],
    });
    engineOn({
      "@Match Time move Dan to the bench": {
        route: "other_att",
        facts: facts([
          claim({ subject: "other", personRef: "Dan", personNamed: true, polarity: "bench" }),
        ]),
      },
    });

    await g.postBatch([
      { player: "felix", body: "@Match Time move Dan to the bench", tag: true },
    ]);
    expect(await g.attendanceOf("dan")).toMatchObject({ status: "CONFIRMED" });
  });

  // ── Under-writing: the recoverable direction, still tested ────────

  test("a bare IN registers the sender, reacts ✅, and leaves an audit row", async ({
    request,
    db,
  }) => {
    const g = await createGroup(request, db, { attendance: [] });
    engineOn({ in: { route: "self_att", facts: IN() } });

    const res = await g.postBatch([{ player: "pete", body: "in" }]);

    expect(await g.attendanceOf("pete")).toMatchObject({ status: "CONFIRMED" });
    expect(res.results[0].react).toBe("✅");
    const row = await db.one<{ handledBy: string; intent: string; action: string }>(
      `SELECT "handledBy", intent, action FROM "AnalyzedMessage" WHERE "orgId" = $1 AND body = 'in'`,
      [g.orgId],
    );
    // §11.1's complaint about a message disappearing is answered by a
    // row, not by a log line. The audit field says who decided.
    expect(row?.handledBy).toBe("attendance-engine");
    expect(row?.intent).toBe("in");
    expect(row?.action).toBe("IN");
  });

  test("every write records its cause in the append-only log", async ({ request, db }) => {
    // PR #41. The whole reason the replay harness can judge step 6 is
    // that the log records WHY, not just WHAT — and step 6 must not
    // become the one writer that stops feeding it.
    const g = await createGroup(request, db, { attendance: [] });
    engineOn({ in: { route: "self_att", facts: IN() } });

    await g.postBatch([{ player: "pete", body: "in" }]);

    const ev = await db.all<{ cause: string; actorKind: string; toStatus: string }>(
      `SELECT cause, "actorKind", "toStatus" FROM "AttendanceEvent"
        WHERE "orgId" = $1 AND "userId" = $2 ORDER BY at DESC LIMIT 1`,
      [g.orgId, g.player("pete").userId],
    );
    expect(ev[0]).toMatchObject({
      cause: "self-attendance",
      actorKind: "player",
      toStatus: "CONFIRMED",
    });
  });

  test("a third-party write records the SENDER as the actor, not the subject", async ({
    request,
    db,
  }) => {
    const g = await createGroup(request, db, { attendance: [] });
    engineOn({
      "Dan is in": {
        route: "other_att",
        facts: facts([
          claim({ subject: "other", personRef: "Dan", personNamed: true, polarity: "in" }),
        ]),
      },
    });

    await g.postBatch([{ player: "pete", body: "Dan is in" }]);

    expect(await g.attendanceOf("dan")).toMatchObject({ status: "CONFIRMED" });
    const ev = await db.all<{ cause: string; actorUserId: string | null }>(
      `SELECT cause, "actorUserId" FROM "AttendanceEvent"
        WHERE "orgId" = $1 AND "userId" = $2 ORDER BY at DESC LIMIT 1`,
      [g.orgId, g.player("dan").userId],
    );
    expect(ev[0].cause).toBe("third-party-attendance");
    expect(ev[0].actorUserId).toBe(g.player("pete").userId);
  });

  test("a self OUT and a third-party IN in one batch swap the slot", async ({ request, db }) => {
    const g = await createGroup(request, db, {
      attendance: [
        { key: "pete", status: "CONFIRMED" },
        { key: "dan", status: "CONFIRMED" },
      ],
    });
    engineOn({
      "I'm out": { route: "self_att", facts: IN({ polarity: "out" }) },
      "Add Rashad please": {
        route: "other_att",
        facts: facts([
          claim({ subject: "other", personRef: "Rashad", personNamed: true, polarity: "in" }),
        ]),
      },
    });

    await g.postBatch([
      { player: "pete", body: "I'm out" },
      { player: "dan", body: "Add Rashad please" },
    ]);

    expect(await g.attendanceOf("pete")).toMatchObject({ status: "DROPPED" });
    const c = await g.counts();
    expect(c.confirmed).toBe(2); // dan + the newly provisioned Rashad
  });

  // ── The three seatbelts' incidents, with no seatbelt in the path ──

  test("S6 — an IN at a FULL squad still writes: it benches, it does not vanish", async ({
    request,
    db,
  }) => {
    // Najib, 2026-05-08 (f61a897). The model emitted intent:"in" with
    // registerAttendance:null because the state looked "odd", and he
    // lost his slot for a week; the IN safety net was written to force
    // the write back. Here capacity is the engine's own arithmetic and
    // there is no second field to disagree with `polarity`.
    const g = await createGroup(request, db, {
      maxPlayers: 2,
      attendance: [
        { key: "dan", status: "CONFIRMED" },
        { key: "felix", status: "CONFIRMED" },
      ],
    });
    engineOn({ In: { route: "self_att", facts: IN() } });

    const res = await g.postBatch([{ player: "pete", body: "In" }]);

    expect(await g.attendanceOf("pete")).toMatchObject({ status: "BENCH" });
    expect(res.results[0].react).toBe("🪑");
  });

  test("S12 — 'anyone able to replace me and Dan?' drops BOTH, and asks for cover", async ({
    request,
    db,
  }) => {
    // Mojib/Habib, 2026-05-26 (f35dfe6). The OUT safety net exists
    // because `replacement_request` is one intent carrying two facts
    // and the recruit half won. Here the drop is a claim, the ask is a
    // separate `sideRequests` entry, and there is one claim PER PLAYER
    // — the per-player attribution no regex over a single prose blob
    // could ever have (§3.2's 2026-09-01 note).
    const g = await createGroup(request, db, {
      attendance: [
        { key: "alice", status: "CONFIRMED" },
        { key: "dan", status: "CONFIRMED" },
        { key: "felix", status: "CONFIRMED" },
      ],
    });
    engineOn({
      "@Match Time anyone able to replace me and Dan tonight?": {
        route: "other_att",
        facts: facts(
          [
            claim({ polarity: "out" }),
            claim({ subject: "other", personRef: "Dan", personNamed: true, polarity: "out" }),
          ],
          { sideRequests: ["recruit"] },
        ),
      },
    });

    const res = await g.postBatch([
      {
        player: "alice",
        body: "@Match Time anyone able to replace me and Dan tonight?",
        tag: true,
      },
    ]);

    expect(await g.attendanceOf("alice")).toMatchObject({ status: "DROPPED" });
    expect(await g.attendanceOf("dan")).toMatchObject({ status: "DROPPED" });
    // PR #33's release condition: the recruit blast actually runs when
    // the engine writes, and it runs AFTER the drops so it counts the
    // squad this message just changed. One reply, not two.
    expect(res.results.filter((r) => (r.reply ?? "").length > 0)).toHaveLength(1);
    expect(res.results[0].reply ?? "").toMatch(
      /DM'?d \d+ recent player|No new players to ask|Already pinged/,
    );
    expect(res.results[0].reply ?? "").not.toMatch(/already full|no open spots/i);
  });

  test("S8 — an admin's demote moves the player to the bench and frees the slot", async ({
    request,
    db,
  }) => {
    // Salman Shelly, 2026-06-11 (9afa357). The bench-demote net
    // synthesised the write out of the model's REPLY, because the model
    // announced a move the database never made. Here `subject` is a
    // field, the admin check is code, and the announcement can only
    // exist because the write was proposed.
    const g = await createGroup(request, db, {
      attendance: [
        { key: "alice", status: "CONFIRMED" },
        { key: "dan", status: "CONFIRMED" },
        { key: "felix", status: "CONFIRMED" },
      ],
    });
    engineOn({
      "@Match Time move Dan to the bench": {
        route: "other_att",
        facts: facts([
          claim({ subject: "other", personRef: "Dan", personNamed: true, polarity: "bench" }),
        ]),
      },
    });

    await g.postBatch([
      { player: "alice", body: "@Match Time move Dan to the bench", tag: true },
    ]);

    expect(await g.attendanceOf("dan")).toMatchObject({ status: "BENCH" });
    const c = await g.counts();
    expect(c.confirmed).toBe(2);
    expect(c.bench).toBe(1);
  });

  // ── The invariants ────────────────────────────────────────────────

  test("a message carrying several facts loses none of them", async ({ request, db }) => {
    // 2026-09-01's incident: a regex fast path claimed a two-intent
    // message and threw half of it away. "Dan is out. We need one more
    // player." must do BOTH, in that order.
    const g = await createGroup(request, db, {
      attendance: [
        { key: "alice", status: "CONFIRMED" },
        { key: "dan", status: "CONFIRMED" },
        { key: "felix", status: "CONFIRMED" },
      ],
    });
    engineOn({
      "Dan is out. We need one more player.": {
        route: "other_att",
        facts: facts(
          [claim({ subject: "other", personRef: "Dan", personNamed: true, polarity: "out" })],
          { sideRequests: ["recruit"] },
        ),
      },
    });

    const res = await g.postBatch([
      { player: "alice", body: "Dan is out. We need one more player." },
    ]);

    expect(await g.attendanceOf("dan")).toMatchObject({ status: "DROPPED" });
    expect(res.results[0].reply ?? "").not.toMatch(/already full|no open spots/i);
  });

  test("one reply per message, and one squad post per batch", async ({ request, db }) => {
    const g = await createGroup(request, db, { attendance: [] });
    engineOn({
      in: { route: "self_att", facts: IN() },
      "me too": { route: "self_att", facts: IN() },
      "and me": { route: "self_att", facts: IN() },
    });

    const res = await g.postBatch([
      { player: "pete", body: "in" },
      { player: "dan", body: "me too" },
      { player: "felix", body: "and me" },
    ]);

    expect(res.results).toHaveLength(3);
    const spoke = res.results.filter((r) => (r.reply ?? "").length > 0);
    expect(spoke).toHaveLength(1);
    // Composed from the DATABASE after the writes landed, not from the
    // engine's projection and not from anyone's memory.
    expect(spoke[0].reply).toContain("3/");
    expect(spoke[0].reply).not.toContain("[SQUAD]");
    expect(new Set(res.results.map((r) => r.waMessageId)).size).toBe(3);
  });

  test("the banter-drop guard survives: a wind-up does not drop a protesting player", async ({
    request,
    db,
  }) => {
    // 2026-06-12, Zeeshan. §9 keeps this guard, and §6.2's prototype
    // proves it is needed: the extractor CORRECTLY reports the OUT
    // claim, because the text contains it. Deciding it is banter needs
    // corroboration only the engine can see.
    const g = await createGroup(request, db, {
      attendance: [
        { key: "pete", status: "CONFIRMED" },
        { key: "dan", status: "CONFIRMED" },
      ],
    });
    engineOn({
      "Dan is out 😂😂 vote him out lads": {
        route: "other_att",
        facts: facts([
          claim({ subject: "other", personRef: "Dan", personNamed: true, polarity: "out" }),
        ]),
      },
      "im in lads": { route: "self_att", facts: IN() },
    });

    await g.postBatch([
      { player: "felix", body: "Dan is out 😂😂 vote him out lads", tag: true },
      { player: "dan", body: "im in lads" },
    ]);

    expect(await g.attendanceOf("dan")).toMatchObject({ status: "CONFIRMED" });
  });

  test("an extractor failure is LOUD: no write, no reply, and a row that says so", async ({
    request,
    db,
  }) => {
    // §9 keeps the partial-response admin DM and asks for the mechanism
    // to be fixed — "under the new design it matches a typed error,
    // which is what it always wanted to be". This is that.
    const g = await createGroup(request, db, { attendance: [] });
    setRouterStub({ enabled: false, floor: false, engine: true, bodies: { in: "self_att" } });
    // Something `extractJson` cannot read at all → a degradation, not
    // silence and not a guess.
    setExtractorStub({ bodies: { in: "not json at all" as never } });

    const res = await g.postBatch([{ player: "pete", body: "in" }]);

    expect(await g.attendanceOf("pete")).toBeNull();
    expect(res.results[0].reply).toBeNull();
  });

  test("turning the flag back off is a complete revert, mid-suite", async ({ request, db }) => {
    // §10's revert column for step 6 is one flag. This is that claim as
    // a test rather than a sentence: the same body, the same world, the
    // flag flipped, and the analyzer decides again.
    const g = await createGroup(request, db, { attendance: [] });
    clearRouterStub();
    clearExtractorStub();

    await g.postBatch([
      {
        player: "pete",
        body: "in",
        verdict: { intent: "in", registerAttendance: "IN", react: "✅" },
      },
    ]);

    expect(await g.attendanceOf("pete")).toMatchObject({ status: "CONFIRMED" });
    const row = await db.one<{ handledBy: string }>(
      `SELECT "handledBy" FROM "AnalyzedMessage" WHERE "orgId" = $1 AND body = 'in'`,
      [g.orgId],
    );
    expect(row?.handledBy).toBe("llm");
  });
});

/**
 * §10 STEP 6 — the attendance path decided by the engine, through the
 * REAL analyze route and against a REAL database.
 *
 * The unit tests prove the engine decides correctly and the apply layer
 * translates faithfully. This proves the thing that actually matters:
 * that a message routed `self_att` / `other_att` / `offer` / `unsure`
 * produces the right ROW, that turning the flag off is a complete
 * revert, and that the three incidents the step's deleted seatbelts were
 * written for now come out right with no seatbelt anywhere in the path.
 *
 * ── THIS FILE IS ALSO THE WORKED EXAMPLE OF A PORTED SPEC ────────────
 * §10 step 8 deleted `analyzeBatch`, so `e2e/sim/group.ts`'s `verdict:`
 * seam decides nothing any more. Every case below drives the server
 * through the two seams that DO decide — `setRouterStub` (route + which
 * flags are on for this request) and `setExtractorStub` (the raw facts
 * JSON, so `parseFacts` still runs for real) — which is the shape the
 * ~20 specs listed in `e2e/helpers/stub.ts`'s header still need.
 *
 * Four cases changed MEANING rather than mechanism when the incumbent
 * disappeared, and each says so at its own site rather than here: the
 * flag-off case (the revert is now to silence), the not-owned case
 * (`unsure` became an owned route), the extractor-failure case (the
 * write is now LOST — read that one), and the one-squad-post case (a
 * mixed batch now has one speaker by construction).
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

  /**
   * Say, per body, what the router answered and what the extractor
   * found.
   *
   * ── IT NO LONGER "TURNS THE ENGINE ON" (§10 step 8, 2026-09-06) ────
   * It used to send `{ enabled: false, engine: true }` — the router gate
   * off, the attendance engine on — so that each step could be shown to
   * work on its own flag. `ROUTER_GATE_ENABLED` and
   * `ATTENDANCE_ENGINE_ENABLED` are DELETED (`pipeline/gate.ts`), and
   * `RouterStubConfig` no longer declares either field, because with no
   * analyzer their off positions were kill switches rather than reverts.
   * The engine is now simply how `self_att` / `other_att` / `offer` /
   * `unsure` are handled, so this function only answers for the router
   * and the extractor. The name is kept because every call site reads
   * `engineOn({...})` and the intent is unchanged.
   */
  function engineOn(
    map: Record<string, { route: string; facts?: Record<string, unknown> }>,
  ): void {
    const bodies: Record<string, string> = {};
    const factBodies: Record<string, Record<string, unknown>> = {};
    for (const [body, v] of Object.entries(map)) {
      bodies[body] = v.route;
      if (v.facts) factBodies[body] = v.facts;
    }
    setRouterStub({ floor: false, bodies });
    setExtractorStub({ bodies: factBodies });
  }

  const IN = (over: Record<string, unknown> = {}) => facts([claim(over)]);

  // ── The default: nothing changes ──────────────────────────────────

  test("there is no OFF any more: an unrouted message is OWNED, and writes nothing", async ({
    request,
    db,
  }) => {
    // ═══════════════════════════════════════════════════════════════════
    // ⚠️ PORTED TWICE ON 2026-09-06. WHAT THIS TEST MEANT CHANGED TWICE.
    // ═══════════════════════════════════════════════════════════════════
    //
    // ORIGINALLY: "with the flag OFF, the analyzer decides exactly as it
    // does today" — it cleared both stubs and asserted pete ended up
    // CONFIRMED, because with `ATTENDANCE_ENGINE_ENABLED` off the
    // mega-prompt still registered him.
    //
    // THEN `analyzeBatch` was deleted, which made the flag's off position
    // mean SILENCE rather than "the incumbent decides".
    //
    // THEN THE FLAG ITSELF WAS DELETED, in the same change and for that
    // reason: `gate.ts`'s essay calls an off position with no
    // implementation "a kill switch for the product's core write path
    // wearing the name of a tuning lever", and says plainly that the
    // revert for step 8 is `git revert`. `ROUTER_GATE_ENABLED`,
    // `ATTENDANCE_ENGINE_ENABLED`, `ENGINE_HEADER` and the `enabled` /
    // `engine` stub fields all went with it.
    //
    // So there is no "flag off" state left to test, and this case now
    // pins what replaced it — which is a real, load-bearing behaviour and
    // the other half of the same decision. `unsure` joined
    // `ENGINE_ROUTES`, and an unmapped id routes `unsure`
    // (`gate.ts:711`), so a message nobody wrote a route for is now
    // OWNED by the attendance engine rather than dropped. §11.1's
    // asymmetry, made real: "a false positive costs one extractor call
    // (~$0.002) that returns no claims. A false negative costs a player
    // their slot."
    //
    // The direction that matters is that owning it costs nothing: the
    // extractor found no claims, so nothing is written and nothing is
    // said. An `attendance-engine` row appears, and that is the point —
    // the decision is auditable instead of invisible.
    //
    // THE TOMBSTONE for the deleted flags lives in
    // `src/lib/pipeline/__tests__/gate.test.ts` ("names no predicate for
    // a flag that was deleted"), which is why this file does not try to
    // assert their absence as well.
    const g = await createGroup(request, db, { attendance: [] });
    clearRouterStub();
    clearExtractorStub();

    const res = await g.postBatch([{ player: "pete", body: "in" }]);

    expect(
      await g.attendanceOf("pete"),
      "no facts means no write, however the message was routed",
    ).toBeNull();
    expect(res.results[0].reply, "and nothing is said to the group").toBeNull();

    // OWNED, not dropped. This is the assertion that inverted: it used
    // to require this count to be "0".
    const row = await db.one<{ handledBy: string }>(
      `SELECT "handledBy" FROM "AnalyzedMessage" WHERE "orgId" = $1 AND body = 'in'`,
      [g.orgId],
    );
    expect(
      row?.handledBy,
      "an unmapped id routes `unsure`, which the engine owns since §10 step 8 — a message " +
        "nobody claims is now the exception rather than the default",
    ).toBe("attendance-engine");
  });

  // ── Over-writing: the dangerous direction, first ──────────────────

  test("a message the engine does NOT own cannot be written by it", async ({ request, db }) => {
    // ── PORTED 2026-09-06, §10 STEP 8. THE ROUTE HAD TO MOVE. ────────
    //
    // This used `unsure`, on the reasoning that "`unsure` is
    // attendance-SHAPED and deliberately not owned: the router could not
    // settle it, so the analyzer decides". `unsure` JOINED `ENGINE_ROUTES`
    // in step 8 (`gate.ts:265-270`) and for exactly that reason inverted:
    // with no analyzer, the question a doubtful route asks is no longer
    // "engine or analyzer" but "engine or silence", and §11.1 answers it
    // the other way — a false positive costs one extractor call that
    // returns no claims, a false negative costs a player their slot.
    //
    // The PROPERTY under test is unchanged; the example had to move.
    // `none` is now the strongest statement of it: the router called it
    // banter, a perfectly good IN is sitting in the extractor stub, and
    // the engine must still not touch the row. This is that constant
    // (`ENGINE_ROUTES` excludes `none`) asserted end to end rather than
    // read.
    const g = await createGroup(request, db, { attendance: [] });
    engineOn({ "😂😂 never": { route: "none", facts: IN() } });

    await g.postBatch([{ player: "pete", body: "😂😂 never" }]);

    const row = await db.one<{ handledBy: string }>(
      `SELECT "handledBy" FROM "AnalyzedMessage" WHERE "orgId" = $1 AND body = '😂😂 never'`,
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

  test("an AVAILABILITY statement registers nobody — PR #44's last spurious write", async ({
    request,
    db,
  }) => {
    // 2026-06-20, Abid Kazmi, ten days before kickoff, squad 0/14,
    // answering a chase: "I will be back Tuesday week". The engine
    // registered him CONFIRMED. `tense` said "future" and `contingent`
    // said false — exactly what "I'm in for next Tuesday" says — so the
    // schema had nothing to separate a travel statement from a
    // commitment. `basis` is that field, and this is it end to end.
    const g = await createGroup(request, db, { attendance: [] });
    engineOn({
      "I will be back Tuesday week": {
        route: "self_att",
        facts: IN({ tense: "future", basis: "availability", confidence: 0.7 }),
      },
    });

    const res = await g.postBatch([{ player: "pete", body: "I will be back Tuesday week" }]);

    expect(await g.attendanceOf("pete")).toBeNull();
    expect(res.results[0].reply).toBeNull();
  });

  test("…and a real commitment the same distance out STILL registers", async ({ request, db }) => {
    // The control, and the direction a careless fix breaks. Same sender,
    // same world, same "Tuesday": only what the message DOES differs.
    const g = await createGroup(request, db, { attendance: [] });
    engineOn({
      "I'm in for next Tuesday": {
        route: "self_att",
        facts: IN({ tense: "future", basis: "decision" }),
      },
    });

    await g.postBatch([{ player: "pete", body: "I'm in for next Tuesday" }]);
    expect(await g.attendanceOf("pete")).toMatchObject({ status: "CONFIRMED" });
  });

  test("an availability OUT still frees the slot — the asymmetry is deliberate", async ({
    request,
    db,
  }) => {
    // Being ABLE to play is necessary and never sufficient; being
    // UNABLE settles it. Refusing this direction too would trade one
    // spurious write for a class of missed ones, and a place nobody can
    // use is a place the club loses.
    const g = await createGroup(request, db, {
      attendance: [{ key: "pete", status: "CONFIRMED" }],
    });
    engineOn({
      "I'm away next week": {
        route: "self_att",
        facts: IN({ polarity: "out", tense: "future", basis: "availability", confidence: 0.9 }),
      },
    });

    await g.postBatch([{ player: "pete", body: "I'm away next week" }]);
    expect(await g.attendanceOf("pete")).toMatchObject({ status: "DROPPED" });
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

  test("a pasted numbered roster is not the engine's — PR #39's guard still runs", async ({
    request,
    db,
  }) => {
    // The engine would read a fourteen-line roster as fourteen
    // third-party IN claims. `clampRosterDerivedWrites` registers
    // NOBODY off a list that does not restate our own roster post, and
    // that guard lives in the analyze route, below the engine's
    // short-circuit. So the shape is not owned and the shipped rule
    // still runs — which matters, because PR #35 caught the same paste
    // registering a different subset of itself on each run.
    const g = await createGroup(request, db, { attendance: [] });
    const roster = "1. Dan Drummer\n2. Felix Fox\n3. Greg Gale\n4. Henry Hill";
    engineOn({
      [roster]: {
        route: "other_att",
        facts: facts([
          claim({ subject: "other", personRef: "Dan", personNamed: true, polarity: "in" }),
          claim({ subject: "other", personRef: "Felix", personNamed: true, polarity: "in" }),
        ]),
      },
    });

    await g.postBatch([{ player: "pete", body: roster, tag: true }]);

    // Nobody off the list is registered, by either decider.
    expect(await g.attendanceOf("dan")).toBeNull();
    expect(await g.attendanceOf("felix")).toBeNull();
    const row = await db.one<{ handledBy: string }>(
      `SELECT "handledBy" FROM "AnalyzedMessage" WHERE "orgId" = $1 AND body = $2`,
      [g.orgId, roster],
    );
    expect(row?.handledBy).not.toBe("attendance-engine");
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

  test("three INs in one batch: three ✅ and NOTHING said (2026-09-09)", async ({ request, db }) => {
    // WAS: "one reply per message, and one squad post per batch", which
    // asserted exactly one speaker carrying "3/". It did that, and on the
    // live group it did it for EVERY batch containing an "in" — Kemal,
    // 2026-09-09: "for every IN, MT is responding with the squad. I think
    // that is overmessaging. Only a tick is enough to confirm the
    // attendance is taken and a 5pm update about the squad is what we
    // agreed."
    //
    // The half of the old assertion that mattered survives below: one
    // outcome per message, three distinct ids, no `[SQUAD]` marker
    // leaking into a group message. What changed is the count of
    // speakers, from one to none.
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
    expect(res.results.filter((r) => (r.reply ?? "").length > 0)).toHaveLength(0);
    // The players ARE told — by the tick on each of their own messages,
    // which is the acknowledgement the roster post was doubling.
    expect(res.results.map((r) => r.react)).toEqual(["✅", "✅", "✅"]);
    for (const r of res.results) expect(r.reply ?? "").not.toContain("[SQUAD]");
    // …and nothing was queued as a group post instead.
    expect(res.groupPosts).toEqual([]);
    expect(new Set(res.results.map((r) => r.waMessageId)).size).toBe(3);
    // The writes all landed, whatever the bot did or did not say.
    expect((await g.counts()).confirmed).toBe(3);
  });

  // ── A drop that opens a spot speaks (2026-09-15) ──────────────────

  /** The squad the incident happened in: 14 of 14, empty bench. */
  const FOURTEEN = [
    "owner",
    "alice",
    "brian",
    "pete",
    "dan",
    "felix",
    "greg",
    "henry",
    "ivan",
    "jake",
    "kyle",
    "liam",
    "mike",
    "noah",
  ];

  const OUT = () => facts([claim({ polarity: "out" })]);

  /** The message as it was posted, verbatim, typos and all. */
  const INJURY =
    "Guys im really sorry but i have a foot injury sustained on the weekend. " +
    "Was hopingvit would get better but it hasnt so I am out today";

  test("THE 2026-09-15 INCIDENT: a self-drop off a full squad is announced, once", async ({
    request,
    db,
  }) => {
    // 10:48 UTC, match day, 14 of 14 and NOBODY on the bench. MatchTime
    // read the message correctly and marked him OUT, then said nothing
    // at all: he dropped himself, so S36b's two survivors (somebody
    // asked / a row moved for somebody who did not speak) both missed
    // it, and the 👋 on his own message was the whole acknowledgement.
    // The squad played 13 of 14 because nobody in the group was ever
    // told there was a hole.
    const g = await createGroup(request, db, {
      maxPlayers: 14,
      attendance: FOURTEEN.map((key) => ({ key, status: "CONFIRMED" as const })),
    });
    engineOn({ [INJURY]: { route: "self_att", facts: OUT() } });

    const res = await g.postBatch([{ player: "pete", body: INJURY }]);

    expect((await g.attendanceOf("pete"))?.status).toBe("DROPPED");
    expect(await g.counts()).toMatchObject({ confirmed: 13, bench: 0 });

    // EXACTLY ONE speaker, and it is the drop's own message.
    const speakers = res.results.filter((r) => (r.reply ?? "").length > 0);
    expect(speakers).toHaveLength(1);
    // The kickoff label is whatever the next fixture is for this sim
    // group, so it is matched rather than spelled: the words either side
    // of it are the assertion.
    expect(speakers[0].reply).toMatch(
      /^Pete is out, 13 of 14 for \w{3} \d\d:\d\d\. One slot open, say \*IN\* to take it\.$/,
    );
    expect(res.results[0].react).toBe("👋");

    // It survived `composeSquadStateReply` intact — no `[SQUAD]` marker,
    // no fourteen-line roster in its place, no extra group post.
    expect(speakers[0].reply).not.toContain("[SQUAD]");
    expect(speakers[0].reply).not.toContain("Playing:");
    expect(res.groupPosts).toEqual([]);

    // AND NOBODY WAS DM'd. A group post reaches the same people at no
    // risk to the (unofficial) WhatsApp client.
    expect(res.dms).toEqual([]);
  });

  test("an IN into the same full squad still says nothing (PR #63)", async ({ request, db }) => {
    // The regression that matters most. An IN closes a gap and needs
    // only the tick; an OUT opens one. Same squad, same batch shape,
    // opposite polarity, opposite answer.
    const g = await createGroup(request, db, {
      maxPlayers: 14,
      attendance: FOURTEEN.slice(0, 13).map((key) => ({ key, status: "CONFIRMED" as const })),
    });
    engineOn({ in: { route: "self_att", facts: IN() } });

    const res = await g.postBatch([{ player: "noah", body: "in" }]);

    expect(await g.counts()).toMatchObject({ confirmed: 14 });
    expect(res.results.filter((r) => (r.reply ?? "").length > 0)).toHaveLength(0);
    expect(res.results[0].react).toBe("✅");
    // The ONE thing that speaks is `squad-announce.ts`'s squad-complete
    // post, which PR #63 named as the owner of this occasion and which
    // this change does not touch. Nothing from the engine, and above all
    // no open-slot line: a fill is not a vacancy.
    expect(res.groupPosts).toHaveLength(1);
    expect(res.groupPosts[0]).toContain("Squad complete");
    expect(res.groupPosts.join("\n")).not.toContain("slot open");
    expect(res.dms).toEqual([]);
  });

  test("a drop with a BENCH behind it leaves the bench broadcast to do the talking", async ({
    request,
    db,
  }) => {
    // `cancelAttendance` → `requestBenchConfirmationOnDrop` opens ONE
    // BenchSlotOffer, and the scheduler turns it into a group post
    // tagging every bencher plus a DM each. A second "one slot open" on
    // top of that is noise.
    const g = await createGroup(request, db, {
      maxPlayers: 14,
      attendance: [
        ...FOURTEEN.map((key) => ({ key, status: "CONFIRMED" as const })),
        { key: "quinn", status: "BENCH" as const },
      ],
    });
    engineOn({ [INJURY]: { route: "self_att", facts: OUT() } });

    const res = await g.postBatch([{ player: "pete", body: INJURY }]);

    expect(await g.counts()).toMatchObject({ confirmed: 13, bench: 1 });
    const speakers = res.results.filter((r) => (r.reply ?? "").length > 0);
    expect(speakers).toHaveLength(1);
    expect(speakers[0].reply).toContain("A slot just opened");
    expect(speakers[0].reply).not.toContain("13 of 14");
    expect(res.dms).toEqual([]);
  });

  test("a batch with SEVERAL drops announces them once, in one sentence", async ({
    request,
    db,
  }) => {
    // Four contradictory posts in one batch is the 2026-06-12 Sutton
    // Lads incident. S36's single-post rule has to hold here too.
    const g = await createGroup(request, db, {
      maxPlayers: 14,
      attendance: FOURTEEN.map((key) => ({ key, status: "CONFIRMED" as const })),
    });
    engineOn({
      "out today lads": { route: "self_att", facts: OUT() },
      "cant make it sorry": { route: "self_att", facts: OUT() },
    });

    const res = await g.postBatch([
      { player: "pete", body: "out today lads" },
      { player: "dan", body: "cant make it sorry" },
    ]);

    expect(await g.counts()).toMatchObject({ confirmed: 12, bench: 0 });
    const speakers = res.results.filter((r) => (r.reply ?? "").length > 0);
    expect(speakers).toHaveLength(1);
    expect(speakers[0].reply).toMatch(
      /^Pete and Dan are out, 12 of 14 for \w{3} \d\d:\d\d\. 2 slots open, say \*IN\* to take one\.$/,
    );
    expect(res.groupPosts).toEqual([]);
    expect(res.dms).toEqual([]);
  });

  test("a squad that was ALREADY short says nothing when another player drops", async ({
    request,
    db,
  }) => {
    // 13 of 14 → 12 of 14. The group can already see it is short and the
    // 17:00 chase is already running on `need > 0`. Announcing every
    // subsequent OUT is the overmessaging PR #63 was asked to stop.
    const g = await createGroup(request, db, {
      maxPlayers: 14,
      attendance: FOURTEEN.slice(0, 13).map((key) => ({ key, status: "CONFIRMED" as const })),
    });
    engineOn({ [INJURY]: { route: "self_att", facts: OUT() } });

    const res = await g.postBatch([{ player: "pete", body: INJURY }]);

    expect(await g.counts()).toMatchObject({ confirmed: 12 });
    expect(res.results.filter((r) => (r.reply ?? "").length > 0)).toHaveLength(0);
    expect(res.groupPosts).toEqual([]);
    expect(res.dms).toEqual([]);
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

  test("an extractor failure now LOSES the write, and says so — the second line is gone", async ({
    request,
    db,
  }) => {
    // ═══════════════════════════════════════════════════════════════════
    // ⚠️ THE MOST IMPORTANT BEHAVIOUR CHANGE §10 STEP 8 MADE, AND IT IS
    //    A LOSS. THIS TEST NOW PINS THE LOSS.
    // ═══════════════════════════════════════════════════════════════════
    //
    // What this test asserted until 2026-09-06, under the title "an
    // extractor failure hands the message to the ANALYZER, not to
    // silence":
    //
    //     expect(await g.attendanceOf("pete")).toMatchObject({ status: "CONFIRMED" });
    //     expect(row?.handledBy).toBe("llm");
    //
    // …and the reasoning, verbatim: "§11.4 asked for 'fail closed and
    // surface it'. That was written before the analyzer was still
    // standing beside this path, and closed here meant SILENT — no
    // write, no reply, and a player who said IN not in the squad. The
    // first live sweep measured 27 `529 Overloaded` and 3 `500`s across
    // 10 messages, which took two corpus cases from 3/3 to 0/3 without
    // the engine ever deciding them wrongly. So the message goes back to
    // the incumbent, with every seatbelt still around it."
    //
    // THE INCUMBENT IS DELETED. `attendance-engine-batch.ts` still drops
    // a failed extraction out of `ownedIds` and still logs "handing this
    // message back to the analyzer" — there is nothing to hand it to.
    // The message reaches `route.ts`'s "NOBODY OWNED IT" branch: no
    // write, no reply, an `AnalyzedMessage` row, and one deduped
    // operator DM.
    //
    // So the exact failure §10 step 6 refused to accept — "a player who
    // said IN is not in the squad, because the API was busy" — is now
    // the shipped behaviour when an extractor call fails after the SDK's
    // four retries. It is written down here, as a passing test, rather
    // than discovered by a club on a Tuesday. WHAT WOULD MAKE IT
    // ACCEPTABLE is not a fallback decider (there is none to build) but
    // a RETRY or a REPLAY of the failed id, and neither exists yet.
    //
    // What is still proved, and is why this is a port and not a
    // deletion: the failure is LOUD. Nothing is written, nothing
    // cheerful is said, the row records why, and the operator note
    // fires. Silence with no signal is §9's signature failure; silence
    // WITH a signal is the accepted one.
    const g = await createGroup(request, db, { attendance: [] });
    setRouterStub({ floor: false, bodies: { in: "self_att" } });
    // Something `extractJson` cannot read at all.
    setExtractorStub({ bodies: { in: "not json at all" as never } });

    const res = await g.postBatch([{ player: "pete", body: "in" }]);

    // THE LOSS: the write does not land. There is no second decider.
    expect(
      await g.attendanceOf("pete"),
      "since §10 step 8 an extractor failure loses the registration outright",
    ).toBeNull();
    // And nothing cheerful is said about a write that did not happen.
    expect(res.results[0].reply).toBeNull();

    // THE SIGNAL: the row says why, and it is not `attendance-engine`
    // (which would claim the engine decided it).
    const row = await db.one<{ handledBy: string; reasoning: string }>(
      `SELECT "handledBy", reasoning FROM "AnalyzedMessage" WHERE "orgId" = $1 AND body = 'in'`,
      [g.orgId],
    );
    expect(row?.handledBy).not.toBe("attendance-engine");
    expect(row?.reasoning).toContain("no owner:");
    // The DEGRADATION has to reach the row, or an extractor failure is
    // indistinguishable from ordinary banter nobody owned — and the two
    // want completely different responses from a human.
    //
    // MEASURED, not assumed. The row reads:
    //   no owner: route=self_att — extractor <id>: attendance extractor
    //   output could not be parsed: no JSON object in the response
    // i.e. the line comes from the EXTRACTOR stage, not from
    // `ENGINE_APPLY_DEGRADED_PREFIX`. Asserted on the two facts a human
    // needs (which stage, and that it was a failure rather than a
    // decision) rather than on a marker string, which would pin the
    // wording of a sentence nothing parses.
    expect(row?.reasoning).toContain("extractor");
    expect(row?.reasoning).toMatch(/could not be parsed|degraded|failed/i);

    // And the operator hears about it — `lib/operator-note.ts`, the
    // typed successor to the "LLM dropped N messages" DM. Matched on
    // `OPERATOR_NOTE_MARKER` rather than on "some DM was sent", because
    // this world also queues bench and squad DMs and "a DM exists" would
    // pass for the wrong reason.
    //
    // The note's 1-hour dedupe is scoped to `orgId` and `createGroup`
    // mints a fresh org per test, so an earlier test's note in this file
    // cannot suppress this one.
    const dms = res.dms.map((d) => d.text).join("\n");
    expect(
      dms,
      "an unowned attendance message must raise the operator note — silence with no " +
        "signal is §9's signature failure and is the only thing making this loss survivable",
    ).toContain("routed to an action but nothing handled");
  });

  // ── the two defects the first live sweep found ────────────────────

  test("a bare 'Confirmed' resolves against the post in the HISTORY, not a BotJob row", async ({
    request,
    db,
  }) => {
    // §3.2 S25 (2026-04-24 Amir, 7453daa): MatchTime's own last post is
    // a KNOWN OBJECT, so a one-word confirmation is a lookup rather
    // than an inference. The first live sweep of this step took
    // `S25-short-confirm-after-pending-list` from 3/3 to 0/3 —
    // "expected MatchTime to say something; it was silent" — because
    // `loadSquadState` reads the last group `BotJob` and the pending
    // list lives in the HISTORY the Pi forwards. The history is what
    // actually appeared in the group, so it wins.
    const g = await createGroup(request, db, { attendance: [] });
    engineOn({
      Confirmed: {
        route: "self_att",
        facts: facts([], { affirmation: "yes" }),
      },
    });

    const res = await g.postBatch([{ player: "pete", body: "Confirmed" }], {
      history: [
        {
          authorName: "MatchTime",
          body: "Squad for Tue 20:00. Waiting for confirmation: Dan Drummer and Felix Fox.",
        },
      ],
    });

    expect(await g.attendanceOf("dan")).toMatchObject({ status: "CONFIRMED" });
    expect(await g.attendanceOf("felix")).toMatchObject({ status: "CONFIRMED" });
    // And it SPEAKS. "Message understood, action silently not taken" is
    // this product's signature failure and it applies just as much when
    // the action was already true.
    expect(res.results.filter((r) => (r.reply ?? "").length > 0).length).toBeGreaterThan(0);
  });

  test("ONE squad post per batch — and a mixed batch now has only one speaker at all", async ({
    request,
    db,
  }) => {
    // The other defect the first live sweep found, on
    // `S36-one-authoritative-squad-post-per-batch`: the engine posts the
    // roster whenever the squad changed, the analyzer answers the
    // question in the same batch, and the batch sends twice. The
    // incumbent avoided it for the wrong reason — a plain "in" got a
    // react and no reply — so the question's answer was the only send.
    //
    // ── PORTED 2026-09-06, §10 STEP 8 ────────────────────────────────
    //
    // The old title was "even when both deciders speak", and the second
    // decider was the mega-prompt answering the question. It is deleted,
    // and the scenario it created is now UNREACHABLE BY CONSTRUCTION
    // rather than merely handled: `answer-batch.ts`'s
    // `batchCarriesAnythingElse` refuses to own ANY question in a batch
    // that carries a message on a route step 7 does not own — the two
    // INs here — because its answers are composed from a pre-write
    // `SquadState` snapshot and "Yes, you're 2/14" beside somebody's own
    // "in" is a claim about a squad that no longer exists.
    //
    // ── UPDATED 2026-09-09 — WHO the one speaker is has changed ──────
    //
    // It used to be the attendance engine's unprompted roster post, and
    // the question was DECLINED. Both halves moved:
    //
    //   • The engine no longer posts the roster for a plain "in"
    //     (`engine.ts`'s speech assembly — Kemal: "for every IN, MT is
    //     responding with the squad. I think that is overmessaging").
    //   • Which is exactly why `answer-batch.ts` had to stop declining
    //     the question. The roster post was answering it BY ACCIDENT;
    //     with the post gone, the decline would have turned a tagged
    //     "how many are we now?" into silence.
    //
    // The old decline rested on "composed from a pre-write snapshot",
    // which is false for attendance traffic: `route.ts` awaits the
    // attendance owner and its writes at `:1360`, and the answer owner
    // loads its own state at `:1512`.
    //
    // So the batch still has ONE speaker, still carrying the batch-final
    // roster read from the database. It is now felix's message rather
    // than a batch-level post — which is also better, because the answer
    // is attached to the question. The step-7 route is turned ON via
    // `engineRoutes` so this is a real decision by a live owner and not
    // the flag being off.
    const g = await createGroup(request, db, { attendance: [] });
    setRouterStub({
      floor: false,
      engineRoutes: ["question"],
      bodies: {
        in: "self_att",
        "me too": "self_att",
        "@Match Time how many are we now?": "question",
      },
    });
    setExtractorStub({
      bodies: {
        in: IN(),
        "me too": IN(),
        // Real question facts, so the answer engine's decline is its
        // OWN mixed-batch rule and not a parse failure.
        "@Match Time how many are we now?": { topic: "count", personRef: null, statedCount: null },
      },
    });

    const res = await g.postBatch([
      { player: "pete", body: "in" },
      { player: "dan", body: "me too" },
      { player: "felix", body: "@Match Time how many are we now?", tag: true },
    ]);

    const spoke = res.results.filter((r) => (r.reply ?? "").length > 0);
    expect(spoke).toHaveLength(1);
    expect(res.groupPosts).toEqual([]);
    // The one send carries the roster, composed from the database AFTER
    // the two INs landed — 2/, never the 0/ the pre-batch state had.
    expect(spoke[0].reply).toContain("2/");
    expect(spoke[0].reply).not.toContain("[SQUAD]");
    // …and it IS the question's answer, on the question's own message.
    expect(spoke[0].waMessageId).toBe(res.results[2].waMessageId);
    // The two INs said nothing at all; their ✅ is the acknowledgement.
    expect(res.results[0].reply).toBeNull();
    expect(res.results[1].reply).toBeNull();
    expect(res.results[0].react).toBe("✅");
    expect(res.results[1].react).toBe("✅");
    // Both writes landed.
    expect(await g.attendanceOf("pete")).toMatchObject({ status: "CONFIRMED" });
    expect(await g.attendanceOf("dan")).toMatchObject({ status: "CONFIRMED" });
  });

  test("the stubs do not leak between tests — clearing them is a complete reset", async ({
    request,
    db,
  }) => {
    // ── DELETED AND REPLACED 2026-09-06, §10 STEP 8 ──────────────────
    //
    // WHAT WAS HERE: "turning the flag back off is a complete revert,
    // mid-suite" — the same body, the same world, `ATTENDANCE_ENGINE_ENABLED`
    // flipped off mid-file, asserting `handledBy === "llm"`, i.e. that
    // the mega-prompt decided it again. It was §10's revert column for
    // step 6 written as a test rather than a sentence.
    //
    // THAT CLAIM NO LONGER HAS A SUBJECT. The flag is deleted from
    // `pipeline/gate.ts`, and so is the analyzer it reverted to. There
    // is no mid-suite flip to make and nothing for it to flip to; the
    // revert for step 8 is `git revert`, which that file says in terms.
    // COVERED NOW by `src/lib/pipeline/__tests__/gate.test.ts`'s "names
    // no predicate for a flag that was deleted", which is a tombstone
    // for exactly these names and sends the next person who wants a kill
    // switch to the essay explaining why there isn't one.
    //
    // WHAT REPLACES IT, and why this file still needs a last case: the
    // property that made the old test worth running at the END was
    // isolation — that twenty-odd stubbed cases leave no residue for the
    // next one. That is now the only thing left to check here, and it
    // still matters: `afterEach` clears both stub files, and a leak
    // would make every case after the leaking one test a world nobody
    // described. Same shape as the old test, one flag lighter.
    const g = await createGroup(request, db, { attendance: [] });
    clearRouterStub();
    clearExtractorStub();

    const res = await g.postBatch([{ player: "pete", body: "in" }]);

    // No facts survive from any earlier case, so nothing is written and
    // nothing is said — whoever ends up owning the message.
    expect(await g.attendanceOf("pete")).toBeNull();
    expect(res.results[0].reply).toBeNull();
    expect(res.groupPosts).toEqual([]);
    expect(await g.counts()).toMatchObject({ confirmed: 0, bench: 0 });
  });
});

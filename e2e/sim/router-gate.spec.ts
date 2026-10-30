/**
 * §10 STEP 5 — the router gate, through the REAL analyze route.
 *
 * The unit tests prove the partition is monotone. This proves the thing
 * that actually matters: what a `none` route COSTS, and what the floor
 * buys back.
 *
 * Four questions, in the order they matter:
 *
 *   1. With every message routed `none`, does the batch go quiet without
 *      going invisible? (That is the 44x saving, and the row is what
 *      stops it being a disappearance.)
 *   2. With one real IN in a banter batch, does the IN still register?
 *   3. If the router wrongly routes a real IN `none`, what happens —
 *      with the floor off, and with it on? (The regression, measured,
 *      and the seatbelt catching it.)
 *   4. Does gating narrow only what the MODEL sees, or does it also
 *      narrow what the ENGINE'S BATCH RULES see? (Both, since §10 step 8
 *      — measured in the last case rather than assumed.)
 *
 * ═══════════════════════════════════════════════════════════════════════
 * PORTED 2026-09-06, §10 STEP 8. THREE CASES WERE DELETED — READ WHY
 * ═══════════════════════════════════════════════════════════════════════
 *
 * ① "with the gate OFF, the batch reaches the analyzer exactly as it does
 *    today". `ROUTER_GATE_ENABLED` is deleted from `pipeline/gate.ts`,
 *    together with the analyzer its off position reverted to. There is no
 *    gate-off state: `routerIsNeeded()` now takes no arguments and
 *    returns true, because without a route nothing has an owner and
 *    MatchTime says nothing to anybody. `gate.ts`'s own essay is the
 *    argument, `__tests__/gate.test.ts` ("names no predicate for a flag
 *    that was deleted") is the tombstone, and
 *    `attendance-engine.spec.ts`'s first case pins what replaced it —
 *    an unrouted message is OWNED, and writes nothing.
 *
 * ② "the IN safety net still sees a gated message as the author's latest"
 * ③ "…and DOES fire when the gated message came first"
 *
 *    Both drove the Najib IN safety net: `intent: "in"` with
 *    `registerAttendance: null` was forced back to IN, but only on the
 *    author's LAST message in the batch, and `latestIdxByAuthor` was
 *    built from `fresh`. The net is deleted (§10 step 6/8) and so is its
 *    input — a `Claim` has one `polarity` and cannot contradict itself,
 *    so there is nothing for a net to repair. `grep latestIdxByAuthor
 *    src/` returns nothing. The incident itself is still replayable:
 *    `attendance-engine.spec.ts`'s "S6 — an IN at a FULL squad still
 *    writes" and `e2e/corpus/incidents.jsonl`'s
 *    `S6-najib-in-at-full-squad`.
 *
 * The batch-visibility property those two cases ALSO carried — that a
 * gated message still occupies its place in the batch for the rules that
 * scan it — is kept, and is now case 4 below, driven through the
 * banter-drop guard instead of the deleted net.
 */
import { test, expect, resetDb } from "../fixtures";
import { createGroup } from "./group";
import { clearRouterStub } from "../helpers/stub";
import { otherFacts, selfIn } from "../helpers/stub";

const LIVE = process.env.MT_SIM_LIVE_LLM === "1";

// Skipped under MT_SIM_LIVE_LLM=1: that flag pins the router stub file
// empty (and `assertSeamMatchesMode` refuses a live run that can still
// see it), so there would be no way to drive the router deterministically.
(LIVE ? test.describe.skip : test.describe)("§10 step 5 — the router gate", () => {
  test.describe.configure({ mode: "serial" });
  test.beforeAll(resetDb);
  test.afterEach(() => clearRouterStub());

  test("an all-banter batch never reaches an extractor, and is not invisible either", async ({
    request,
    db,
  }) => {
    const g = await createGroup(request, db, { attendance: [] });

    const res = await g.postBatch([
      { player: "pete", body: "😂😂😂", route: "none" },
      { player: "dan", body: "🐐", route: "none" },
      { player: "felix", body: "great game last night", route: "none" },
    ]);

    // Silence, and no writes — the same outcome the mega-call produced
    // for banter, for a fraction of the money.
    expect(res.groupPosts).toEqual([]);
    for (const r of res.results) {
      expect(r.react).toBeNull();
      expect(r.reply).toBeNull();
    }
    expect(await g.attendanceOf("pete")).toBeNull();

    // But NOT invisible. Three rows, all tagged, all with a reason.
    const rows = await db.all<{ handledBy: string; intent: string; reasoning: string }>(
      `SELECT "handledBy", intent, reasoning FROM "AnalyzedMessage" WHERE "orgId" = $1 ORDER BY "createdAt"`,
      [g.orgId],
    );
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.handledBy).toBe("router-gate");
      expect(row.intent).toBe("noise");
      // The reason string changed with §10 step 8: it was
      // `router-gate: …` written by the gate's own peel, and it is now
      // `route.ts`'s single "NOBODY OWNED IT" line, which names the route
      // that produced the silence. Same guarantee — the row says why —
      // from one place instead of two.
      expect(row.reasoning).toContain("no owner: route=none");
    }
  });

  test("a real IN inside a banter batch still registers", async ({ request, db }) => {
    const g = await createGroup(request, db, { attendance: [] });

    await g.postBatch([
      { player: "pete", body: "😂😂😂", route: "none" },
      { player: "alice", body: "in", route: "self_att", facts: selfIn() },
      { player: "dan", body: "🐐", route: "none" },
    ]);

    expect(await g.attendanceOf("alice")).toMatchObject({ status: "CONFIRMED" });
    const theIn = await db.one<{ handledBy: string }>(
      `SELECT "handledBy" FROM "AnalyzedMessage" WHERE "orgId" = $1 AND body = 'in'`,
      [g.orgId],
    );
    // The AUDIT column, which says WHO decided. It read `llm` while the
    // mega-prompt existed; the wire `handledBy` in the response is still
    // `llm` for every owned message (`route.ts`'s note on the two
    // fields), and this one names the engine.
    expect(theIn?.handledBy).toBe("attendance-engine");
  });

  test("THE REGRESSION: a real IN misrouted `none` is dropped (no floor rescues it since 2026-10-30)", async ({
    request,
    db,
  }) => {
    // This is §11.1's failure, reproduced deliberately rather than
    // discovered in production. It is the honest cost of step 5 and the
    // reason the recall number in the PR is the number that matters.
    //
    // Note the FACTS are supplied and are perfectly good. They are never
    // asked for: `none` is not in `ENGINE_ROUTES`, so no extractor runs
    // and the write is lost one layer before anything could decide it.
    const g = await createGroup(request, db, { attendance: [] });

    await g.postBatch([
      { player: "alice", body: "in", route: "none", facts: selfIn() },
    ]);

    expect(await g.attendanceOf("alice")).toBeNull();
    // The one consolation, and it is a real one: the row says so.
    const row = await db.one<{ handledBy: string; reasoning: string }>(
      `SELECT "handledBy", reasoning FROM "AnalyzedMessage" WHERE "orgId" = $1 AND body = 'in'`,
      [g.orgId],
    );
    expect(row?.handledBy).toBe("router-gate");
  });

  // THE SEATBELT AND THE MENTION FLOOR TESTS ARE DELETED (2026-10-30).
  // The regex floor that rescued a bare "in" or "@Name In" the router
  // called `none` was removed ("no string parsing"): the router decides,
  // and the paid incident-corpus run is what proves it does. The
  // REGRESSION test above still pins what a wrong `none` costs.

  test("WHAT GATING COSTS: a protest the router calls banter cannot protect its author", async ({
    request,
    db,
  }) => {
    // ══════════════════════════════════════════════════════════════════
    // PORTED 2026-09-06, AND THE ANSWER INVERTED. READ THIS ONE.
    // ══════════════════════════════════════════════════════════════════
    //
    // WAS: "a gated message still counts as part of the batch for the
    // guards that scan it". The banter-drop guard lived in
    // `analyze/route.ts`, scanned `fresh` — every message in the request,
    // whatever its route — and stripped a third-party OUT when the TARGET
    // "also spoke in the same batch and did not corroborate it". So a
    // gated 😂 still protected its author, and the test's whole point was
    // that the gate narrows what the MODEL sees and nothing else.
    //
    // IT NOW NARROWS BOTH, and deliberately. `pipeline/engine.ts`'s
    // `banterRefusal` takes `batch: EngineMessage[]` — the messages the
    // ENGINE OWNS — and refuses the drop only when the target's own
    // message carries `subject: "sender", polarity: "in"`. Two things
    // changed at once: the guard needs a CLAIM rather than any utterance,
    // and a `none`-routed message is not in the batch to carry one. That
    // function's header says why the narrower rule was chosen: "An
    // admin's uncontested instruction is always honoured — that is the
    // control case, and losing it would be its own incident."
    //
    // So this test MEASURES the cost rather than asserting a property
    // that is no longer true. Both halves run against the same world,
    // one routing apart, because the difference between them is the
    // finding.
    const g = await createGroup(request, db, {
      attendance: [
        { key: "greg", status: "CONFIRMED" },
        { key: "dan", status: "CONFIRMED" },
      ],
    });

    // ── A. the protest is GATED. The drop lands. ─────────────────────
    await g.postBatch([
      {
        player: "alice",
        body: "@Match Time Greg is out",
        tag: true,
        route: "other_att",
        facts: otherFacts("Greg", "out"),
      },
      { player: "greg", body: "im in", route: "none", facts: selfIn() },
    ]);
    expect(
      await g.attendanceOf("greg"),
      "a gated protest is invisible to the guard — the measured cost of the gate",
    ).toMatchObject({ status: "DROPPED" });

    // ── B. the same protest, ROUTED. The drop is refused. ────────────
    const h = await createGroup(request, db, {
      attendance: [
        { key: "greg", status: "CONFIRMED" },
        { key: "dan", status: "CONFIRMED" },
      ],
    });
    await h.postBatch([
      {
        player: "alice",
        body: "@Match Time Greg is out",
        tag: true,
        route: "other_att",
        facts: otherFacts("Greg", "out"),
      },
      { player: "greg", body: "im in", route: "self_att", facts: selfIn() },
    ]);
    expect(
      await h.attendanceOf("greg"),
      "with the protest routed, corroboration sees it and the drop is refused",
    ).toMatchObject({ status: "CONFIRMED" });
  });
});

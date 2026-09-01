/**
 * §10 STEP 5 — the router gate, through the REAL analyze route.
 *
 * The unit tests prove the partition is monotone. This proves the thing
 * that actually matters: that turning the gate on does not change what
 * MatchTime writes, and that turning it off restores today exactly.
 *
 * Four questions, in the order they matter:
 *
 *   1. With the gate OFF, is anything different? (Must be: no.)
 *   2. With the gate ON, does an all-banter batch reach the analyzer at
 *      all? (Must be: no — that is the 44x saving.)
 *   3. With the gate ON and one real IN in a banter batch, does the IN
 *      still register? (Must be: yes.)
 *   4. If the router wrongly routes a real IN `none`, what happens —
 *      with the floor off, and with it on? (The regression, measured,
 *      and the seatbelt catching it.)
 *
 * Plus the one that is easy to forget: a gated message must not become
 * invisible. §11.1's objection to the `none` bucket is that a message
 * disappears with no `AnalyzedMessage.action`, and the row this writes
 * is what makes "did the gate eat an IN?" answerable.
 */
import { test, expect, resetDb } from "../fixtures";
import { createGroup } from "./group";
import { clearRouterStub, setRouterStub } from "../helpers/stub";

const LIVE = process.env.MT_SIM_LIVE_LLM === "1";

// Skipped under MT_SIM_LIVE_LLM=1: that flag pins the router stub file
// empty (and `assertSeamMatchesMode` refuses a live run that can still
// see it), so there would be no way to drive the router deterministically.
(LIVE ? test.describe.skip : test.describe)("§10 step 5 — the router gate", () => {
  test.describe.configure({ mode: "serial" });
  test.beforeAll(resetDb);
  test.afterEach(() => clearRouterStub());

  test("with the gate OFF, the batch reaches the analyzer exactly as it does today", async ({
    request,
    db,
  }) => {
    const g = await createGroup(request, db, { attendance: [] });
    clearRouterStub(); // {} → the flags fall back to the env, where both are off

    const res = await g.postBatch([
      { player: "pete", body: "😂😂😂" },
      { player: "alice", body: "in", verdict: { intent: "in", registerAttendance: "IN", react: "✅" } },
    ]);

    expect(await g.attendanceOf("alice")).toMatchObject({ status: "CONFIRMED" });
    // Every message was analysed: nothing is tagged `router-gate`.
    const gated = await db.all<{ n: string }>(
      `SELECT count(*)::text AS n FROM "AnalyzedMessage" WHERE "handledBy" = 'router-gate'`,
    );
    expect(gated[0].n).toBe("0");
    expect(res.results).toHaveLength(2);
  });

  test("with the gate ON, an all-banter batch never reaches the analyzer", async ({
    request,
    db,
  }) => {
    const g = await createGroup(request, db, { attendance: [] });
    setRouterStub({
      enabled: true,
      floor: false,
      bodies: { "😂😂😂": "none", "🐐": "none", "great game last night": "none" },
    });

    const res = await g.postBatch([
      { player: "pete", body: "😂😂😂" },
      { player: "dan", body: "🐐" },
      { player: "felix", body: "great game last night" },
    ]);

    // Silence, and no writes — the same outcome the mega-call produces
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
      expect(row.reasoning).toContain("router-gate:");
    }
  });

  test("with the gate ON, a real IN inside a banter batch still registers", async ({
    request,
    db,
  }) => {
    const g = await createGroup(request, db, { attendance: [] });
    setRouterStub({
      enabled: true,
      floor: false,
      bodies: { "😂😂😂": "none", "🐐": "none", in: "self_att" },
    });

    await g.postBatch([
      { player: "pete", body: "😂😂😂" },
      { player: "alice", body: "in", verdict: { intent: "in", registerAttendance: "IN", react: "✅" } },
      { player: "dan", body: "🐐" },
    ]);

    expect(await g.attendanceOf("alice")).toMatchObject({ status: "CONFIRMED" });
    const theIn = await db.one<{ handledBy: string }>(
      `SELECT "handledBy" FROM "AnalyzedMessage" WHERE "orgId" = $1 AND body = 'in'`,
      [g.orgId],
    );
    expect(theIn?.handledBy).toBe("llm");
  });

  test("THE REGRESSION: a real IN misrouted `none` is dropped — with the floor off", async ({
    request,
    db,
  }) => {
    // This is §11.1's failure, reproduced deliberately rather than
    // discovered in production. It is the honest cost of step 5 and the
    // reason the recall number in the PR is the number that matters.
    const g = await createGroup(request, db, { attendance: [] });
    setRouterStub({ enabled: true, floor: false, bodies: { in: "none" } });

    await g.postBatch([
      { player: "alice", body: "in", verdict: { intent: "in", registerAttendance: "IN", react: "✅" } },
    ]);

    expect(await g.attendanceOf("alice")).toBeNull();
    // The one consolation, and it is a real one: the row says so.
    const row = await db.one<{ handledBy: string; reasoning: string }>(
      `SELECT "handledBy", reasoning FROM "AnalyzedMessage" WHERE "orgId" = $1 AND body = 'in'`,
      [g.orgId],
    );
    expect(row?.handledBy).toBe("router-gate");
  });

  test("THE SEATBELT: the same misroute, with the floor ON, still registers", async ({
    request,
    db,
  }) => {
    const g = await createGroup(request, db, { attendance: [] });
    setRouterStub({ enabled: true, floor: true, bodies: { in: "none" } });

    await g.postBatch([
      { player: "alice", body: "in", verdict: { intent: "in", registerAttendance: "IN", react: "✅" } },
    ]);

    expect(await g.attendanceOf("alice")).toMatchObject({ status: "CONFIRMED" });
    const row = await db.one<{ handledBy: string }>(
      `SELECT "handledBy" FROM "AnalyzedMessage" WHERE "orgId" = $1 AND body = 'in'`,
      [g.orgId],
    );
    // Forced back onto the analysed path, and handled by the analyzer
    // exactly as if the router had never said `none`.
    expect(row?.handledBy).toBe("llm");
  });

  test("the floor rescues an @mention registration too, and nothing else", async ({
    request,
    db,
  }) => {
    // `@Ehtisham Ul Haq In` routed `none` is the live-corpus failure the
    // mention half of the floor was built for; `@Henry Hill In` is the
    // same shape against this fixture's roster.
    const g = await createGroup(request, db, { attendance: [] });
    setRouterStub({
      enabled: true,
      floor: true,
      bodies: { "@Henry Hill In": "none", "Zeeshan is out 😂": "none" },
    });

    await g.postBatch([
      {
        player: "alice",
        body: "@Henry Hill In",
        verdict: { intent: "in", registerFor: [{ name: "Henry Hill", action: "IN" }] },
      },
      { player: "pete", body: "Zeeshan is out 😂" },
    ]);

    expect(await g.attendanceOf("henry")).toMatchObject({ status: "CONFIRMED" });
    // "Zeeshan is out 😂" is a SENTENCE, not a bare declaration — the
    // floor must not claim it, or the floor becomes a classifier again.
    const zeeshan = await db.one<{ handledBy: string }>(
      `SELECT "handledBy" FROM "AnalyzedMessage" WHERE "orgId" = $1 AND body LIKE 'Zeeshan%'`,
      [g.orgId],
    );
    expect(zeeshan?.handledBy).toBe("router-gate");
  });

  test("a gated message still counts as part of the batch for the guards that scan it", async ({
    request,
    db,
  }) => {
    // The banter-drop guard (route.ts) strips a third-party OUT when the
    // TARGET also spoke in the same batch and did not corroborate it.
    // It scans `fresh`. If the gate had removed the target's own message
    // from that array, the guard would flip from "strip" to "apply" and
    // drop a player who is actually in — a regression the gate must not
    // introduce. So the gate narrows only what the MODEL sees.
    const g = await createGroup(request, db, {
      attendance: [{ key: "greg", status: "CONFIRMED" }],
    });
    setRouterStub({ enabled: true, floor: false, bodies: { "😂": "none" } });

    await g.postBatch([
      {
        player: "pete",
        body: "Zair is out",
        verdict: { intent: "out", registerFor: [{ name: "Zair", action: "OUT" }] },
      },
      { player: "greg", body: "😂" },
    ]);

    // Zair spoke and did not say he was out, so the guard strips it —
    // exactly as it does with the gate off.
    expect(await g.attendanceOf("greg")).toMatchObject({ status: "CONFIRMED" });
  });
});

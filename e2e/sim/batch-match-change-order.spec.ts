/**
 * Group-simulator scenario: A CHANGE TO THE MATCH AND THE INs AROUND IT, IN
 * ONE BATCH (stubbed).
 *
 * THE INCIDENT (Sutton FC, 17 Nov 2026). 11:36 the organiser: "@Match Time
 * cancel the match due to low numbers". 12:48 and 12:50 two players wrote
 * "In". 12:51 the organiser: "@Match Time ... can you enable today's match
 * again?". The three arrived in ONE batch. The match was put back on, but
 * the attendance engine had already decided both INs against the still
 * cancelled match, and neither was written. The organiser added them by hand.
 *
 * The rule (`pipeline/multi-route.ts`, `matchChangesFirst`): a change to the
 * match itself is done before the batch's attendance claims, wherever it
 * sits among them, until the first cancel that comes after a claim; that
 * cancel and everything after it come after the claims, as before.
 *
 * The router and every extractor are stubbed, deterministic and free (no
 * model call, $0). The people are made up; their numbers are in Ofcom's
 * drama range, 07700 900xxx.
 */
import { readFileSync } from "node:fs";
import { test, expect, resetDb } from "../fixtures";
import { createGroup, type SimGroup, type SimPlayerSpec } from "./group";
import { clearExtractorStub, clearRouterStub, setExtractorStub, setRouterStub } from "../helpers/stub";
import { E2E } from "../helpers/env";

const LIVE = process.env.MT_SIM_LIVE_LLM === "1";

let phoneSeq = 0;
const drama = () => `+447700900${String(400 + phoneSeq++).padStart(3, "0")}`;

// Ava runs the club; Bea helps. Cal and Dov have not said yet.
const ROSTER = (): SimPlayerSpec[] =>
  [
    { key: "ava", name: "Ava Organiser", role: "OWNER" as const },
    { key: "bea", name: "Bea Helper", role: "ADMIN" as const },
    { key: "cal", name: "Cal Cove" },
    { key: "dov", name: "Dov Dale" },
    { key: "eli", name: "Eli Elm" },
    { key: "fin", name: "Fin Ford" },
    { key: "gus", name: "Gus Glen" },
    { key: "hal", name: "Hal Heath" },
    { key: "ian", name: "Ian Isle" },
    { key: "jon", name: "Jon Jetty" },
    { key: "kit", name: "Kit Knoll" },
    { key: "lev", name: "Lev Lea" },
    { key: "max", name: "Max Moor" },
    { key: "ned", name: "Ned Nook" },
    { key: "oli", name: "Oli Oak" },
    { key: "pip", name: "Pip Pond" },
  ].map((p) => ({ ...p, phone: drama() }));

const confirmed = (...keys: string[]) => keys.map((key) => ({ key, status: "CONFIRMED" as const }));

const IN = "In";
const BACK_ON = "@Match Time sorry lads, can you enable today's match again?";
const CANCEL = "@Match Time cancel the match due to low numbers";
const SWITCH_7 = "@Match Time make it 7 aside";

const SELF_IN = {
  claims: [
    { subject: "self", personRef: "", personNamed: false, polarity: "in", tense: "present", contingent: false, conditionOn: "none", confidence: 0.95, replaces: "" },
  ],
  affirmation: "none",
  sideRequests: [],
};
const admin = (action: string, extra: Record<string, unknown> = {}) => ({
  action,
  payerRef: "",
  count: 0,
  coveredRefs: [],
  phrase: "",
  note: "",
  lookbackMatches: 0,
  matchDay: "",
  toMatchTime: true,
  ...extra,
});

function arm() {
  setRouterStub({ floor: false, bodies: { [IN]: "self_att", [BACK_ON]: "admin_ops", [CANCEL]: "admin_ops", [SWITCH_7]: "admin_ops" } });
  setExtractorStub({
    byExtractor: {
      attendance: { [IN]: SELF_IN },
      admin: {
        [BACK_ON]: admin("restore_match"),
        [CANCEL]: admin("cancel_match"),
        [SWITCH_7]: admin("switch_format", { size: 7, aSide: true }),
      },
    },
  });
}

/** How many times the admin extractor read this body (the stub's log). */
function adminReads(body: string): number {
  let log = "";
  try {
    log = readFileSync(`${E2E.EXTRACTOR_STUB_FILE}.calls`, "utf8");
  } catch {
    return 0;
  }
  return log
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { label?: string; user?: string })
    .filter((c) => c.label === "extractor:admin" && (c.user ?? "").trimEnd().endsWith(body)).length;
}

/** A game today, six hours away, 10 places; `cancelled` as the organiser
 *  left it at 11:36. */
async function suttonWorld(
  request: Parameters<typeof createGroup>[0],
  db: Parameters<typeof createGroup>[1],
  o: { attendance: Array<{ key: string; status: "CONFIRMED" }>; cancelled: boolean; maxPlayers?: number },
): Promise<SimGroup> {
  const grp = await createGroup(request, db, {
    players: ROSTER(),
    maxPlayers: o.maxPlayers ?? 10,
    attendance: o.attendance,
    upcomingMatch: { hoursFromNow: 6, deadlineHoursBeforeKickoff: 0 },
  });
  if (o.cancelled) await db.run(`UPDATE "Match" SET status = 'CANCELLED' WHERE id = $1`, [grp.matchId!]);
  return grp;
}

async function statusOf(grp: SimGroup): Promise<string> {
  return (await grp.db.one<{ status: string }>(`SELECT status FROM "Match" WHERE id = $1`, [grp.matchId!]))!.status;
}

(LIVE ? test.describe.skip : test.describe)("a change to the match and the INs around it, in one batch (Sutton FC, 2026-11-17)", () => {
  test.describe.configure({ mode: "serial" });
  test.beforeAll(resetDb);
  test.beforeEach(() => {
    clearRouterStub();
    clearExtractorStub();
  });
  test.afterAll(() => {
    clearRouterStub();
    clearExtractorStub();
  });

  test("the incident: a cancelled game, two INs, then the organiser puts it back on. Both INs count", async ({ request, db }) => {
    const grp = (await suttonWorld(request, db, { attendance: confirmed("ava", "bea", "eli", "fin", "gus", "hal"), cancelled: true })).attach(request);
    arm();

    const res = await grp.postBatch([
      { player: "cal", body: IN },
      { player: "dov", body: IN },
      { player: "ava", body: BACK_ON, tag: true },
    ]);
    console.log(`[batch-order] incident results: ${JSON.stringify(res.results)}\n[posts] ${JSON.stringify(res.groupPosts)} [dms] ${JSON.stringify(res.dms)}`);

    expect(await statusOf(grp)).toBe("UPCOMING");
    expect(await grp.attendanceOf("cal")).toMatchObject({ status: "CONFIRMED" });
    expect(await grp.attendanceOf("dov")).toMatchObject({ status: "CONFIRMED" });

    // One result per message: the INs their usual tick, the restore its tick.
    expect(res.results.map((r) => r.handledBy)).not.toContain("missing");
    expect(res.results[0].react).toBe("✅");
    expect(res.results[1].react).toBe("✅");
    expect(res.results[2].react).toBe("✅");
    // The "back on" post, once.
    expect(res.groupPosts.filter((p) => /^✅ \*Match back on\*/.test(p))).toHaveLength(1);
    // The restore was read ONCE: the early pass's reading is not repeated.
    expect(adminReads(BACK_ON)).toBe(1);
  });

  test("the same, with one place left: the first IN plays, the second goes on the bench", async ({ request, db }) => {
    const grp = (
      await suttonWorld(request, db, { attendance: confirmed("ava", "bea", "eli", "fin", "gus", "hal", "ian", "jon", "kit"), cancelled: true })
    ).attach(request);
    arm();

    const res = await grp.postBatch([
      { player: "cal", body: IN },
      { player: "dov", body: IN },
      { player: "ava", body: BACK_ON, tag: true },
    ]);

    expect(await statusOf(grp)).toBe("UPCOMING");
    expect(await grp.attendanceOf("cal")).toMatchObject({ status: "CONFIRMED" });
    expect(await grp.attendanceOf("dov")).toMatchObject({ status: "BENCH" });
    expect(res.results[0].react).toBe("✅");
    expect(res.results[1].react).not.toBeNull();
    expect(res.groupPosts.filter((p) => /^✅ \*Match back on\*/.test(p))).toHaveLength(1);
  });

  test("next week's game already exists: the INs land on today's game, put back on, not next week's", async ({ request, db }) => {
    const grp = (await suttonWorld(request, db, { attendance: confirmed("ava", "bea", "eli", "fin", "gus", "hal"), cancelled: true })).attach(request);
    const nextWeek = await grp.addMatch({ daysFromNow: 7 });
    arm();

    await grp.postBatch([
      { player: "cal", body: IN },
      { player: "dov", body: IN },
      { player: "ava", body: BACK_ON, tag: true },
    ]);

    expect(await statusOf(grp)).toBe("UPCOMING");
    expect(await grp.attendanceOf("cal")).toMatchObject({ status: "CONFIRMED" });
    expect(await grp.attendanceOf("dov")).toMatchObject({ status: "CONFIRMED" });
    expect(await grp.attendanceOf("cal", nextWeek)).toBeNull();
    expect(await grp.attendanceOf("dov", nextWeek)).toBeNull();
  });

  test("a player's untagged 'is it off?' read as a cancel holds nothing back: the restore still comes first", async ({ request, db }) => {
    const grp = (await suttonWorld(request, db, { attendance: confirmed("ava", "bea", "eli"), cancelled: true })).attach(request);
    arm();
    const chatter = "so is it off or not lads";
    setRouterStub({ floor: false, bodies: { [IN]: "self_att", [BACK_ON]: "admin_ops", [chatter]: "admin_ops" } });
    setExtractorStub({ byExtractor: { attendance: { [IN]: SELF_IN }, admin: { [BACK_ON]: admin("restore_match"), [chatter]: admin("cancel_match") } } });

    const res = await grp.postBatch([
      { player: "cal", body: IN },
      { player: "dov", body: chatter },
      { player: "ava", body: BACK_ON, tag: true },
    ]);

    expect(await statusOf(grp)).toBe("UPCOMING");
    expect(await grp.attendanceOf("cal")).toMatchObject({ status: "CONFIRMED" });
    // The chatter: nothing done, nothing said.
    expect(res.results[1].reply ?? null).toBeNull();
    expect(res.groupPosts.filter((p) => /Match cancelled/.test(p))).toHaveLength(0);
  });

  test("a cancel AFTER the INs: the INs are recorded, then the game is cancelled", async ({ request, db }) => {
    const grp = (await suttonWorld(request, db, { attendance: confirmed("ava", "bea", "eli"), cancelled: false })).attach(request);
    arm();

    const res = await grp.postBatch([
      { player: "cal", body: IN },
      { player: "dov", body: IN },
      { player: "ava", body: CANCEL, tag: true },
    ]);
    console.log(`[batch-order] cancel after INs: ${JSON.stringify(res.results)}\n[posts] ${JSON.stringify(res.groupPosts)}`);

    expect(await statusOf(grp)).toBe("CANCELLED");
    // Recorded like every other row the cancel found (it keeps them).
    expect(await grp.attendanceOf("cal")).toMatchObject({ status: "CONFIRMED" });
    expect(await grp.attendanceOf("dov")).toMatchObject({ status: "CONFIRMED" });
    expect(res.results.map((r) => r.handledBy)).not.toContain("missing");
    expect(res.results[2].react).toBe("✅");
    expect(res.groupPosts.filter((p) => /^❌ \*Match cancelled\*/.test(p))).toHaveLength(1);
    expect(adminReads(CANCEL)).toBe(1);
  });

  test("a cancel BEFORE an IN: the IN meets a cancelled game, as it would in a later batch", async ({ request, db }) => {
    const grp = (await suttonWorld(request, db, { attendance: confirmed("ava", "bea", "eli"), cancelled: false })).attach(request);
    arm();

    const res = await grp.postBatch([
      { player: "ava", body: CANCEL, tag: true },
      { player: "cal", body: IN },
    ]);

    expect(await statusOf(grp)).toBe("CANCELLED");
    expect(await grp.attendanceOf("cal")).toBeNull();
    expect(res.results[0].react).toBe("✅");
    expect(res.groupPosts.filter((p) => /^❌ \*Match cancelled\*/.test(p))).toHaveLength(1);
    expect(adminReads(CANCEL)).toBe(1);
  });

  for (const order of ["switch first", "switch last"] as const) {
    test(`a switch to 7 a side and two INs (${order}): places counted against 14, one list, no DM`, async ({ request, db }) => {
      // Thirteen in for a sixteen-place game played 6, 7 or 8 a side.
      const grp = (
        await suttonWorld(request, db, {
          attendance: confirmed("ava", "bea", "eli", "fin", "gus", "hal", "ian", "jon", "kit", "lev", "max", "ned", "oli"),
          cancelled: false,
          maxPlayers: 16,
        })
      ).attach(request);
      await db.run(`UPDATE "Activity" SET "minPlayers" = 12, "maxPlayers" = 16 WHERE id = $1`, [grp.activityId]);
      arm();

      const ins = [
        { player: "cal", body: IN },
        { player: "dov", body: IN },
      ];
      const sw = { player: "ava", body: SWITCH_7, tag: true };
      const res = await grp.postBatch(order === "switch first" ? [sw, ...ins] : [...ins, sw]);
      console.log(`[batch-order] ${order}: ${JSON.stringify(res.results)}\n[posts] ${JSON.stringify(res.groupPosts)} [dms] ${JSON.stringify(res.dms)}`);

      const max = (await db.one<{ maxPlayers: number }>(`SELECT "maxPlayers" FROM "Match" WHERE id = $1`, [grp.matchId!]))!.maxPlayers;
      expect(max).toBe(14);
      expect(await grp.attendanceOf("cal")).toMatchObject({ status: "CONFIRMED" });
      expect(await grp.attendanceOf("dov")).toMatchObject({ status: "BENCH" });
      // Nobody was moved by the switch (the places were counted after it),
      // so nobody is DMed about a move.
      expect(res.dms).toEqual([]);
      // ONE list: no list queued by the switch beside the batch's one post.
      expect(res.groupPosts).toEqual([]);
      const speaking = res.results.filter((r) => (r.reply ?? "").length > 0);
      expect(speaking).toHaveLength(1);
      const reply = speaking[0].reply ?? "";
      expect(reply).toMatch(/7-a-side now, 14 places/);
      expect(reply).toContain("Dov Dale");
      expect(adminReads(SWITCH_7)).toBe(1);
    });
  }

  test("one message alone is what it was: a bare restore, then a bare IN, in two batches", async ({ request, db }) => {
    const grp = (await suttonWorld(request, db, { attendance: confirmed("ava", "bea", "eli"), cancelled: true })).attach(request);
    arm();

    const back = await grp.postBatch([{ player: "ava", body: BACK_ON, tag: true }]);
    expect(await statusOf(grp)).toBe("UPCOMING");
    expect(back.results[0]).toMatchObject({ react: "✅", reply: null });
    expect(back.groupPosts.filter((p) => /^✅ \*Match back on\*/.test(p))).toHaveLength(1);
    expect(adminReads(BACK_ON)).toBe(1);

    const one = await grp.postBatch([{ player: "cal", body: IN }]);
    expect(await grp.attendanceOf("cal")).toMatchObject({ status: "CONFIRMED" });
    expect(one.results[0].react).toBe("✅");
  });
});

/**
 * Group-simulator scenario: ONE MESSAGE, SEVERAL INSTRUCTIONS (stubbed).
 *
 * THE INCIDENT (Vets, 16 Nov 2026 18:07 UTC). An organiser tagged
 * MatchTime with one message holding four instructions: "switch to
 * 7aside, take Luca to bench, @<mention> is IN and then make the teams".
 * The router gave one route per message (other_att), so only the
 * attendance engine acted; the switch and the teams were dropped without a
 * word. The match stayed at 16 places and the team sheet said two places
 * were still needed.
 *
 * Now the router also lists the message's other instructions
 * (`RoutedMessage.alsoRoutes`); each part is done by its own owner, in
 * order (the format, who plays, the teams), and the group gets ONE reply.
 *
 * The router and every extractor are stubbed, deterministic and free (no
 * model call, $0): the router says which instructions the message holds,
 * and each extractor what it read of its own part. The people are made up;
 * their numbers are in Ofcom's drama range, 07700 900xxx.
 */
import { readFileSync } from "node:fs";
import { formatInTimeZone } from "date-fns-tz";
import { test, expect, resetDb } from "../fixtures";
import { createGroup, type SimGroup, type SimPlayerSpec } from "./group";
import { clearExtractorStub, clearRouterStub, setExtractorStub, setRouterStub } from "../helpers/stub";
import { E2E } from "../helpers/env";

const LIVE = process.env.MT_SIM_LIVE_LLM === "1";

let phoneSeq = 0;
const drama = () => `+447700900${String(100 + phoneSeq++).padStart(3, "0")}`;

// Sixteen made-up members: Ava runs the club; Luca is in the squad; Zak is
// a member who has not said yet.
const ROSTER = (): SimPlayerSpec[] =>
  [
    { key: "ava", name: "Ava Organiser", role: "OWNER" as const },
    { key: "bea", name: "Bea Helper", role: "ADMIN" as const },
    { key: "luca", name: "Luca Lane" },
    { key: "zak", name: "Zak Zephyr" },
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
  ].map((p) => ({ ...p, phone: drama() }));

// Fourteen in for a sixteen-place match: Luca in, Zak not yet.
const IN_14 = ["ava", "bea", "luca", "cal", "dov", "eli", "fin", "gus", "hal", "ian", "jon", "kit", "lev", "max"].map((key) => ({
  key,
  status: "CONFIRMED" as const,
}));

const INCIDENT = "@Match Time switch to 7aside, take Luca to bench, Zak is IN and make the teams";

const claim = (o: Record<string, unknown>) => ({
  subject: "other",
  personRef: "",
  personNamed: true,
  polarity: "in",
  tense: "present",
  contingent: false,
  conditionOn: "none",
  confidence: 0.95,
  replaces: "",
  ...o,
});
const ATTENDANCE = {
  claims: [claim({ personRef: "Luca", polarity: "bench" }), claim({ personRef: "Zak", polarity: "in" })],
  affirmation: "none",
  sideRequests: [],
};
const SWITCH_7 = { action: "switch_format", payerRef: "", count: 0, coveredRefs: [], phrase: "", note: "", lookbackMatches: 0, size: 7, aSide: true, toMatchTime: true };
const GENERATE = { action: "generate", includeRefs: [], teamNames: null, swaps: [], pairings: [] };

// "How many do we need now?" is the unified answer's (2026-11-18): the
// question extractor's "other", then one stubbed answer.
const COUNT = { kind: "other", personRef: "", feature: "none", badge: "none" };
const COUNT_ANSWER = "We're 14 of 14 now, so nobody else is needed.";

/** The unified answer's turn for this body, as the stub was shown it. */
function unifiedTurn(body: string): string {
  return (
    readFileSync(`${E2E.EXTRACTOR_STUB_FILE}.calls`, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { label: string; user: string })
      .filter((c) => c.label === "unified-answer" && c.user.trimEnd().endsWith(body))
      .pop()?.user ?? ""
  );
}

/** A match today, an hour away, played 6, 7 or 8 a side; with `teams`,
 *  a team sheet for the fourteen already made. */
async function vetsWorld(request: Parameters<typeof createGroup>[0], db: Parameters<typeof createGroup>[1], teams = false): Promise<SimGroup> {
  const grp = await createGroup(request, db, {
    players: ROSTER(),
    maxPlayers: 16,
    attendance: IN_14,
    upcomingMatch: { hoursFromNow: 1 },
    ...(teams ? { teams: Object.fromEntries(IN_14.map((a, i) => [a.key, i % 2 === 0 ? ("RED" as const) : ("YELLOW" as const)])) } : {}),
  });
  await db.run(`UPDATE "Activity" SET "minPlayers" = 12, "maxPlayers" = 16 WHERE id = $1`, [grp.activityId]);
  return grp;
}

function arm(body: string, routes: string[]) {
  setRouterStub({ floor: false, bodies: { [body]: routes } });
  setExtractorStub({
    byExtractor: {
      attendance: { [body]: ATTENDANCE },
      admin: { [body]: SWITCH_7 },
      teams: { [body]: GENERATE },
    },
  });
}

/** EXACTLY the posts expected: the one reply, and nothing queued beside it
 *  (no group post, no DM). */
function expectOnlyTheReply(res: { results: Array<{ reply: string | null }>; groupPosts: unknown[]; dms: unknown[] }) {
  expect(res.results).toHaveLength(1);
  expect((res.results[0].reply ?? "").length).toBeGreaterThan(0);
  expect(res.groupPosts).toEqual([]);
  expect(res.dms).toEqual([]);
}

async function maxPlayers(grp: SimGroup): Promise<number> {
  const row = await grp.db.one<{ maxPlayers: number }>(`SELECT "maxPlayers" FROM "Match" WHERE id = $1`, [grp.matchId!]);
  return row!.maxPlayers;
}

async function teamSheet(grp: SimGroup): Promise<string[]> {
  const rows = await grp.db.all<{ userId: string }>(`SELECT "userId" FROM "TeamAssignment" WHERE "matchId" = $1`, [grp.matchId!]);
  return rows.map((r) => r.userId);
}

(LIVE ? test.describe.skip : test.describe)("several instructions in one message (Vets, 2026-11-16)", () => {
  test.describe.configure({ mode: "serial" });
  test.beforeAll(resetDb);
  test.afterEach(() => {
    clearRouterStub();
    clearExtractorStub();
  });

  test("the incident: 14 places, Luca on the bench, Zak in, teams made, and ONE reply naming all four", async ({ request, db }) => {
    const grp = (await vetsWorld(request, db)).attach(request);
    arm(INCIDENT, ["other_att", "admin_ops", "balancer"]);

    const res = await grp.postBatch([{ player: "ava", body: INCIDENT, tag: true }]);

    // Every instruction carried out.
    expect(await maxPlayers(grp)).toBe(14);
    expect(await grp.attendanceOf("luca")).toMatchObject({ status: "BENCH" });
    expect(await grp.attendanceOf("zak")).toMatchObject({ status: "CONFIRMED" });
    const sheet = await teamSheet(grp);
    expect(sheet).toHaveLength(14);
    expect(sheet).toContain(grp.player("zak").userId);
    expect(sheet).not.toContain(grp.player("luca").userId);

    // EXACTLY one post: the reply. The switch queued no list of its own
    // (review of #613: it used to, "Playing 14 of 14 ... Luca", no Zak), and
    // nobody was moved by the switch, so no DM either.
    expectOnlyTheReply(res);
    const reply = res.results[0].reply ?? "";
    console.log(`[multi-instruction] the one reply:\n${reply}`);
    const blocks = reply.split("\n\n");
    expect(blocks[0]).toMatch(/^✅ Done: \w+ is 7-a-side now, 14 places\.$/);
    expect(blocks[1]).toBe("*Bench (1):*\n1. Luca Lane");
    expect(blocks[2]).toMatch(/^⚽ \*Teams for tonight\*/);
    expect(reply).toContain("Zak Zephyr");
    expect(reply).not.toMatch(/\[SQUAD\]|couldn't do|teams are cleared/);
  });

  test("a switch with a squad change and NO teams: the one reply carries the NEW list, built after both parts", async ({ request, db }) => {
    const grp = (await vetsWorld(request, db)).attach(request);
    const body = "@Match Time switch to 7aside and take Luca to the bench";
    setRouterStub({ floor: false, bodies: { [body]: ["other_att", "admin_ops"] } });
    setExtractorStub({
      byExtractor: {
        attendance: { [body]: { claims: [claim({ personRef: "Luca", polarity: "bench" })], affirmation: "none", sideRequests: [] } },
        admin: { [body]: SWITCH_7 },
      },
    });

    const res = await grp.postBatch([{ player: "ava", body, tag: true }]);

    expect(await maxPlayers(grp)).toBe(14);
    expect(await grp.attendanceOf("luca")).toMatchObject({ status: "BENCH" });
    expectOnlyTheReply(res);
    const reply = res.results[0].reply ?? "";
    console.log(`[multi-instruction] switch and bench, no teams:\n${reply}`);
    expect(reply.split("\n\n")[0]).toMatch(/^✅ Done: \w+ is 7-a-side now, 14 places\.$/);
    // The list: 13 of 14, Luca on the bench.
    expect(reply).toMatch(/13\D+14|13 of 14|13\/14/);
    expect(reply).toContain("Luca Lane");
    expect(reply).not.toMatch(/\[SQUAD\]|couldn't do/);
  });

  // Review of #629, item 4: the switch is the admin part's SECOND action.
  // The one reply still carries the new list (the switch is read from the
  // outcome's switched match, not from the start of a joined intent).
  test("the switch as the second admin action: the one reply still carries the NEW list", async ({ request, db }) => {
    const grp = (await vetsWorld(request, db)).attach(request);
    const body = "@Match Time turn off quiet hours, switch to 7aside and take Luca to the bench";
    const action = (o: Record<string, unknown>) => ({ ...SWITCH_7, size: 0, aSide: false, ...o });
    setRouterStub({ floor: false, bodies: { [body]: ["other_att", "admin_ops"] } });
    setExtractorStub({
      byExtractor: {
        attendance: { [body]: { claims: [claim({ personRef: "Luca", polarity: "bench" })], affirmation: "none", sideRequests: [] } },
        admin: { [body]: { toMatchTime: true, actions: [action({ action: "quiet_hours", quietOff: true, words: "turn off quiet hours" }), action({ action: "switch_format", size: 7, aSide: true, words: "switch to 7aside" })] } },
      },
    });

    const res = await grp.postBatch([{ player: "ava", body, tag: true }]);

    expect(await maxPlayers(grp)).toBe(14);
    expectOnlyTheReply(res);
    const reply = res.results[0].reply ?? "";
    console.log(`[multi-instruction] quiet hours, switch and bench:\n${reply}`);
    expect(reply).toMatch(/7-a-side now, 14 places/);
    expect(reply).toMatch(/13\D+14|13 of 14|13\/14/);
    expect(reply).not.toMatch(/\[SQUAD\]|couldn't do/);
  });

  test("teams already made: the switch clears them, the same message makes them again, and no 'tag me to make them again'", async ({ request, db }) => {
    const grp = (await vetsWorld(request, db, true)).attach(request);
    arm(INCIDENT, ["other_att", "admin_ops", "balancer"]);

    const res = await grp.postBatch([{ player: "ava", body: INCIDENT, tag: true }]);

    expect(await maxPlayers(grp)).toBe(14);
    expect(await teamSheet(grp)).toHaveLength(14);
    expectOnlyTheReply(res);
    const reply = res.results[0].reply ?? "";
    expect(reply.split("\n\n")[0]).toMatch(/^✅ Done: \w+ is 7-a-side now, 14 places\.$/);
    expect(reply).not.toMatch(/teams are cleared|make them again/);
    expect(reply).toMatch(/⚽ \*Teams for tonight\*/);
  });

  test("a question bundled with a switch is answered, after the switch", async ({ request, db }) => {
    const grp = (await vetsWorld(request, db)).attach(request);
    const body = "@Match Time make it 7 aside, how many do we need now?";
    setRouterStub({ floor: false, bodies: { [body]: ["admin_ops", "question"] } });
    setExtractorStub({
      byExtractor: { admin: { [body]: SWITCH_7 }, question: { [body]: COUNT }, "unified-answer": { [body]: { answer: COUNT_ANSWER } } },
    });

    const res = await grp.postBatch([{ player: "ava", body, tag: true }]);

    expect(await maxPlayers(grp)).toBe(14);
    expectOnlyTheReply(res);
    const reply = res.results[0].reply ?? "";
    console.log(`[multi-instruction] switch and question:\n${reply}`);
    expect(reply.split("\n\n")[0]).toMatch(/^✅ Done: \w+ is 7-a-side now, 14 places\.$/);
    expect(reply).toContain(COUNT_ANSWER);
    expect(reply).not.toMatch(/couldn.t do/);
    // Sutton 17 Nov 12:53: the answer is told the switch is ALREADY DONE,
    // with the line that said so, and is read from the squad after it.
    const turn = unifiedTurn(body);
    expect(turn).toMatch(/ALREADY DONE: other parts of MatchTime have acted on THE MESSAGE below, and said:\n {2}✅ Done: \w+ is 7-a-side now, 14 places\./);
    expect(turn).toMatch(/14 players/);
  });

  test("make the teams and tell us the list: the answer is told the teams are made, never 'I haven't made the teams' (review of #626)", async ({ request, db }) => {
    const grp = (await vetsWorld(request, db)).attach(request);
    const body = "@Match Time make the teams and tell us the list";
    const LIST_ANSWER = "In the squad: 14 of 16.";
    setRouterStub({ floor: false, bodies: { [body]: ["question", "balancer"] } });
    setExtractorStub({
      byExtractor: { teams: { [body]: GENERATE }, question: { [body]: COUNT }, "unified-answer": { [body]: { answer: LIST_ANSWER } } },
    });

    const res = await grp.postBatch([{ player: "ava", body, tag: true }]);

    expect(await teamSheet(grp)).toHaveLength(14);
    const reply = res.results[0].reply ?? "";
    console.log(`[multi-instruction] teams and the list:\n${reply}`);
    expect(reply).not.toMatch(/haven.t made the teams|couldn.t do/);
    // The teams part ran BEFORE the answer, and the answer was told it as
    // done: never as not done, never as a dead end.
    const turn = unifiedTurn(body);
    expect(turn).toContain("ALREADY DONE:");
    expect(turn).toMatch(/ALREADY DONE: [^\n]*\n {2}[^\n]*(Teams|teams were made)/);
    expect(turn).not.toContain("NOT DONE");
  });

  test("a club whose organisers announce the list: an unanswered bundled question adds no line", async ({ request, db }) => {
    const grp = (await vetsWorld(request, db)).attach(request);
    await db.run(`UPDATE "Organisation" SET "listAnnouncer" = 'organisers' WHERE id = $1`, [grp.orgId]);
    const body = "@Match Time I'm out, what's the list?";
    setRouterStub({ floor: false, bodies: { [body]: ["self_att", "question"] } });
    setExtractorStub({
      byExtractor: { attendance: { [body]: { claims: [claim({ subject: "self", personRef: "", personNamed: false, polarity: "out" })], affirmation: "none", sideRequests: ["question"] } } },
    });

    const res = await grp.postBatch([{ player: "cal", body, tag: true }]);

    expect(await grp.attendanceOf("cal")).toMatchObject({ status: "DROPPED" });
    expect(res.results[0].reply ?? "").not.toMatch(/couldn't do|yapamadım/);
  });

  test("two parts, one refused: a player's switch is refused in words, his own IN is done, one reply", async ({ request, db }) => {
    const grp = (await vetsWorld(request, db)).attach(request);
    const body = "@Match Time I'm in, and switch us to 7 aside";
    setRouterStub({ floor: false, bodies: { [body]: ["self_att", "admin_ops"] } });
    setExtractorStub({
      byExtractor: {
        attendance: { [body]: { claims: [claim({ subject: "self", personRef: "", personNamed: false, polarity: "in" })], affirmation: "none", sideRequests: [] } },
        admin: { [body]: SWITCH_7 },
      },
    });

    const res = await grp.postBatch([{ player: "zak", body, tag: true }]);

    expect(await maxPlayers(grp)).toBe(16);
    expect(await grp.attendanceOf("zak")).toMatchObject({ status: "CONFIRMED" });
    const reply = res.results[0].reply ?? "";
    console.log(`[multi-instruction] refused part:\n${reply}`);
    // The refusal names who can (the admin owner's own line for a player).
    expect(reply).toMatch(/Ava|Bea|organiser/i);
    expectOnlyTheReply(res);
  });

  test("a part nothing could read is named in one plain line", async ({ request, db }) => {
    const grp = (await vetsWorld(request, db)).attach(request);
    const body = "@Match Time Zak is IN and sort the settings";
    setRouterStub({ floor: false, bodies: { [body]: ["other_att", "admin_ops"] } });
    // The admin extractor's call fails, as an overloaded API does.
    setExtractorStub({
      byExtractor: { attendance: { [body]: { claims: [claim({ personRef: "Zak" })], affirmation: "none", sideRequests: [] } } },
      failByExtractor: { admin: [body] },
    });

    const res = await grp.postBatch([{ player: "ava", body, tag: true }]);

    expect(await grp.attendanceOf("zak")).toMatchObject({ status: "CONFIRMED" });
    expect(await maxPlayers(grp)).toBe(16);
    expect(res.results[0].reply ?? "").toContain("I couldn't do this part of your message: the setting change.");
  });

  test("ONE instruction is what it was: a bare switch, and a bare IN", async ({ request, db }) => {
    const grp = (await vetsWorld(request, db)).attach(request);
    const sw = "@Match Time make it 7 aside";
    setRouterStub({ floor: false, bodies: { [sw]: "admin_ops", in: "self_att" } });
    setExtractorStub({
      byExtractor: { admin: { [sw]: SWITCH_7 } },
      bodies: { in: { claims: [claim({ subject: "self", personRef: "", personNamed: false })], affirmation: "none", sideRequests: [] } },
    });

    // A bare IN while the game has 16 places: Zak is in, with the ✅.
    const b = await grp.postBatch([{ player: "zak", body: "in" }]);
    expect(await grp.attendanceOf("zak")).toMatchObject({ status: "CONFIRMED" });
    expect(b.results[0].react).toBe("✅");
    expect(b.results[0].reply ?? "").not.toMatch(/couldn't do this part/);

    // A bare switch: its own line, and nothing about other parts.
    const a = await grp.postBatch([{ player: "ava", body: sw, tag: true }]);
    expect(await maxPlayers(grp)).toBe(14);
    expect(a.results[0].reply ?? "").toMatch(/7-a-side|7 a side/i);
    expect(a.results[0].reply ?? "").not.toMatch(/couldn't do this part/);
  });
});

// THE VETS ARE A MONTHLY CLUB (review of #613): the same incident in a club
// whose squad is the month's list, with a running month whose fourteen
// regulars are the fourteen in.
(LIVE ? test.describe.skip : test.describe)("several instructions in a MONTHLY club (Vets, 2026-11-16)", () => {
  test.describe.configure({ mode: "serial" });
  test.afterEach(() => {
    clearRouterStub();
    clearExtractorStub();
  });

  async function monthlyVets(request: Parameters<typeof createGroup>[0], db: Parameters<typeof createGroup>[1]): Promise<SimGroup> {
    const grp = await vetsWorld(request, db);
    await db.run(`UPDATE "Organisation" SET "squadMode" = 'monthly', "paygPricePence" = 800 WHERE id = $1`, [grp.orgId]);
    const kickoff = (await db.one<{ date: Date }>(`SELECT date FROM "Match" WHERE id = $1`, [grp.matchId!]))!.date;
    const monthStart = `${formatInTimeZone(new Date(kickoff), "Europe/London", "yyyy-MM")}-01`;
    const monthId = `${grp.orgId}-month`;
    await db.run(
      `INSERT INTO "SquadMonth" (id, "orgId", "activityId", "monthStart", status, "gamesScheduled", "gamesPlayedBeforeStart",
                                 "startedMidMonthAt", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4::date, 'running', 4, 0, now() - interval '2 days', now() - interval '2 days', now())`,
      [monthId, grp.orgId, grp.activityId, monthStart],
    );
    for (const [i, a] of IN_14.entries()) {
      await db.run(
        `INSERT INTO "SquadMonthMember" (id, "monthId", "userId", kind, slot, "gamesCovered", source, "updatedAt")
         VALUES ($1, $2, $3, 'regular', $4, 4, 'seed-list', now())`,
        [`${monthId}-${a.key}`, monthId, grp.player(a.key).userId, i + 1],
      );
    }
    return grp;
  }

  test("the incident in a monthly club: 14 places, Luca on the bench, Zak in, teams made, exactly one post", async ({ request, db }) => {
    const grp = (await monthlyVets(request, db)).attach(request);
    arm(INCIDENT, ["other_att", "admin_ops", "balancer"]);

    const res = await grp.postBatch([{ player: "ava", body: INCIDENT, tag: true }]);

    expect(await maxPlayers(grp)).toBe(14);
    expect(await grp.attendanceOf("luca")).toMatchObject({ status: "BENCH" });
    expect(await grp.attendanceOf("zak")).toMatchObject({ status: "CONFIRMED" });
    const sheet = await teamSheet(grp);
    expect(sheet).toHaveLength(14);
    expect(sheet).toContain(grp.player("zak").userId);
    expect(sheet).not.toContain(grp.player("luca").userId);

    const reply = res.results[0].reply ?? "";
    console.log(`[multi-instruction] monthly, the one reply:\n${reply}\n[posts] ${JSON.stringify(res.groupPosts)} [dms] ${JSON.stringify(res.dms)}`);
    expectOnlyTheReply(res);

    const blocks = reply.split("\n\n");
    expect(blocks[0]).toMatch(/^✅ Done: \w+ is 7-a-side now, 14 places\.$/);
    expect(blocks[1]).toBe("*Bench (1):*\n1. Luca Lane");
    expect(blocks[2]).toMatch(/^⚽ \*Teams for tonight\*/);
    expect(reply).toContain("Zak Zephyr");
    expect(reply).not.toMatch(/\[SQUAD\]|couldn't do|teams are cleared/);
  });

  test("a monthly club, switch and bench with no teams: the one reply is the list after both parts", async ({ request, db }) => {
    const grp = (await monthlyVets(request, db)).attach(request);
    const body = "@Match Time switch to 7aside and take Luca to the bench";
    setRouterStub({ floor: false, bodies: { [body]: ["other_att", "admin_ops"] } });
    setExtractorStub({
      byExtractor: {
        attendance: { [body]: { claims: [claim({ personRef: "Luca", polarity: "bench" })], affirmation: "none", sideRequests: [] } },
        admin: { [body]: SWITCH_7 },
      },
    });

    const res = await grp.postBatch([{ player: "ava", body, tag: true }]);

    expect(await maxPlayers(grp)).toBe(14);
    expect(await grp.attendanceOf("luca")).toMatchObject({ status: "BENCH" });
    const reply = res.results[0].reply ?? "";
    console.log(`[multi-instruction] monthly, no teams:\n${reply}\n[posts] ${JSON.stringify(res.groupPosts)} [dms] ${JSON.stringify(res.dms)}`);
    expectOnlyTheReply(res);

    expect(reply.split("\n\n")[0]).toMatch(/^✅ Done: \w+ is 7-a-side now, 14 places\.$/);
    expect(reply).toContain("Luca Lane");
    expect(reply).not.toMatch(/\[SQUAD\]|couldn't do/);
  });
});

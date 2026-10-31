/**
 * TEAMS PROPOSED AND APPROVED IN THE ADMIN GROUP (2026-10-14), against a
 * real Postgres, the real admin-group route and the real due-posts poll.
 * No model is called: since 2026-10-16 an organiser's words go through the
 * SHARED router and teams extractor, which are STUBBED here (`hqStubs`:
 * what the model would have read), and everything after them is the
 * shipped code, the safe-YES rule included. The shared generator's rating
 * adjuster has no API key in this suite (it falls back to the base
 * ratings, as it does on any failure).
 *
 * The fixture club (E2E Test FC, weekly) plays TODAY at 22:00 London here,
 * 2-a-side so the real balancer builds from the seeded four confirmed:
 * Alex Admin (OWNER), Colin Collector, Pat Player, Tom Third; Ben Bench on
 * the bench. Its admin group is linked and admin notices go there.
 *
 * The club's organisers announce the list and teams ("listAnnouncer" =
 * 'organisers') and "Teams ready" is not set, so its default, 10:00,
 * applies.
 *
 * Pinned: the "Teams ready" proposal at 10:00, once; the commands writing
 * TeamAssignment; one question at a time with a pasted list; the reminder
 * at kickoff minus 2 hours; YES making the teams final with NOTHING posted
 * in the players' group; a drop-out after approval told to the admin group.
 */
import { test, expect, resetDb } from "../fixtures";
import { MATCH, ORG_ID, PHONE, SPORT_ID, U, londonAt } from "../helpers/constants";
import { E2E } from "../helpers/env";
import { clearHqSquadReaderStub, clearPipelineStubs, engineOn, setHqSquadReaderStub, squadReading, teamsFacts } from "../helpers/stub";
import type { TestDb } from "../helpers/test-db";
import type { APIRequestContext } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const KEY = { "x-api-key": E2E.WHATSAPP_API_KEY };
const HQ = "120363777000000041@g.us";
const ADMIN = PHONE.admin.replace(/^\+/, "");
const PLAYER = PHONE.player.replace(/^\+/, "");
const KICKOFF = londonAt(0, 22, 0);

let seq = 0;
// Tagged by default: HQ answers only the Pi's real mention flag (2026-10-31);
// the untagged cases pass `tagged` false.
async function say(request: APIRequestContext, text: string, senderPhone = ADMIN, tagged = true) {
  const res = await request.post("/api/whatsapp/admin-group", {
    headers: KEY,
    data: { channel: "admin-group", groupId: HQ, messageId: `e2e-agt-${++seq}`, text, senderPhone, botMentioned: tagged, timestamp: String(Math.floor(Date.now() / 1000)) },
  });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

/** A real, claiming due-posts poll from a Pi that can post in admin groups. */
async function poll(request: APIRequestContext, at: Date) {
  const res = await request.get(`/api/whatsapp/due-posts?groupId=${encodeURIComponent(E2E.GROUP_ID)}`, {
    headers: { ...KEY, "x-test-now": at.toISOString(), "x-mt-pi-caps": "admin-group" },
  });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()).instructions as Array<{ kind: string; groupId?: string; text?: string }>;
}

type Instruction = { kind: string; groupId?: string; text?: string };
const teamText = (ins: Instruction[], re: RegExp) => ins.filter((i) => re.test(i.text ?? ""));

const sheet = (db: TestDb) =>
  db.all<{ id: string; userId: string; team: string }>(
    `SELECT id, "userId", team::text AS team FROM "TeamAssignment" WHERE "matchId" = $1 ORDER BY id`,
    [MATCH.upcoming],
  );
const teamOf = async (db: TestDb, userId: string) => (await sheet(db)).find((r) => r.userId === userId)?.team;
const status = async (db: TestDb) =>
  (await db.one<{ v: string }>(`SELECT status::text AS v FROM "Match" WHERE id = $1`, [MATCH.upcoming]))?.v;
/** Anything queued for the PLAYERS' group. */
const playersGroupJobs = (db: TestDb) => db.count(`SELECT count(*) FROM "BotJob" WHERE "orgId" = $1 AND kind = 'group'`, [ORG_ID]);

test.beforeAll(async ({ db }) => {
  resetDb();
  await db.run(
    `UPDATE "Organisation" SET "adminGroupId" = $2, "adminChannelMode" = 'admin-group', "teamsReadyTime" = NULL, "listAnnouncer" = 'organisers' WHERE id = $1`,
    [ORG_ID, HQ],
  );
  await db.run(`UPDATE "Sport" SET "playersPerTeam" = 2 WHERE id = $1`, [SPORT_ID]);
  // ISO strings: the columns hold UTC without a zone.
  await db.run(`UPDATE "Match" SET date = $2, "attendanceDeadline" = $3 WHERE id = $1`, [
    MATCH.upcoming,
    KICKOFF.toISOString(),
    new Date(KICKOFF.getTime() - 5 * 60 * 60 * 1000).toISOString(),
  ]);
});

/** What the shared router and teams extractor read from each message. */
function hqStubs(extra: Parameters<typeof engineOn>[0] = {}) {
  engineOn({
    teams: { route: "balancer", facts: teamsFacts("show") },
    "takımlar": { route: "balancer", facts: teamsFacts("show") },
    reshuffle: { route: "balancer", facts: teamsFacts("generate") },
    "@Match Time reshuffle": { route: "balancer", facts: teamsFacts("generate") },
    "move Pat": { route: "balancer", facts: teamsFacts("swap", ["Pat"]) },
    "move Zed": { route: "balancer", facts: teamsFacts("swap", ["Zed"]) },
    "Zed'i taşı": { route: "balancer", facts: teamsFacts("swap", ["Zed"]) },
    "@Match Time teams": { route: "balancer", facts: teamsFacts("show") },
    "Pat & Tom in the same team": { route: "balancer", facts: teamsFacts("swap", [], { pairings: [["Pat", "Tom"]] }) },
    "swap everyone on red with yellow": { route: "balancer", facts: teamsFacts("swap", [], { swapSides: true }) },
    "swap all four": { route: "balancer", facts: teamsFacts("swap", ["Alex", "Colin", "Pat", "Tom"]) },
    "swap Alex, Colin and Zed": { route: "balancer", facts: teamsFacts("swap", ["Alex", "Colin", "Zed"]) },
    "Alex and Pat on one team": { route: "balancer", facts: teamsFacts("swap", [], { pairings: [["Alex", "Pat"]] }) },
    "recommend swaps": { route: "balancer", facts: teamsFacts("suggest") },
    "graphic please": { route: "team_sheet" },
    "@Match Time graphic please": { route: "team_sheet" },
    YES: { route: "approve" },
    yes: { route: "approve" },
    ...extra,
  });
}

test.beforeEach(() => hqStubs());

test.afterAll(() => {
  clearPipelineStubs();
  clearHqSquadReaderStub();
  resetDb();
});

test("before 10:00 London nothing is proposed", async ({ request, db }) => {
  const ins = await poll(request, londonAt(0, 9, 30));
  expect(teamText(ins, /Proposed teams/)).toEqual([]);
  expect(await sheet(db)).toEqual([]);
});

test("at 10:00 London: teams built and proposed in the admin group, once, nothing to the players", async ({ request, db }) => {
  const ins = await poll(request, londonAt(0, 10, 5));
  const proposed = teamText(ins, /Proposed teams/);
  expect(proposed).toHaveLength(1);
  expect(proposed[0]).toMatchObject({ kind: "admin-group-message", groupId: HQ });
  expect(proposed[0].text).toContain("Reply *YES* when they are final. I won't post them in the players' group.");
  expect(await sheet(db)).toHaveLength(4);
  expect(await status(db)).toBe("TEAMS_GENERATED");
  expect(await playersGroupJobs(db)).toBe(0);
  // Nothing in the players' group from this poll either.
  expect(ins.filter((i) => i.kind === "group-message" && /Proposed teams|Final teams|Teams for tonight/.test(i.text ?? ""))).toEqual([]);

  expect(teamText(await poll(request, londonAt(0, 10, 10)), /Proposed teams/)).toEqual([]);
});

test("a non-admin's '@Match Time teams' in the admin group changes nothing: one line naming who can (2026-10-20)", async ({ request, db }) => {
  const before = await sheet(db);
  expect(await say(request, "@Match Time teams", PLAYER)).toMatchObject({ handled: true, outcome: "hq-only-organisers", replyText: "Only Alex can change that.", react: null });
  expect(await sheet(db)).toEqual(before);
});

test("a non-admin's untagged teams talk: silent, nothing changed (2026-10-29, FNF HQ)", async ({ request, db }) => {
  const before = await sheet(db);
  expect(await say(request, "Pat & Tom in the same team", PLAYER, false)).toMatchObject({ handled: false, replyText: null });
  expect(await sheet(db)).toEqual(before);
});

test("'teams' shows the teams already built, without rebuilding them", async ({ request, db }) => {
  const before = await sheet(db);
  const out = await say(request, "teams");
  expect(out).toMatchObject({ handled: true, outcome: "teams-shown" });
  expect(out.replyText).toContain("📝 *Proposed teams*");
  expect(await sheet(db)).toEqual(before);
});

// 2026-10-30, Kemal: new teams only when MatchTime is asked by fact.
test("an untagged 'reshuffle': nothing rebuilt, nothing said", async ({ request, db }) => {
  const before = await sheet(db);
  expect(await say(request, "reshuffle", ADMIN, false)).toMatchObject({ handled: false, replyText: null });
  expect(await sheet(db)).toEqual(before);
});

test("'@Match Time reshuffle' rebuilds them", async ({ request, db }) => {
  const out = await say(request, "@Match Time reshuffle");
  expect(out).toMatchObject({ handled: true, outcome: "teams-built" });
  expect(await sheet(db)).toHaveLength(4);
});

// 2026-10-29, FNF HQ: nine names, eight swaps on eight lines and "swap them
// over" were all "Which players?"; "Ali and Habib on one team" reshuffled.
test("the two sides swapped over: every player changes side, one reply", async ({ request, db }) => {
  const before = await sheet(db);
  const out = await say(request, "swap everyone on red with yellow");
  expect(out).toMatchObject({ handled: true, outcome: "teams-changed" });
  for (const r of before) expect(await teamOf(db, r.userId)).toBe(r.team === "RED" ? "YELLOW" : "RED");
  expect(out.replyText).toContain("📝 *Proposed teams*");
});

test("four names in one message: all four change side as one change", async ({ request, db }) => {
  const before = await sheet(db);
  expect(await say(request, "swap all four")).toMatchObject({ handled: true, outcome: "teams-changed" });
  for (const r of before) expect(await teamOf(db, r.userId)).toBe(r.team === "RED" ? "YELLOW" : "RED");
});

test("one name in the change that is nobody: the whole change refused, naming it, nothing written", async ({ request, db }) => {
  const before = await sheet(db);
  expect(await say(request, "swap Alex, Colin and Zed")).toMatchObject({ handled: true, outcome: "teams-name-unclear", replyText: "I can't find Zed in the teams." });
  expect(await sheet(db)).toEqual(before);
});

test("'Alex and Pat on one team': a targeted change, never a reshuffle, the sides still 2 v 2", async ({ request, db }) => {
  const out = await say(request, "Alex and Pat on one team");
  expect(["teams-changed", "teams-unchanged"]).toContain(out.outcome);
  expect(await teamOf(db, U.admin)).toBe(await teamOf(db, U.player));
  const rows = await sheet(db);
  expect(rows.filter((r) => r.team === "RED")).toHaveLength(2);
  expect(rows).toHaveLength(4);
});

test("'recommend swaps': a suggestion, or that one swap cannot do better", async ({ request }) => {
  const out = await say(request, "recommend swaps");
  expect(["teams-suggested", "teams-suggest-none"]).toContain(out.outcome);
  if (out.outcome === "teams-suggested") expect(out.replyText).toMatch(/^My suggestion, to even the ratings: swap .+ and .+\./);
});

test("'swap A B' swaps two players in TeamAssignment and reposts", async ({ request, db }) => {
  const rows = await sheet(db);
  const red = rows.find((r) => r.team === "RED")!;
  const yellow = rows.find((r) => r.team === "YELLOW")!;
  const name = async (id: string) => (await db.one<{ name: string }>(`SELECT name FROM "User" WHERE id = $1`, [id]))!.name;
  const [a, b] = [await name(red.userId), await name(yellow.userId)];
  hqStubs({ [`swap ${a} with ${b}`]: { route: "balancer", facts: teamsFacts("swap", [a, b]) } });
  const out = await say(request, `swap ${a} with ${b}`);
  expect(out).toMatchObject({ handled: true, outcome: "teams-swapped" });
  expect(await teamOf(db, red.userId)).toBe("YELLOW");
  expect(await teamOf(db, yellow.userId)).toBe("RED");
  expect(out.replyText).toContain("📝 *Proposed teams*");
});

test("'move Pat' moves one player to the other team", async ({ request, db }) => {
  const was = await teamOf(db, U.player);
  const out = await say(request, "move Pat");
  expect(out).toMatchObject({ handled: true, outcome: "teams-moved" });
  expect(await teamOf(db, U.player)).toBe(was === "RED" ? "YELLOW" : "RED");
  // Four players, now 3 v 1: the proposal says so.
  expect(out.replyText).toMatch(/⚠️ The sides are uneven: Red [13], Yellow [13]\./);
});

test("a name not on the teams: one short line, nothing changed", async ({ request, db }) => {
  const before = await sheet(db);
  expect(await say(request, "move Zed")).toMatchObject({ handled: true, outcome: "teams-name-unclear", replyText: "I can't find Zed in the teams." });
  expect(await sheet(db)).toEqual(before);
});

test("one question at a time: a pasted list sets the teams aside; 'teams' asks again and the list is dropped", async ({ request, db }) => {
  const list = ["1. Alex Admin", "2. Colin Collector", "3. Pat Player", "4. Ben Bench"].join("\n");
  // The HQ squad reader (stubbed, 2026-10-29) reads it as the squad: Ben
  // in, Tom left off on purpose.
  setHqSquadReaderStub({ bodies: { [list]: squadReading(["Alex Admin", "Colin Collector", "Pat Player", "Ben Bench"], { out: ["Tom Third"] }) } });
  // The router sends it to the squad first (2026-10-30), then the reader reads it.
  hqStubs({ [list]: { route: "other_att" } });
  const pasted = await say(request, list);
  expect(pasted).toMatchObject({ handled: true, outcome: "paste-proposed" });
  expect(pasted.replyText).toMatch(/Reply YES to apply\. The teams still need approving: ask me for them again after this, in your own words \(for example \*show me the teams\*\)\.$/);

  const again = await say(request, "teams");
  expect(again.replyText.startsWith("The list pasted earlier was not applied.")).toBe(true);
  const list2 = await db.one<{ outcome: string }>(`SELECT outcome FROM "AdminSquadProposal" WHERE "orgId" = $1 ORDER BY "createdAt" DESC LIMIT 1`, [ORG_ID]);
  expect(list2?.outcome).toBe("superseded");
});

test("kickoff minus 2 hours with nobody approving: one reminder in the admin group", async ({ request }) => {
  expect(teamText(await poll(request, londonAt(0, 19, 55)), /aren't final yet/)).toEqual([]);
  const ins = await poll(request, londonAt(0, 20, 1));
  const reminder = teamText(ins, /aren't final yet/);
  expect(reminder).toHaveLength(1);
  expect(reminder[0]).toMatchObject({
    kind: "admin-group-message",
    text: "⏰ The teams for 22:00 aren't final yet. Ask me to show them, in your own words (for example *show me the teams*), then reply *YES*.",
  });
  expect(teamText(await poll(request, londonAt(0, 20, 30)), /aren't final yet/)).toEqual([]);
});

test("YES on uneven sides ('move Pat' left 3 v 1): asked again, nothing final yet", async ({ request, db }) => {
  const out = await say(request, "YES");
  expect(out).toMatchObject({ handled: true, outcome: "teams-uneven" });
  expect(out.replyText).toMatch(
    /^The sides are uneven: Red [13], Yellow [13]\. Reply \*YES\* again to make them final as they are, or first tell me who to move, in your own words\.$/,
  );
  expect(await status(db)).not.toBe("TEAMS_PUBLISHED");
});

test("the second YES: 'Teams are final.', TEAMS_PUBLISHED, nothing posted in the players' group, the list not applied", async ({ request, db }) => {
  const out = await say(request, "YES");
  expect(out).toEqual(expect.objectContaining({ handled: true, outcome: "teams-final", replyText: "Teams are final." }));
  expect(await status(db)).toBe("TEAMS_PUBLISHED");
  expect(await playersGroupJobs(db)).toBe(0);
  // No team sheet picture on its own (Kemal, 2026-10-30): only when asked, tagged.
  const graphics = await db.all<{ text: string }>(
    `SELECT text FROM "BotJob" WHERE "orgId" = $1 AND kind = 'admin-group' AND text LIKE 'Ready to post:%teams%'`,
    [ORG_ID],
  );
  expect(graphics).toHaveLength(0);
  // Tom is still in: the superseded list was never applied.
  const tom = await db.one<{ status: string }>(`SELECT status FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`, [MATCH.upcoming, U.third]);
  expect(tom?.status).toBe("CONFIRMED");
  // A second YES finds nothing waiting, and says nothing.
  expect(await say(request, "yes", ADMIN, false)).toMatchObject({ handled: false, replyText: null });
});

test("an untagged 'graphic please': nothing drawn; '@Match Time graphic please': one team sheet, asked (2026-10-30)", async ({ request, db }) => {
  const sheets = () =>
    db.all<{ text: string; opts: string[] }>(
      `SELECT text, "pollOptions" AS opts FROM "BotJob" WHERE "orgId" = $1 AND kind = 'admin-group' AND text LIKE 'Ready to post:%teams%'`,
      [ORG_ID],
    );
  expect(await say(request, "graphic please", ADMIN, false)).toMatchObject({ handled: false, replyText: null });
  expect(await sheets()).toHaveLength(0);
  await say(request, "@Match Time graphic please");
  const out = await sheets();
  expect(out).toHaveLength(1);
  expect(out[0].opts[3]).toBe("asked");
  // Final teams: the caption as before, no "not approved yet".
  expect(out[0].text).not.toContain("not approved");
});

test("after approval, a drop-out is told to the admin group once, with the teams; no team sheet picture on its own (2026-10-30)", async ({ request, db }) => {
  // The approved team sheet went out (the Pi's ack), as at FNF on 2026-10-16.
  await db.run(`UPDATE "BotJob" SET "sentAt" = now() WHERE "orgId" = $1 AND text LIKE 'Ready to post:%teams%'`, [ORG_ID]);
  await db.run(`UPDATE "Attendance" SET status = 'DROPPED' WHERE "matchId" = $1 AND "userId" = $2`, [MATCH.upcoming, U.third]);
  const ins = await poll(request, londonAt(0, 20, 40));
  const notice = teamText(ins, /Team change/);
  expect(notice).toHaveLength(1);
  expect(notice[0].kind).toBe("admin-group-message");
  expect(notice[0].text).toMatch(/Tom Third is out, (Red|Yellow) has a place open\./);
  expect(notice[0].text).toContain("✅ *Final teams*");

  // Kemal, 2026-10-30: the team sheet only when asked, tagged. The change is
  // told; no picture is queued.
  const waiting = () =>
    db.all<{ id: string }>(
      `SELECT id FROM "BotJob" WHERE "orgId" = $1 AND kind = 'admin-group' AND text LIKE 'Ready to post:%teams%' AND "sentAt" IS NULL`,
      [ORG_ID],
    );
  expect(await waiting()).toHaveLength(0);
  expect(teamText(ins, /Ready to post/)).toEqual([]);
  await db.run(`UPDATE "Attendance" SET status = 'CONFIRMED' WHERE "matchId" = $1 AND "userId" = $2`, [MATCH.upcoming, U.third]);
  const at41 = await poll(request, londonAt(0, 20, 41));
  expect(teamText(at41, /Team change/)).toHaveLength(1);
  const at45 = await poll(request, londonAt(0, 20, 45));
  expect(teamText(at45, /Ready to post/)).toEqual([]);
  expect(await waiting()).toHaveLength(0);
  expect(await playersGroupJobs(db)).toBe(0);
});

test("a Turkish club gets Turkish", async ({ request, db }) => {
  await db.run(`UPDATE "Organisation" SET language = 'tr' WHERE id = $1`, [ORG_ID]);
  const out = await say(request, "takımlar");
  expect(out.replyText).toContain("✅ *Kesin takımlar*");
  expect((await say(request, "Zed'i taşı")).replyText).toBe("Zed takımlarda yok.");
  await db.run(`UPDATE "Organisation" SET language = 'en' WHERE id = $1`, [ORG_ID]);
});

test("MatchTime announces and nothing is stored: Teams ready is off, nothing is proposed", async ({ request, db }) => {
  await db.run(`UPDATE "Organisation" SET "listAnnouncer" = 'matchtime', "teamsReadyTime" = NULL WHERE id = $1`, [ORG_ID]);
  await db.run(`DELETE FROM "AdminTeamProposal" WHERE "orgId" = $1`, [ORG_ID]);
  await db.run(`DELETE FROM "TeamAssignment" WHERE "matchId" = $1`, [MATCH.upcoming]);
  await db.run(`UPDATE "Match" SET status = 'UPCOMING' WHERE id = $1`, [MATCH.upcoming]);
  await db.run(`UPDATE "Attendance" SET status = 'CONFIRMED' WHERE "matchId" = $1 AND "userId" = $2`, [MATCH.upcoming, U.third]);
  expect(teamText(await poll(request, londonAt(0, 12, 0)), /Proposed teams/)).toEqual([]);
  expect(await sheet(db)).toEqual([]);
});

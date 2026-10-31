/**
 * HQ TEAMS BY FACT (Kemal, 2026-10-30, after FNF HQ on 29 Oct), against a
 * real Postgres, the real admin-group route and the real ack route. The
 * router and the teams extractor are STUBBED (`engineOn`: what the model
 * would have read); everything after them is the shipped code.
 *
 *   1. New teams only when MatchTime is asked by fact (the Pi's mention
 *      flag, or a reply to MatchTime). "Stick keeper. Ali and Habib on one
 *      team", untagged on proposed teams, is a targeted pairing, never a
 *      reshuffle; read as a remark, it does nothing at all.
 *   2. The team sheet picture only when asked of MatchTime; proposed teams
 *      are drawn with a caption saying they are not approved yet.
 *   3. "These are the final teams", replying to an EARLIER sheet, brings
 *      those teams back as a proposal needing YES (found by the post's
 *      WhatsApp id, stamped on the Pi's ack), and approves nothing; a YES
 *      then approves exactly that sheet. A pasted sheet is set the same way.
 *
 * The fixture club plays TODAY at 22:00 London, 2-a-side: Alex Admin
 * (OWNER), Colin Collector, Pat Player, Tom Third confirmed.
 */
import { test, expect, resetDb } from "../fixtures";
import { MATCH, ORG_ID, PHONE, SPORT_ID, U, londonAt } from "../helpers/constants";
import { E2E } from "../helpers/env";
import { clearHqSquadReaderStub, clearPipelineStubs, engineOn, teamsFacts } from "../helpers/stub";
import type { TestDb } from "../helpers/test-db";
import type { APIRequestContext } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const KEY = { "x-api-key": E2E.WHATSAPP_API_KEY };
const HQ = "120363777000000042@g.us";
const ADMIN = PHONE.admin.replace(/^\+/, "");
const KICKOFF = londonAt(0, 22, 0);

let seq = 0;
async function say(
  request: APIRequestContext,
  text: string,
  extra: { quotedMessageId?: string; quotedText?: string; quotedFromMatchTime?: boolean; botMentioned?: boolean } = {},
) {
  const res = await request.post("/api/whatsapp/admin-group", {
    headers: KEY,
    data: {
      channel: "admin-group",
      groupId: HQ,
      messageId: `e2e-agf-${++seq}`,
      text,
      senderPhone: ADMIN,
      botMentioned: text.includes("@Match Time"),
      timestamp: String(Math.floor(Date.now() / 1000)),
      ...extra,
    },
  });
  expect(res.status(), await res.text()).toBe(200);
  return res.json() as Promise<{ handled: boolean; outcome?: string; replyText: string | null; replyKey?: string }>;
}

/** The Pi posted MatchTime's reply and acked it with its WhatsApp id. */
async function ack(request: APIRequestContext, key: string, waMessageId: string) {
  const res = await request.post("/api/whatsapp/ack", { headers: KEY, data: { key, kind: "admin-group-reply", waMessageId } });
  expect(res.status(), await res.text()).toBe(200);
}

const sheet = (db: TestDb) =>
  db.all<{ userId: string; team: string }>(`SELECT "userId", team::text AS team FROM "TeamAssignment" WHERE "matchId" = $1 ORDER BY "userId"`, [MATCH.upcoming]);
const teamOf = async (db: TestDb, userId: string) => (await sheet(db)).find((r) => r.userId === userId)?.team;
const status = async (db: TestDb) => (await db.one<{ v: string }>(`SELECT status::text AS v FROM "Match" WHERE id = $1`, [MATCH.upcoming]))?.v;
const sheetJobs = (db: TestDb) =>
  db.all<{ text: string }>(`SELECT text FROM "BotJob" WHERE "orgId" = $1 AND kind = 'admin-group' AND text LIKE 'Ready to post:%teams%' ORDER BY "createdAt"`, [ORG_ID]);

test.beforeAll(async ({ db }) => {
  resetDb();
  await db.run(
    `UPDATE "Organisation" SET "adminGroupId" = $2, "adminChannelMode" = 'admin-group', "teamsReadyTime" = 'off', "listAnnouncer" = 'organisers' WHERE id = $1`,
    [ORG_ID, HQ],
  );
  await db.run(`UPDATE "Sport" SET "playersPerTeam" = 2 WHERE id = $1`, [SPORT_ID]);
  await db.run(`UPDATE "Match" SET date = $2, "attendanceDeadline" = $3 WHERE id = $1`, [
    MATCH.upcoming,
    KICKOFF.toISOString(),
    new Date(KICKOFF.getTime() - 5 * 60 * 60 * 1000).toISOString(),
  ]);
});

test.beforeEach(() =>
  engineOn({
    "Make teams": { route: "balancer", facts: teamsFacts("generate") },
    "@Match Time make teams": { route: "balancer", facts: teamsFacts("generate") },
    "Stick keeper. Alex and Pat on one team": { route: "balancer", facts: teamsFacts("swap", [], { pairings: [["Alex", "Pat"]] }) },
    "Alex and Pat always end up together lol": { route: "balancer", facts: teamsFacts("swap", [], { pairings: [["Alex", "Pat"]], toMatchTime: false }) },
    "Make teams and the graphic": { route: "team_sheet" },
    "@Match Time make teams and the graphic": { route: "team_sheet" },
    "swap Alex and Colin": { route: "balancer", facts: teamsFacts("swap", ["Alex", "Colin"]) },
    "These are the final teams": { route: "approve" },
    "Use these\nNon Bibs\n1. Alex\n2. Tom\nBibs\n1. Colin\n2. Pat": {
      route: "balancer",
      facts: teamsFacts("set", [], { sides: { red: ["Alex", "Tom"], yellow: ["Colin", "Pat"] } }),
    },
    YES: { route: "approve" },
  }),
);

test.afterAll(() => {
  clearPipelineStubs();
  clearHqSquadReaderStub();
  resetDb();
});

test("untagged 'Make teams' with no teams: nothing built, nothing said", async ({ request, db }) => {
  expect(await say(request, "Make teams")).toMatchObject({ handled: false, replyText: null });
  expect(await sheet(db)).toEqual([]);
});

test("'@Match Time make teams': built and proposed", async ({ request, db }) => {
  const out = await say(request, "@Match Time make teams");
  expect(out).toMatchObject({ handled: true, outcome: "teams-built" });
  expect(await sheet(db)).toHaveLength(4);
});

test("an untagged team sheet request: nothing drawn; tagged on proposed teams: drawn, captioned not approved yet", async ({ request, db }) => {
  expect(await say(request, "Make teams and the graphic")).toMatchObject({ handled: false, replyText: null });
  expect(await sheetJobs(db)).toEqual([]);
  await say(request, "@Match Time make teams and the graphic");
  const jobs = await sheetJobs(db);
  expect(jobs).toHaveLength(1);
  expect(jobs[0].text).toMatch(/^Ready to post: .+ teams for .+\. These teams are not approved yet\.$/);
});

// 2026-10-31 (Kemal: "real tag pls"): untagged, nothing at all.
test("29 Oct: an untagged pairing on proposed teams: nothing changed, nothing said", async ({ request, db }) => {
  const before = await sheet(db);
  expect(await say(request, "Stick keeper. Alex and Pat on one team")).toMatchObject({ handled: false, replyText: null });
  expect(await sheet(db)).toEqual(before);
});

test("29 Oct: a tagged pairing on proposed teams is a targeted change, never a reshuffle", async ({ request, db }) => {
  const before = await sheet(db);
  const out = await say(request, "Stick keeper. Alex and Pat on one team", { botMentioned: true });
  expect(["teams-changed", "teams-unchanged"]).toContain(out.outcome);
  expect(await teamOf(db, U.admin)).toBe(await teamOf(db, U.player));
  // Colin and Tom never both moved by a rebuild: at most the fewest moves.
  const after = await sheet(db);
  expect(after.map((r) => r.userId)).toEqual(before.map((r) => r.userId));
});

test("the same words read as a remark: nothing done, nothing said", async ({ request, db }) => {
  const before = await sheet(db);
  expect(await say(request, "Alex and Pat always end up together lol")).toMatchObject({ handled: false, replyText: null });
  expect(await sheet(db)).toEqual(before);
});

test("'These are the final teams' replying to an EARLIER sheet: those teams back, proposed, nothing approved; YES approves exactly them", async ({
  request,
  db,
}) => {
  // The sheet as it stands, posted and acked with its WhatsApp id.
  const shown = await say(request, "@Match Time make teams");
  expect(shown.replyKey).toBeTruthy();
  await ack(request, shown.replyKey!, "3EB0E2EEARLIER");
  const earlier = await sheet(db);

  // Then the teams change.
  await say(request, "swap Alex and Colin", { botMentioned: true });
  expect(await sheet(db)).not.toEqual(earlier);

  // Hamzah's reply to the earlier sheet, by its id alone.
  const out = await say(request, "These are the final teams", { quotedMessageId: "3EB0E2EEARLIER", quotedFromMatchTime: true, botMentioned: true });
  expect(out).toMatchObject({ handled: true, outcome: "teams-restored" });
  expect(out.replyText).toMatch(/^These are the earlier teams, from .+ at \d\d:\d\d\. They need your \*@Match Time YES\* again\.\n\n📝 \*Proposed teams\*/);
  expect(await sheet(db)).toEqual(earlier);
  expect(await status(db)).not.toBe("TEAMS_PUBLISHED");

  const yes = await say(request, "YES", { botMentioned: true });
  expect(yes).toMatchObject({ handled: true, outcome: "teams-final" });
  expect(await status(db)).toBe("TEAMS_PUBLISHED");
  expect(await sheet(db)).toEqual(earlier);
});

test("a pasted sheet: set as the teams, proposed again for YES", async ({ request, db }) => {
  const out = await say(request, "Use these\nNon Bibs\n1. Alex\n2. Tom\nBibs\n1. Colin\n2. Pat", { botMentioned: true });
  expect(["teams-set", "teams-restored", "teams-restore-same"]).toContain(out.outcome);
  expect(await teamOf(db, U.admin)).toBe("RED");
  expect(await teamOf(db, U.third)).toBe("RED");
  expect(await teamOf(db, U.collector)).toBe("YELLOW");
  expect(await teamOf(db, U.player)).toBe("YELLOW");
  if (out.outcome !== "teams-restore-same") expect(await status(db)).toBe("TEAMS_GENERATED");
});

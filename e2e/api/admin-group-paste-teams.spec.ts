/**
 * A LIST PASTED IN HQ IS READ BY THE MODEL, AND THE TEAMS ARE NEVER A SQUAD
 * CHANGE (FNF HQ, 29 Oct 2026, traced), against a real Postgres and the
 * real admin-group route.
 *
 * 18:04: an organiser pasted MatchTime's own "Proposed teams" sheet back
 * ("Here's the teams:", Non Bibs 1 to 9, Bibs 1 to 9). The string reader
 * that stood in front of HQ's pipeline read the restarted numbering as the
 * end of the squad and proposed "Removing" the 9 Bibs; "Yes" 8 seconds
 * later dropped 9 confirmed players. 18:37: "Swap / 9 names / With / 9
 * names" was proposed with new players called "Swap" and "With".
 *
 * Now the HQ squad reader (a model, STUBBED here with what it would say)
 * reads the message with the squad, the teams and the recent HQ messages,
 * and the fact gates hold whatever it says. Everything from the reading on
 * is the shipped code. The router is stubbed too (`engineOn`): what is not
 * the squad goes on to it.
 *
 * The fixture club (E2E Test FC, weekly) has its upcoming match at 4 of 5:
 * Alex Admin (OWNER), Colin Collector, Pat Player, Tom Third; Ben Bench on
 * the bench. Teams are made here: Red Alex and Colin, Yellow Pat and Tom.
 */
import { readFileSync } from "node:fs";
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import { MATCH, ORG_ID, PHONE, U } from "../helpers/constants";
import { E2E } from "../helpers/env";
import { clearHqSquadReaderStub, clearPipelineStubs, engineOn, setHqSquadReaderStub, squadReading } from "../helpers/stub";
import type { TestDb } from "../helpers/test-db";

test.describe.configure({ mode: "serial" });

const KEY = { "x-api-key": E2E.WHATSAPP_API_KEY };
const HQ = "120363777000000071@g.us";
const ADMIN = PHONE.admin.replace(/^\+/, "");

let seq = 0;
async function say(request: APIRequestContext, text: string, extra: Record<string, unknown> = {}) {
  const res = await request.post("/api/whatsapp/admin-group", {
    headers: KEY,
    data: { channel: "admin-group", groupId: HQ, messageId: `e2e-apt-${++seq}`, text, senderPhone: ADMIN, timestamp: String(Math.floor(Date.now() / 1000)), ...extra },
  });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

const statusOf = async (db: TestDb, userId: string) =>
  (await db.one<{ status: string }>(`SELECT status FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`, [MATCH.upcoming, userId]))?.status ?? null;
const proposals = (db: TestDb) => db.count(`SELECT count(*) FROM "AdminSquadProposal" WHERE "orgId" = $1`, [ORG_ID]);
const readerCalls = (): string[] => {
  try {
    return readFileSync(`${E2E.HQ_SQUAD_READER_STUB_FILE}.calls`, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => (JSON.parse(l) as { user: string }).user);
  } catch {
    return [];
  }
};

const SHEET = "📝 *Proposed teams*: 22:00 at Hackney Marshes\n\n*Red*:\n1. Alex Admin\n2. Colin Collector\n\n*Yellow*:\n1. Pat Player\n2. Tom Third\n\nReply *YES* when they are final.";
const PASTED_BACK = "Here’s the teams: \n\n*Red*:\n1. Alex Admin\n2. Colin Collector\n\n*Yellow*:\n1. Pat Player\n2. Tom Third";
const SWAP = "Swap \nAlex\nColin\n\nWith \n\nPat\nTom";
const BARE = "Alex\nColin\n\nPat\nTom";
const REAL = "Friday squad\n1. Alex Admin\n2. Colin Collector\n3. Pat Player\n4. Ben Bench";
const SHORT = "Alex Admin\nColin Collector";

test.beforeAll(async ({ db }) => {
  resetDb();
  await db.run(`UPDATE "Organisation" SET "adminGroupId" = $2, "adminChannelMode" = 'admin-group' WHERE id = $1`, [ORG_ID, HQ]);
  // The teams, proposed and waiting for YES, and MatchTime's post of them.
  for (const [i, [userId, team]] of ([[U.admin, "RED"], [U.collector, "RED"], [U.player, "YELLOW"], [U.third, "YELLOW"]] as const).entries()) {
    await db.run(`INSERT INTO "TeamAssignment" (id, "matchId", "userId", team) VALUES ($1, $2, $3, $4::"Team")`, [`e2e-apt-ta-${i}`, MATCH.upcoming, userId, team]);
  }
  await db.run(`INSERT INTO "AdminTeamProposal" (id, "orgId", "matchId", state, "askedAt", "updatedAt") VALUES ('e2e-apt-tp', $1, $2, 'proposed', now(), now())`, [ORG_ID, MATCH.upcoming]);
  await db.run(
    `INSERT INTO "AdminGroupMessage" (id, "orgId", "waMessageId", "fromMatchTime", text, "askRef", "createdAt") VALUES ('e2e-apt-log', $1, 'mt:teams:e2e-apt', true, $2, $3, now())`,
    [ORG_ID, SHEET, `teams:${MATCH.upcoming}`],
  );
  // What the router reads in what goes on to the pipeline (stubbed).
  // The router sends each to the squad (as the live router did, 2026-10-30
  // probe); the HQ squad reader then says what it is.
  engineOn({
    [PASTED_BACK]: { route: "other_att" },
    [SWAP]: { route: "other_att" },
    [BARE]: { route: "other_att" },
    [REAL]: { route: "other_att" },
    [SHORT]: { route: "other_att" },
    YES: { route: "approve" },
  });
  setHqSquadReaderStub({
    bodies: {
      [PASTED_BACK]: { kind: "teams", lines: [], out: [] },
      [SWAP]: { kind: "teams", lines: [], out: [] },
      // Had the model called the bare two blocks the squad: the four team players.
      [BARE]: squadReading(["Alex Admin", "Colin Collector", "Pat Player", "Tom Third"]),
      [REAL]: squadReading(["Alex Admin", "Colin Collector", "Pat Player", "Ben Bench"], { out: ["Tom Third"] }),
      // The old parser's mistake: half the list, the rest not said to be out.
      [SHORT]: squadReading(["Alex Admin", "Colin Collector"]),
    },
  });
});

test.afterAll(() => {
  clearPipelineStubs();
  clearHqSquadReaderStub();
  resetDb();
});

test("18:04: the teams sheet pasted back is read as teams: no squad proposal, nobody dropped", async ({ request, db }) => {
  const out = await say(request, PASTED_BACK);
  expect(String(out.outcome ?? "")).not.toMatch(/^paste-/);
  expect(await proposals(db)).toBe(0);
  for (const u of [U.admin, U.collector, U.player, U.third]) expect(await statusOf(db, u)).toBe("CONFIRMED");
  // The reader read it against the squad, the teams and MatchTime's own post.
  const turn = readerCalls().at(-1) ?? "";
  expect(turn).toContain("THE TEAMS AS MATCHTIME HAS THEM (proposed, still waiting for YES):");
  expect(turn).toMatch(/Red: p\d+ Alex Admin, p\d+ Colin Collector/);
  expect(turn).toContain("MatchTime: 📝 *Proposed teams*");
  expect(turn).toMatch(/Playing \(4\):/);
});

test("18:37: 'Swap / names / With / names' is teams: nobody called Swap or With is ever made", async ({ request, db }) => {
  const out = await say(request, SWAP);
  expect(String(out.outcome ?? "")).not.toMatch(/^paste-/);
  expect(await proposals(db)).toBe(0);
  expect(await db.count(`SELECT count(*) FROM "User" WHERE name IN ('Swap', 'With')`)).toBe(0);
});

test("18:38: the bare two blocks, even read as the squad, are the teams' players: never a squad change", async ({ request, db }) => {
  const out = await say(request, BARE);
  expect(String(out.outcome ?? "")).not.toMatch(/^paste-/);
  expect(await proposals(db)).toBe(0);
});

test("half the list with the rest not said to be out: nobody is taken out, it says who is not on it, no tick", async ({ request, db }) => {
  const out = await say(request, SHORT);
  expect(out).toMatchObject({
    handled: true,
    outcome: "paste-held",
    replyText: "I haven't taken anyone out: 2 players in the squad are not on this list (Pat Player, Tom Third). If any of them are out, tell me who by name.",
    react: null,
  });
  expect(await proposals(db)).toBe(0);
  expect(await statusOf(db, U.player)).toBe("CONFIRMED");
});

test("a real squad list still proposes the right changes, and the YES makes exactly them", async ({ request, db }) => {
  const out = await say(request, REAL);
  expect(out).toMatchObject({ handled: true, outcome: "paste-proposed" });
  expect(out.replyText).toMatch(/^Adding: Ben Bench\. Removing: Tom Third\. Reply YES to apply\./);
  const row = await db.one<{ remove: string[] }>(`SELECT "removeUserIds" AS remove FROM "AdminSquadProposal" WHERE "orgId" = $1 AND "resolvedAt" IS NULL`, [ORG_ID]);
  expect(row?.remove).toEqual([U.third]);

  const yes = await say(request, "YES", { quotedText: out.replyText, quotedFromMatchTime: true });
  expect(yes).toMatchObject({ handled: true, outcome: "paste-applied" });
  expect(await statusOf(db, U.third)).toBe("DROPPED");
  expect(await statusOf(db, U.bench)).toBe("CONFIRMED");
  for (const u of [U.admin, U.collector, U.player]) expect(await statusOf(db, u)).toBe("CONFIRMED");
});

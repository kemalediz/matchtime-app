/**
 * HQ: A PASTED LIST, ITS YES AND THE BENCH PICK ARE OPEN TO EVERYONE IN THE
 * CLUB, AND AN ORGANISERS' JOB ASKED FOR GETS ONE LINE EVEN UNTAGGED
 * (Kemal, 2026-10-20), against a real Postgres and the real route.
 *
 * After #344 opened attendance changes in the admin group to any member of
 * the club, Kemal decided:
 *   1. a member may paste a whole squad list, and may say YES to the list
 *      THEY pasted (an organiser still says YES to anyone's); a member may
 *      answer MatchTime's "who comes off the bench?" pick round;
 *   2. someone who asks, in HQ, for something only an organiser can do
 *      (the fee, a free place, the teams, the players' group ask, a YES to
 *      something that is not theirs) hears the one line naming who can,
 *      tagged or not. Chat the router does not read as such a request
 *      stays silent.
 *
 * The router and extractors are STUBBED (`engineOn`): no model is called.
 *
 * The fixture club (E2E Test FC, weekly) has its upcoming match at 4 of 5:
 * Alex Admin (OWNER, the only organiser), Colin Collector, Pat Player, Tom
 * Third; Ben Bench on the bench. Pat Player and Tom Third are PLAYERS.
 */
import { test, expect, resetDb } from "../fixtures";
import { MATCH, ORG_ID, PHONE, U } from "../helpers/constants";
import { E2E } from "../helpers/env";
import { engineOn, clearPipelineStubs, setHqSquadReaderStub, clearHqSquadReaderStub, squadReading, setOrganiserPickReaderStub } from "../helpers/stub";
import type { TestDb } from "../helpers/test-db";
import type { APIRequestContext } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const KEY = { "x-api-key": E2E.WHATSAPP_API_KEY };
const HQ = "120363777000000072@g.us";
const ADMIN = PHONE.admin.replace(/^\+/, "");
const PLAYER = PHONE.player.replace(/^\+/, "");
const TOM = PHONE.third.replace(/^\+/, "");
/** Nobody MatchTime knows. */
const STRANGER = "447700900997";

let seq = 0;
async function say(
  request: APIRequestContext,
  text: string,
  senderPhone = PLAYER,
  messageId = `e2e-aolp-${++seq}`,
  extra: Record<string, unknown> = {},
) {
  const res = await request.post("/api/whatsapp/admin-group", {
    headers: KEY,
    data: { channel: "admin-group", groupId: HQ, messageId, text, senderPhone, timestamp: String(Math.floor(Date.now() / 1000)), ...extra },
  });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

async function statusOf(db: TestDb, userId: string): Promise<string | null> {
  return (
    (await db.one<{ status: string }>(`SELECT status FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`, [MATCH.upcoming, userId]))
      ?.status ?? null
  );
}

const lastEvent = (db: TestDb, userId: string) =>
  db.one<{ actorUserId: string }>(
    `SELECT "actorUserId" FROM "AttendanceEvent" WHERE "matchId" = $1 AND "userId" = $2 ORDER BY at DESC LIMIT 1`,
    [MATCH.upcoming, userId],
  );

const lang = (db: TestDb, l: "en" | "tr") => db.run(`UPDATE "Organisation" SET language = $2 WHERE id = $1`, [ORG_ID, l]);

/** An open pick round in HQ over `list`, opened a minute ago. */
async function openRound(db: TestDb, id: string, list: string[]) {
  await db.run(
    `INSERT INTO "OrganiserPickRound" (id, "matchId", "orgId", channel, "listUserIds", "openPlaces", reason, "fallbackAt", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, 'admin-group', $4, 1, 'open-place', $5, $6, $6)`,
    [id, MATCH.upcoming, ORG_ID, list, new Date(Date.now() + 86_400_000), new Date(Date.now() - 60_000)],
  );
}

test.beforeAll(async ({ db }) => {
  resetDb();
  // The pick reader (a model, stubbed): "1" picks the first on the list.
  setOrganiserPickReaderStub({ bodies: { "1": { kind: "pick", positions: [1] } } });
  await db.run(`UPDATE "Organisation" SET "adminGroupId" = $2, "adminChannelMode" = 'admin-group', "benchPickMode" = 'organiser' WHERE id = $1`, [
    ORG_ID,
    HQ,
  ]);
});

test.afterAll(() => {
  clearPipelineStubs();
  resetDb();
});

// ── The bench pick ──────────────────────────────────────────────────────

test("someone who is not in the club: their number in the pick round picks nobody", async ({ request, db }) => {
  await openRound(db, "e2e-aolp-round-1", [U.bench]);
  expect(await say(request, "1", STRANGER)).toMatchObject({ handled: false, replyText: null });
  expect(await statusOf(db, U.bench)).toBe("BENCH");
});

test("a player answers the pick round with a number: that player is in, picked by the player", async ({ request, db }) => {
  const out = await say(request, "1");
  expect(out).toMatchObject({ handled: true, outcome: "picked", replyText: "✅ Done: *Ben Bench* is in (picked by Pat Player).", react: "✅" });
  expect(await statusOf(db, U.bench)).toBe("CONFIRMED");
  const round = await db.one<{ outcome: string; lastPickedByUserId: string }>(
    `SELECT outcome, "lastPickedByUserId" FROM "OrganiserPickRound" WHERE id = 'e2e-aolp-round-1'`,
  );
  expect(round).toMatchObject({ outcome: "filled", lastPickedByUserId: U.player });
});

test("in Turkish: a player's number picks too", async ({ request, db }) => {
  // A place opens again (Tom out) and Ian waits on the bench.
  await db.run(`UPDATE "Attendance" SET status = 'DROPPED' WHERE "matchId" = $1 AND "userId" = $2`, [MATCH.upcoming, U.third]);
  await db.run(
    `INSERT INTO "Attendance" (id, "matchId", "userId", status, position, "updatedAt") VALUES ('e2e-aolp-ian', $1, $2, 'BENCH', 9, now())`,
    [MATCH.upcoming, U.fresh],
  );
  await openRound(db, "e2e-aolp-round-2", [U.fresh]);
  await lang(db, "tr");
  const out = await say(request, "1");
  await lang(db, "en");
  expect(out).toMatchObject({ handled: true, outcome: "picked", replyText: "✅ Tamam: *Ian Innes* kadroda (Pat Player seçti).", react: "✅" });
  expect(await statusOf(db, U.fresh)).toBe("CONFIRMED");
});

// ── The pasted list and its YES ─────────────────────────────────────────

const LIST = ["Friday squad", "1. Alex Admin", "2. Colin Collector", "3. Pat Player", "4. Ian Innes", "5. Zara Zest"].join("\n");
const TR_LIST = ["Cuma kadro", "1. Alex Admin", "2. Colin Collector", "3. Pat Player", "4. Ian Innes", "5. Tom Third"].join("\n");
let question = "";

// What the HQ squad reader (a model, stubbed, 2026-10-29) reads each list
// as: the whole squad, whoever playing is left off, left off on purpose
// (the server keeps only those really playing at the time).
test.beforeAll(() => {
  setHqSquadReaderStub({
    bodies: {
      [LIST]: squadReading(["Alex Admin", "Colin Collector", "Pat Player", "Ian Innes", "Zara Zest"], { out: ["Ben Bench", "Tom Third"] }),
      [TR_LIST]: squadReading(["Alex Admin", "Colin Collector", "Pat Player", "Ian Innes", "Tom Third"], { out: ["Zara Zest"] }),
    },
  });
});
test.afterAll(() => clearHqSquadReaderStub());

test("a player pastes the squad: the exact changes and a YES question, nothing applied yet", async ({ request, db }) => {
  // The shared router reads every YES below (stubbed: what it would say).
  // A pasted list goes to the router first (2026-10-30), then the reader.
  engineOn({ YES: { route: "approve" }, EVET: { route: "approve" }, [LIST]: { route: "other_att" }, [TR_LIST]: { route: "other_att" } });
  const out = await say(request, LIST, PLAYER, "e2e-aolp-paste-1");
  question = out.replyText;
  expect(out).toMatchObject({ handled: true, outcome: "paste-proposed", react: "✅" });
  expect(out.replyText).toMatch(/^Adding: Zara Zest\. Removing: Ben Bench\..*Reply YES to apply\.$/);
  const proposal = await db.one<{ by: string }>(`SELECT "proposedByUserId" AS by FROM "AdminSquadProposal" WHERE "waMessageId" = 'e2e-aolp-paste-1'`);
  expect(proposal?.by).toBe(U.player);
  expect(await statusOf(db, U.extra)).toBeNull();
});

test("another player's YES to that list: not theirs, one line naming who can, nothing applied", async ({ request, db }) => {
  expect(await say(request, "YES", TOM)).toMatchObject({ handled: true, outcome: "hq-only-organisers", replyText: "Only Alex can change that.", react: null });
  expect(await statusOf(db, U.extra)).toBeNull();
});

test("the player who pasted it says YES (a reply to the question): applied, recorded as theirs", async ({ request, db }) => {
  const out = await say(request, "YES", PLAYER, undefined, { quotedText: question, quotedFromMatchTime: true });
  expect(out).toMatchObject({ handled: true, outcome: "paste-applied", react: "✅" });
  expect(out.replyText).toMatch(/^Done: Ben Bench out, Zara Zest in\. 5 of 5/);
  expect(await statusOf(db, U.bench)).toBe("DROPPED");
  expect(await statusOf(db, U.extra)).toBe("CONFIRMED");
  expect((await lastEvent(db, U.extra))?.actorUserId).toBe(U.player);
  const proposal = await db.one<{ by: string }>(`SELECT "resolvedByUserId" AS by FROM "AdminSquadProposal" WHERE "waMessageId" = 'e2e-aolp-paste-1'`);
  expect(proposal?.by).toBe(U.player);
});

test("in Turkish: a player pastes the squad and their own EVET (the next message) applies it", async ({ request, db }) => {
  await lang(db, "tr");
  const asked = await say(request, TR_LIST, PLAYER, "e2e-aolp-paste-2");
  const yes = await say(request, "EVET");
  await lang(db, "en");
  expect(asked).toMatchObject({ handled: true, outcome: "paste-proposed" });
  expect(asked.replyText).toMatch(/Tom Third/);
  expect(asked.replyText).toMatch(/Zara Zest/);
  expect(asked.replyText).toMatch(/EVET/);
  expect(yes).toMatchObject({ handled: true, outcome: "paste-applied", react: "✅" });
  expect(yes.replyText).toMatch(/^Tamam: /);
  expect(await statusOf(db, U.third)).toBe("CONFIRMED");
  expect(await statusOf(db, U.extra)).toBe("DROPPED");
  expect((await lastEvent(db, U.third))?.actorUserId).toBe(U.player);
});

test("the organiser still says YES to a list a player pasted", async ({ request, db }) => {
  expect(await say(request, LIST, PLAYER, "e2e-aolp-paste-3")).toMatchObject({ outcome: "paste-proposed" });
  const out = await say(request, "YES", ADMIN);
  expect(out).toMatchObject({ handled: true, outcome: "paste-applied" });
  expect(await statusOf(db, U.extra)).toBe("CONFIRMED");
  expect((await lastEvent(db, U.extra))?.actorUserId).toBe(U.admin);
});

// ── An organisers' job asked for, untagged: the one line ───────────────

const ADMIN_FACTS = { payerRef: "", count: 0, coveredRefs: [], undo: false, matchDay: "", phrase: "", note: "", lookbackMatches: 0 };

const fee = async (db: TestDb) =>
  (await db.one<{ f: number | null }>(`SELECT "feePerPlayer" AS f FROM "Match" WHERE id = $1`, [MATCH.upcoming]))?.f ?? null;

test("a player asks, untagged, to change the fee: one line naming who can, nothing changed", async ({ request, db }) => {
  const before = await fee(db);
  engineOn({ "make the fee 6 pounds": { route: "admin_ops", facts: { action: "other", ...ADMIN_FACTS } } });
  expect(await say(request, "make the fee 6 pounds")).toMatchObject({
    handled: true,
    outcome: "hq-only-organisers",
    replyText: "Only Alex can change that.",
    react: null,
  });
  expect(await fee(db)).toBe(before);
});

test("in Turkish: the same, the Turkish line", async ({ request, db }) => {
  const before = await fee(db);
  engineOn({ "ücreti 6 pound yap": { route: "admin_ops", facts: { action: "other", ...ADMIN_FACTS } } });
  await lang(db, "tr");
  const out = await say(request, "ücreti 6 pound yap");
  await lang(db, "en");
  expect(out).toMatchObject({ handled: true, outcome: "hq-only-organisers", replyText: "Bunu yalnızca Alex değiştirebilir.", react: null });
  expect(await fee(db)).toBe(before);
});

test("a player asks, untagged, for a free place or the players' group ask: the same line; the teams: silent; nothing done", async ({ request, db }) => {
  engineOn({
    "Tom is free this week": { route: "admin_ops", facts: { action: "fee_waiver", ...ADMIN_FACTS, coveredRefs: ["Tom"] } },
    "make the teams": { route: "balancer" },
    "ask the group if anyone can play": { route: "ask_group" },
  });
  for (const text of ["Tom is free this week", "ask the group if anyone can play"]) {
    expect(await say(request, text), text).toMatchObject({ handled: true, outcome: "hq-only-organisers", replyText: "Only Alex can change that.", react: null });
  }
  // Talk about the teams from a player is theirs unless asked of MatchTime
  // (#468, 2026-10-29, FNF HQ): untagged, silent.
  expect(await say(request, "make the teams")).toMatchObject({ handled: false, replyText: null });
  const asked = await db.one<{ n: string }>(`SELECT count(*)::text AS n FROM "AdminGroupMessage" WHERE "orgId" = $1 AND "askRef" LIKE 'fee:%'`, [ORG_ID]);
  expect(asked?.n).toBe("0");
  expect(await db.one(`SELECT id FROM "AdminTeamProposal" WHERE "orgId" = $1`, [ORG_ID])).toBeFalsy();
});

test("the organisers' own chat, untagged (EN and TR, an organiser and a player): silent", async ({ request }) => {
  engineOn({
    "should we put the fee up next month?": { route: "none" },
    "the fee went up last week didn't it": { route: "none" },
    "ücreti gelecek ay artıralım mı?": { route: "none" },
  });
  expect(await say(request, "should we put the fee up next month?", ADMIN)).toMatchObject({ handled: false, replyText: null });
  expect(await say(request, "the fee went up last week didn't it", PLAYER)).toMatchObject({ handled: false, replyText: null });
  expect(await say(request, "ücreti gelecek ay artıralım mı?", ADMIN)).toMatchObject({ handled: false, replyText: null });
});

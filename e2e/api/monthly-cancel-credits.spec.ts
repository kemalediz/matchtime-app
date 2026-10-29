/**
 * A MONTHLY CLUB'S WEEK CANCELLED BY WHATSAPP, AND ITS CREDITS (2026-10-29).
 * Kemal: every admin feature works by tagging MatchTime, so the tagged
 * cancel no longer answers a monthly club with "use the website". Every door
 * goes through `cancelMatchById`, which writes the cancelled-week credits
 * (`month-close.ts`), and putting the game back on takes them back.
 *
 * Seeds a RUNNING month for the fixture's activity, with two regulars (Pat,
 * Tom) and Alex the owner as pay-as-you-go, and checks the credits are
 * written once: by the tagged cancel, by the untagged call-off's DM yes, and
 * not twice when both happen. Router, admin extractor and call-off reader
 * are STUBBED; everything after is the shipped code. $0.
 */
import { test, expect, postAnalyze, resetDb } from "../fixtures";
import { ACTIVITY_ID, MATCH, NAME, ORG_ID, PHONE, U } from "../helpers/constants";
import { E2E } from "../helpers/env";
import { clearPipelineStubs, engineOn, setCalloffStub } from "../helpers/stub";
import type { TestDb } from "../helpers/test-db";
import type { APIRequestContext } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const HEADERS = { "x-api-key": E2E.WHATSAPP_API_KEY };
const MONTH = "e2e-mcc-month";
const CANCEL = "@Match Time cancel the match";
const BACK_ON = "@Match Time the match is back on";
const OFF = "Alright, so it's off gents, enjoy your evenings at home";
const YES = "yeah go on";

const admin = (action: string) => ({
  route: "admin_ops",
  facts: { action, payerRef: "", count: 0, coveredRefs: [], undo: false, matchDay: "", phrase: "", note: "", lookbackMatches: 0, playersFrom: "", clubRef: "" },
});

let seq = 0;
const msgId = () => `e2e-mcc-${Date.now()}-${++seq}`;

async function say(request: APIRequestContext, body: string, tagged: boolean) {
  const waMessageId = msgId();
  const res = await postAnalyze(request, [{ waMessageId, body, authorPhone: PHONE.admin, authorName: NAME.admin, botMentioned: tagged }]);
  return res.results.find((r: { waMessageId: string }) => r.waMessageId === waMessageId) as { reply: string | null; react: string | null; intent: string };
}

async function dm(request: APIRequestContext, body: string) {
  const res = await request.post("/api/whatsapp/dm-reply", { headers: HEADERS, data: { phone: PHONE.admin, body, waMessageId: msgId(), authorName: NAME.admin } });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

const status = async (db: TestDb) => (await db.one<{ status: string }>(`SELECT status FROM "Match" WHERE id = $1`, [MATCH.upcoming]))!.status;
const credits = (db: TestDb) =>
  db.all<{ userId: string; voidedAt: string | null }>(
    `SELECT "userId", "voidedAt" FROM "SquadCredit" WHERE "earnedMatchId" = $1 AND reason = 'cancelled-week' ORDER BY "userId"`,
    [MATCH.upcoming],
  );
const live = async (db: TestDb) => (await credits(db)).filter((c) => c.voidedAt === null).map((c) => c.userId).sort();
const REGULARS = [U.player, U.third].sort();

/** The London calendar month a date falls in, as "YYYY-MM-01". */
function londonMonthStart(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit" }).formatToParts(d);
  const y = parts.find((p) => p.type === "year")!.value;
  const m = parts.find((p) => p.type === "month")!.value;
  return `${y}-${m}-01`;
}

async function member(db: TestDb, userId: string, kind: "regular" | "payg") {
  await db.run(
    `INSERT INTO "SquadMonthMember" (id, "monthId", "userId", kind, slot, "gamesCovered", "amountDuePence", source, "joinedAt", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'seed-tick', now() - interval '2 days', now())`,
    [`${MONTH}-${userId}`, MONTH, userId, kind, kind === "regular" ? 1 : null, kind === "regular" ? 4 : 0, kind === "regular" ? 3000 : null],
  );
}

test.beforeEach(async ({ db }) => {
  resetDb();
  clearPipelineStubs();
  // Three hours from now, so the game and its month never straddle a month end.
  const kickoff = new Date(Date.now() + 3 * 60 * 60 * 1000);
  await db.run(`UPDATE "Organisation" SET "adminGroupId" = NULL, "squadMode" = 'monthly' WHERE id = $1`, [ORG_ID]);
  await db.run(`UPDATE "Match" SET date = $2, status = 'UPCOMING' WHERE id = $1`, [MATCH.upcoming, kickoff.toISOString()]);
  await db.run(`DELETE FROM "BotJob"`);
  await db.run(`DELETE FROM "SquadCredit"`);
  await db.run(`DELETE FROM "SentNotification" WHERE kind LIKE 'calloff-offer%' OR kind = 'month-cancelled-at'`);
  await db.run(`DELETE FROM "SquadMonthMember" WHERE "monthId" = $1`, [MONTH]);
  await db.run(`DELETE FROM "SquadMonth" WHERE id = $1`, [MONTH]);
  await db.run(
    `INSERT INTO "SquadMonth" (id, "orgId", "activityId", "monthStart", status, "gamesScheduled", "sharePerGamePence", "pricedAt", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4::date, 'running', 4, 750, now() - interval '3 days', now() - interval '3 days', now())`,
    [MONTH, ORG_ID, ACTIVITY_ID, londonMonthStart(kickoff)],
  );
  await member(db, U.player, "regular");
  await member(db, U.third, "regular");
  await member(db, U.admin, "payg");
  engineOn({ [CANCEL]: admin("cancel_match"), [BACK_ON]: admin("restore_match") });
  setCalloffStub({ bodies: { [OFF]: "calloff", [YES]: "yes" } });
});

test.afterAll(() => {
  clearPipelineStubs();
  resetDb();
});

test("tagged cancel: the week is cancelled, each regular gets one credit, the announcement says so; said again, no more", async ({ request, db }) => {
  const out = await say(request, CANCEL, true);
  expect(out).toMatchObject({ react: "✅", intent: "match_cancelled" });
  expect(await status(db)).toBe("CANCELLED");
  expect(await live(db)).toEqual(REGULARS);
  const posts = (await db.all<{ text: string }>(`SELECT text FROM "BotJob" WHERE kind = 'group' AND "orgId" = $1`, [ORG_ID])).map((p) => p.text);
  expect(posts).toHaveLength(1);
  expect(posts[0]).toMatch(/^❌ \*Match cancelled\*/);
  expect(posts[0]).toContain("Regulars get 1 game credit for it.");

  await say(request, CANCEL, true);
  expect(await credits(db)).toHaveLength(2);
});

test("untagged call-off, then his DM yes: the same credits, once", async ({ request, db }) => {
  await say(request, OFF, false);
  expect(await status(db)).toBe("UPCOMING");
  expect(await credits(db)).toHaveLength(0);
  expect(await dm(request, YES)).toMatchObject({ handled: "calloff-cancelled", result: "cancelled" });
  expect(await status(db)).toBe("CANCELLED");
  expect(await live(db)).toEqual(REGULARS);
});

test("both: the DM offer, then a tagged cancel, then his yes: credits written once", async ({ request, db }) => {
  await say(request, OFF, false);
  await say(request, CANCEL, true);
  expect(await live(db)).toEqual(REGULARS);
  const yes = await dm(request, YES);
  // The game is already off, so the offer is closed: his yes is not an answer to it.
  expect(String(yes.handled ?? "")).not.toBe("calloff-cancelled");
  expect(await credits(db)).toHaveLength(2);
  expect(await live(db)).toEqual(REGULARS);
});

test("tagged back on: the game is on again and its credits are taken back at once", async ({ request, db }) => {
  await say(request, CANCEL, true);
  expect(await live(db)).toEqual(REGULARS);
  const back = await say(request, BACK_ON, true);
  expect(back).toMatchObject({ react: "✅", intent: "match_restored" });
  expect(await status(db)).toBe("UPCOMING");
  expect(await live(db)).toEqual([]);
  // Called off again: a fresh credit each, still one live per regular.
  await say(request, CANCEL, true);
  expect(await live(db)).toEqual(REGULARS);
});

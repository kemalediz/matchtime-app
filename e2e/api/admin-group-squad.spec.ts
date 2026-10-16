/**
 * SQUAD CHANGES TYPED IN THE ADMIN GROUP (2026-10-14), against a real
 * Postgres and the real route. The router and the attendance extractor are
 * STUBBED (`engineOn`): no model is called. Everything from the routes on
 * is the shipped code: the attendance engine, the writers, the pasted-list
 * proposal and its YES.
 *
 * The fixture club (E2E Test FC, weekly, first-come) has its upcoming
 * match at 4 of 5: Alex Admin, Colin Collector, Pat Player, Tom Third, and
 * Ben Bench on the bench. Alex is the OWNER.
 */
import { test, expect, resetDb } from "../fixtures";
import { MATCH, ORG_ID, PHONE, U } from "../helpers/constants";
import { E2E } from "../helpers/env";
import { engineOn, clearPipelineStubs, otherFacts, selfOut } from "../helpers/stub";
import type { TestDb } from "../helpers/test-db";
import type { APIRequestContext } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const KEY = { "x-api-key": E2E.WHATSAPP_API_KEY };
const HQ = "120363777000000031@g.us";
const ADMIN = PHONE.admin.replace(/^\+/, "");
const PLAYER = PHONE.player.replace(/^\+/, "");

let seq = 0;
async function say(
  request: APIRequestContext,
  text: string,
  senderPhone = ADMIN,
  messageId = `e2e-ags-${++seq}`,
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

const groupJobs = (db: TestDb) =>
  db.all<{ id: string }>(`SELECT id FROM "BotJob" WHERE "orgId" = $1 AND kind <> 'dm'`, [ORG_ID]);
const analyzed = async (db: TestDb) => (await db.one<{ n: string }>(`SELECT count(*)::text AS n FROM "AnalyzedMessage"`))?.n;

test.beforeAll(async ({ db }) => {
  resetDb();
  await db.run(`UPDATE "Organisation" SET "adminGroupId" = $2, "adminChannelMode" = 'admin-group' WHERE id = $1`, [ORG_ID, HQ]);
});

test.afterAll(() => {
  clearPipelineStubs();
  resetDb();
});

test("a non-admin's 'Tom out' in the admin group is ignored: no reply, no write", async ({ request, db }) => {
  engineOn({ "Tom out": { route: "other_att", facts: otherFacts("Tom", "out") } });
  const out = await say(request, "Tom out", PLAYER);
  expect(out).toMatchObject({ handled: false, ignored: "no-open-pick", replyText: null });
  expect(await statusOf(db, U.third)).toBe("CONFIRMED");
});

test("an admin's 'Tom out': applied through the engine, confirmed in the admin group, nothing posted to the players", async ({ request, db }) => {
  engineOn({ "Tom out": { route: "other_att", facts: otherFacts("Tom", "out") } });
  const before = { jobs: (await groupJobs(db)).length, analyzed: await analyzed(db) };
  const out = await say(request, "Tom out", ADMIN, "e2e-ags-tom-out");
  expect(out).toMatchObject({ handled: true, outcome: "squad-changed", replyText: "Done: Tom Third out. 3 of 5." });
  expect(await statusOf(db, U.third)).toBe("DROPPED");

  // Recorded as an admin's instruction from that message.
  const ev = await db.one<{ cause: string; actorKind: string; actorUserId: string; sourceRef: string }>(
    `SELECT cause, "actorKind", "actorUserId", "sourceRef" FROM "AttendanceEvent" WHERE "matchId" = $1 AND "userId" = $2 ORDER BY at DESC LIMIT 1`,
    [MATCH.upcoming, U.third],
  );
  expect(ev).toMatchObject({ cause: "admin-message", actorKind: "admin", actorUserId: U.admin, sourceRef: "admin-group:e2e-ags-tom-out" });

  // No post to the players' group and no analysis row from the admin group.
  expect((await groupJobs(db)).length).toBe(before.jobs);
  expect(await analyzed(db)).toBe(before.analyzed);

  // A Pi retry of the same message changes nothing and says nothing.
  expect(await say(request, "Tom out", ADMIN, "e2e-ags-tom-out")).toMatchObject({ ignored: "duplicate", replyText: null });
});

test("'put Ian in': in, with the new count", async ({ request, db }) => {
  engineOn({ "put Ian in": { route: "other_att", facts: otherFacts("Ian", "in") } });
  const out = await say(request, "put Ian in");
  expect(out).toMatchObject({ handled: true, replyText: "Done: Ian Innes in. 4 of 5." });
  expect(await statusOf(db, U.fresh)).toBe("CONFIRMED");
});

test("chat the router does not route to attendance is ignored, no reply", async ({ request }) => {
  engineOn({ "Wasim played well last week": { route: "none" } });
  expect(await say(request, "Wasim played well last week")).toMatchObject({ handled: false, ignored: "no-open-pick", replyText: null });
});

// ── 2026-10-15: organisers talking in HQ is not an instruction ────────
// Alex (the owner) is CONFIRMED. The extractor's facts are stubbed to what
// the live rehearsal saw for these shapes; the rest is the shipped code.

test("an organiser who 'might have to pull out': no write, no reply", async ({ request, db }) => {
  engineOn({ "might have to pull out this week": { route: "self_att", facts: selfOut({ contingent: true, conditionOn: "self" }) } });
  expect(await say(request, "might have to pull out this week")).toMatchObject({ handled: false, replyText: null });
  expect(await statusOf(db, U.admin)).toBe("CONFIRMED");
});

test("then an injury report: no write, no reply", async ({ request, db }) => {
  engineOn({ "my knee is gone lads": { route: "self_att", facts: selfOut({ basis: "availability" }) } });
  expect(await say(request, "my knee is gone lads")).toMatchObject({ handled: false, replyText: null });
  expect(await statusOf(db, U.admin)).toBe("CONFIRMED");
});

test("a plain 'won't be around' in conversation: no write, one line with the command that does it", async ({ request, db }) => {
  engineOn({ "won't be around on friday": { route: "self_att", facts: selfOut() } });
  const out = await say(request, "won't be around on friday");
  expect(out).toMatchObject({ handled: true, outcome: "squad-question" });
  expect(out.replyText).toMatch(/^To take yourself out of .+, write "Alex Admin out"\.$/);
  expect(await statusOf(db, U.admin)).toBe("CONFIRMED");
});

test("a name nobody in the club has, said in passing: not added, and it says how to add them", async ({ request, db }) => {
  engineOn({ "Zed is around again": { route: "other_att", facts: otherFacts("Zed", "in") } });
  const out = await say(request, "Zed is around again");
  expect(out).toMatchObject({ handled: true, outcome: "squad-question", replyText: 'I don\'t know Zed yet. To add them, write "put Zed in".' });
  expect(await db.one(`SELECT id FROM "User" WHERE name = 'Zed'`)).toBeFalsy();
});

const LIST = ["Friday squad", "1. Alex Admin", "2. Colin Collector", "3. Ian Innes", "4. Zara Zest", "5. Naim Newman"].join("\n");

let pasteQuestion = "";

test("a pasted list: the exact changes and a YES question, nothing applied yet", async ({ request, db }) => {
  // The shared router reads every YES below (stubbed: what it would say).
  engineOn({ YES: { route: "approve" }, yes: { route: "approve" } });
  const out = await say(request, LIST, ADMIN, "e2e-ags-paste");
  pasteQuestion = out.replyText;
  expect(out).toMatchObject({
    handled: true,
    outcome: "paste-proposed",
    replyText:
      "Adding: Zara Zest. Removing: Pat Player. Unknown names: Naim Newman (not a member yet, I'll add them as a new player). Reply YES to apply.",
  });
  expect(await statusOf(db, U.player)).toBe("CONFIRMED");
  expect(await statusOf(db, U.extra)).toBeNull();
});

test("a non-admin's YES applies nothing", async ({ request, db }) => {
  expect(await say(request, "YES", PLAYER)).toMatchObject({ handled: false, replyText: null });
  expect(await statusOf(db, U.player)).toBe("CONFIRMED");
});

test("an admin's YES straight after a non-admin spoke: asked once which it is for, nothing applied", async ({ request, db }) => {
  // The non-admin's message above is conversation in between, so the
  // safe-YES rule (admin-group-confirm-rules.ts) asks rather than applies.
  const out = await say(request, "YES");
  expect(out).toMatchObject({ handled: true, outcome: "hq-confirm-asked", replyText: "Is that YES to the squad list pasted here?" });
  expect(await statusOf(db, U.player)).toBe("CONFIRMED");
});

test("an admin's YES as a WhatsApp reply to the list question applies it: out first, then in, new names added as players", async ({ request, db }) => {
  // A reply to MatchTime's question is clearly about it, whatever was said
  // since (the Pi forwards the quoted text and whose it was).
  await say(request, "who's got the bibs?", PLAYER);
  const out = await say(request, "YES", ADMIN, undefined, { quotedText: pasteQuestion, quotedFromMatchTime: true });
  expect(out).toMatchObject({ handled: true, outcome: "paste-applied" });
  expect(out.replyText).toBe("Done: Pat Player out, Zara Zest in, Naim Newman in. 5 of 5.");
  expect(await statusOf(db, U.player)).toBe("DROPPED");
  expect(await statusOf(db, U.extra)).toBe("CONFIRMED");
  const naim = await db.one<{ id: string }>(
    `SELECT u.id FROM "User" u JOIN "Membership" m ON m."userId" = u.id WHERE m."orgId" = $1 AND u.name = 'Naim Newman'`,
    [ORG_ID],
  );
  expect(naim).toBeTruthy();
  expect(await statusOf(db, naim!.id)).toBe("CONFIRMED");

  // A second YES finds nothing waiting, and says nothing.
  expect(await say(request, "yes")).toMatchObject({ handled: false, replyText: null });
});

test("the same list again: 'That matches the squad'", async ({ request }) => {
  expect(await say(request, LIST)).toMatchObject({
    handled: true,
    outcome: "paste-same",
    replyText: "That matches the squad, nothing to change.",
  });
});

test("YES more than 30 minutes after the list: not applied, and it says so", async ({ request, db }) => {
  const list = ["1. Alex Admin", "2. Colin Collector", "3. Ian Innes", "4. Zara Zest", "5. Pat Player"].join("\n");
  const proposed = await say(request, list);
  expect(proposed.outcome).toBe("paste-proposed");
  // A UTC instant, as Prisma stores it (the column has no time zone).
  await db.run(`UPDATE "AdminSquadProposal" SET "expiresAt" = $2 WHERE "orgId" = $1 AND "resolvedAt" IS NULL`, [
    ORG_ID,
    new Date(Date.now() - 60_000).toISOString(),
  ]);
  engineOn({ YES: { route: "approve" } });
  expect(await say(request, "YES")).toMatchObject({
    handled: true,
    outcome: "paste-expired",
    replyText: "That list is more than 30 minutes old, so I haven't applied it. Paste it again if it still stands.",
  });
  expect(await statusOf(db, U.player)).toBe("DROPPED");
});

test("a Turkish club gets Turkish", async ({ request, db }) => {
  await db.run(`UPDATE "Organisation" SET language = 'tr' WHERE id = $1`, [ORG_ID]);
  engineOn({ "Zara çıktı": { route: "other_att", facts: otherFacts("Zara", "out") } });
  const out = await say(request, "Zara çıktı");
  expect(out.replyText).toMatch(/^Tamam: Zara Zest çıktı\. \d\/5\.$/);
  await db.run(`UPDATE "Organisation" SET language = 'en' WHERE id = $1`, [ORG_ID]);
});

test("a monthly club: no squad change from the admin group, and it says so in one line", async ({ request, db }) => {
  await db.run(`UPDATE "Organisation" SET "squadMode" = 'monthly' WHERE id = $1`, [ORG_ID]);
  engineOn({ "Colin out": { route: "other_att", facts: otherFacts("Colin", "out") } });
  expect(await say(request, "Colin out")).toMatchObject({
    handled: true,
    outcome: "hq-not-here",
    replyText: "I can't do that from this group. Ask *what can you do?* to see what I can do here.",
  });
  expect(await statusOf(db, U.collector)).toBe("CONFIRMED");
  await db.run(`UPDATE "Organisation" SET "squadMode" = 'weekly' WHERE id = $1`, [ORG_ID]);
});

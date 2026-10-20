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
import { engineOn, clearPipelineStubs, otherFacts, selfIn, selfOut } from "../helpers/stub";
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

// A PLAYER of the club changes who plays in HQ too since 2026-10-20
// (admin-group-attendance-anyone.spec.ts); someone not in the club does not.
test("'Tom out' from someone not in the club is ignored: no reply, no write", async ({ request, db }) => {
  engineOn({ "Tom out": { route: "other_att", facts: otherFacts("Tom", "out") } });
  const out = await say(request, "Tom out", "447700900997");
  expect(out).toMatchObject({ handled: false, ignored: "no-open-pick", replyText: null });
  expect(await statusOf(db, U.third)).toBe("CONFIRMED");
});

test("an admin's 'Tom out': applied through the engine, confirmed in the admin group, nothing posted to the players", async ({ request, db }) => {
  engineOn({ "Tom out": { route: "other_att", facts: otherFacts("Tom", "out") } });
  const before = { jobs: (await groupJobs(db)).length, analyzed: await analyzed(db) };
  const out = await say(request, "Tom out", ADMIN, "e2e-ags-tom-out");
  // The Pi puts a ✅ on the admin's message (2026-10-16).
  expect(out).toMatchObject({ handled: true, outcome: "squad-changed", replyText: "Done: Tom Third out. 3 of 5, 1 on the bench (Ben Bench).", react: "✅" });
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
  expect(out).toMatchObject({ handled: true, replyText: "Done: Ian Innes in. 4 of 5, 1 on the bench (Ben Bench)." });
  expect(await statusOf(db, U.fresh)).toBe("CONFIRMED");
});

test("chat the router does not route to attendance is ignored, no reply", async ({ request }) => {
  engineOn({ "Wasim played well last week": { route: "none" } });
  const out = await say(request, "Wasim played well last week");
  expect(out).toMatchObject({ handled: false, ignored: "no-open-pick", replyText: null });
  expect(out.react ?? null).toBeNull();
});

// FNF 2026-10-16: a tagged request the router called `unsure` was met with
// silence. Now the attendance engine reads it and, owning nothing, one line.
test("a tagged message the router calls unsure: one line, never silence, and no tick", async ({ request }) => {
  engineOn({ "@Match Time update the graphic please": { route: "unsure" } });
  const out = await say(request, "@Match Time update the graphic please");
  expect(out).toMatchObject({
    handled: true,
    outcome: "hq-not-understood",
    replyText: "I didn't catch what you'd like me to do. Ask *what can you do?* to see what I can do here.",
    react: null,
  });
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

// 2026-10-17 (FNF HQ, "Imti Rafi AH back"): a line back for a held claim
// only when the message was addressed to MatchTime; in the organisers' own
// conversation, silence and no tick.
test("a plain 'won't be around' in conversation: no write, no reply", async ({ request, db }) => {
  engineOn({ "won't be around on friday": { route: "self_att", facts: selfOut() } });
  expect(await say(request, "won't be around on friday")).toMatchObject({ handled: false, replyText: null });
  expect(await statusOf(db, U.admin)).toBe("CONFIRMED");
});

test("the same, tagged to MatchTime: no write, one line with the command that does it, no tick", async ({ request, db }) => {
  engineOn({ "@Match Time won't be around on friday": { route: "self_att", facts: selfOut() } });
  const out = await say(request, "@Match Time won't be around on friday");
  expect(out).toMatchObject({ handled: true, outcome: "squad-question", react: null });
  expect(out.replyText).toMatch(/^If you want me to take you out of .+, just ask me in your own words \(for example Alex Admin out\)\.$/);
  expect(await statusOf(db, U.admin)).toBe("CONFIRMED");
});

test("a name nobody in the club has, said in passing: not added, no reply", async ({ request, db }) => {
  engineOn({ "Zed is around again": { route: "other_att", facts: otherFacts("Zed", "in") } });
  expect(await say(request, "Zed is around again")).toMatchObject({ handled: false, replyText: null });
  expect(await db.one(`SELECT id FROM "User" WHERE name = 'Zed'`)).toBeFalsy();
});

test("the same, tagged to MatchTime: not added, and it says how to add them", async ({ request, db }) => {
  engineOn({ "@Match Time Zed is around again": { route: "other_att", facts: otherFacts("Zed", "in") } });
  const out = await say(request, "@Match Time Zed is around again");
  expect(out).toMatchObject({ handled: true, outcome: "squad-question", replyText: "I don't know Zed yet. To add them, just ask me in your own words (for example put Zed in).", react: null });
  expect(await db.one(`SELECT id FROM "User" WHERE name = 'Zed'`)).toBeFalsy();
});

// 2026-10-19 (Haiku 5.5): "@Match Time AH back". The router reads it as
// about someone else (other_att); the attendance extractor, run live once,
// read no name in it: a claim about the SENDER at confidence 0.3. Haiku 4.5
// routed it `question`, where the question extractor (live, once) read
// topic "other": "I can't do that from this group". Neither ever said how to
// add AH, because no model read AH as a name.
const WHO = "I couldn't tell who that's about, so I haven't changed anything. To add someone or take them out, just ask me in your own words with their name (for example put Bilal in).";

test("'@Match Time AH back' routed other_att, read as the sender's own: nothing written, one line on how to add someone, no tick", async ({ request, db }) => {
  engineOn({ "@Match Time AH back": { route: "other_att", facts: selfIn({ confidence: 0.3, tense: "future" }) } });
  const before = await statusOf(db, U.admin);
  const out = await say(request, "@Match Time AH back");
  expect(out).toMatchObject({ handled: true, outcome: "squad-question", replyText: WHO, react: null });
  expect(await statusOf(db, U.admin)).toBe(before);
  expect(await db.one(`SELECT id FROM "User" WHERE name = 'AH'`)).toBeFalsy();
});

test("the same with no claim read at all: the same line", async ({ request }) => {
  engineOn({ "@Match Time AH back": { route: "other_att", facts: { claims: [], affirmation: "none", sideRequests: [] } } });
  expect(await say(request, "@Match Time AH back")).toMatchObject({ handled: true, outcome: "squad-question", replyText: WHO, react: null });
});

test("the same words between organisers, not tagged: silent", async ({ request }) => {
  engineOn({ "AH back": { route: "other_att", facts: selfIn({ confidence: 0.3, tense: "future" }) } });
  expect(await say(request, "AH back")).toMatchObject({ handled: false, replyText: null });
});

test("'@Match Time AH back' routed question (Haiku 4.5's route), topic other: the not-from-this-group line, as before", async ({ request }) => {
  engineOn({ "@Match Time AH back": { route: "question", facts: { topic: "other", personRef: "", statedCount: -1 } } });
  expect(await say(request, "@Match Time AH back")).toMatchObject({
    handled: true,
    outcome: "hq-not-here",
    replyText: "I can't do that from this group. Ask *what can you do?* to see what I can do here.",
  });
});

test("the incident: a reply to another organiser naming players for next week: silent, nothing written, no tick", async ({ request, db }) => {
  engineOn({ "Imti Rafi Zed back": { route: "other_att", facts: otherFacts("Zed", "in") } });
  const out = await say(request, "Imti Rafi Zed back", ADMIN, undefined, { quotedText: "We have the below out", quotedFromMatchTime: false });
  expect(out).toMatchObject({ handled: false, replyText: null });
  expect(out).not.toHaveProperty("react");
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

test("a player's YES to a list an organiser pasted applies nothing: one line naming who can", async ({ request, db }) => {
  expect(await say(request, "YES", PLAYER)).toMatchObject({ handled: true, outcome: "hq-only-organisers", replyText: "Only Alex can change that.", react: null });
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
  expect(out.replyText).toMatch(/^Done: Pat Player out, Zara Zest in, Naim Newman in\. 5 of 5(, \d on the bench \(.+\))?\.$/);
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
  expect(out.replyText).toMatch(/^Tamam: Zara Zest çıktı\. \d\/5(, yedekte \d kişi \(.+\))?\.$/);
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

// FNF HQ 2026-10-17 09:01: an organiser's list of names with a bare IN or
// OUT. The router (model) said `none` and nothing was written. In HQ the
// list is structured data, like a pasted list: a squad change without the
// router (stubbed to say none here) and without the extractor (none is
// stubbed, so a call would read nothing).
test("names on their own lines and a bare OUT, the router saying none: each one out, a tick", async ({ request, db }) => {
  const text = "Ian \nNaim Newman\n\nOut";
  engineOn({ [text]: { route: "none" } });
  const out = await say(request, text);
  expect(out).toMatchObject({ handled: true, outcome: "squad-changed", react: "✅" });
  expect(out.replyText).toMatch(/^Done: .*Ian Innes out.*Naim Newman out.*\d of 5(, \d on the bench \(.+\))?\.$/);
  expect(await statusOf(db, U.fresh)).toBe("DROPPED");
});

test("the same on one line, IN: each one back", async ({ request, db }) => {
  const text = "Pat, Tom and Zara in";
  engineOn({ [text]: { route: "none" } });
  const out = await say(request, text);
  expect(out).toMatchObject({ handled: true, react: "✅" });
  expect(out.replyText).toMatch(/^Done: /);
  for (const id of [U.player, U.third, U.extra]) expect(["CONFIRMED", "BENCH"]).toContain(await statusOf(db, id));
});

// FNF HQ 2026-10-18 18:16. An organiser wrote "Akram out" in HQ; MatchTime
// said "Done: Akram out. 17 of 18." with Uncle Najib on the bench, in a
// club whose organisers pick who comes off it. The count now says the
// bench, and the reply says how to bring someone in, by the same squad
// change path ("put X in") that read the OUT.
test.describe("organiser pick: a place opens with someone on the bench", () => {
  test.beforeAll(async ({ db }) => {
    resetDb();
    await db.run(
      `UPDATE "Organisation" SET "adminGroupId" = $2, "adminChannelMode" = 'admin-group', "benchPickMode" = 'organiser' WHERE id = $1`,
      [ORG_ID, HQ],
    );
    // The fixture match is 4 of 5 with Ben Bench waiting; make it full, so
    // an OUT opens a place as Akram's did.
    await db.run(`UPDATE "Match" SET "maxPlayers" = 4 WHERE id = $1`, [MATCH.upcoming]);
  });

  test("'Tom out': the reply names the bench and the command that brings Ben in; nothing filled by itself", async ({ request, db }) => {
    engineOn({ "Tom out": { route: "other_att", facts: otherFacts("Tom", "out") } });
    const out = await say(request, "Tom out");
    expect(out).toMatchObject({
      handled: true,
      outcome: "squad-changed",
      replyText:
        'Done: Tom Third out. 3 of 4, 1 on the bench (Ben Bench). A place is free. Just tell me who should come in from the bench, in your own words (for example Ben Bench).',
    });
    expect(await statusOf(db, U.third)).toBe("DROPPED");
    // Organiser pick: MatchTime does not fill the place itself.
    expect(await statusOf(db, U.bench)).toBe("BENCH");
    const offers = await db.one<{ n: string }>(`SELECT count(*)::text AS n FROM "BenchSlotOffer" WHERE "matchId" = $1`, [MATCH.upcoming]);
    expect(offers?.n).toBe("0");
  });

  test("the command it gave works: 'put Ben Bench in' brings him in, and the count is full again", async ({ request, db }) => {
    engineOn({ "put Ben Bench in": { route: "other_att", facts: otherFacts("Ben Bench", "in") } });
    const out = await say(request, "put Ben Bench in");
    expect(out).toMatchObject({ handled: true, outcome: "squad-changed", replyText: "Done: Ben Bench in. 4 of 4." });
    expect(await statusOf(db, U.bench)).toBe("CONFIRMED");
  });

  test("Turkish club: the same in Turkish, with yedek", async ({ request, db }) => {
    await db.run(`UPDATE "Organisation" SET language = 'tr' WHERE id = $1`, [ORG_ID]);
    await db.run(`UPDATE "Attendance" SET status = 'BENCH' WHERE "matchId" = $1 AND "userId" = $2`, [MATCH.upcoming, U.third]);
    engineOn({ "Pat çıktı": { route: "other_att", facts: otherFacts("Pat", "out") } });
    const out = await say(request, "Pat çıktı");
    expect(out.replyText).toBe(
      'Tamam: Pat Player çıktı. 3/4, yedekte 1 kişi (Tom Third). Bir yer boş. Yedekten kimin gireceğini kendi cümlelerinizle yazmanız yeterli (örneğin Tom Third).',
    );
    await db.run(`UPDATE "Organisation" SET language = 'en' WHERE id = $1`, [ORG_ID]);
  });
});

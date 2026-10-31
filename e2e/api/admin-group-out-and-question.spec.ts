/**
 * A SQUAD CHANGE THAT ALSO ASKS MATCHTIME SOMETHING, IN THE ADMIN GROUP
 * (FNF HQ, 2026-10-24 13:47), against a real Postgres and the real route.
 *
 * Kemal (FNF's owner) wrote "Glazers is out now.\n\n@Match Time what is the
 * list?". Glazers had been removed from the club and dropped from the match
 * minutes before, so he was on no roster. The router said other_att; the
 * attendance extractor read one claim (Glazers out, 0.85) and
 * `sideRequests: []`; nothing moved; MatchTime said nothing (hqOutcome
 * "silent"). Two defects: the tagged question had nowhere to go, and an OUT
 * for a name not on the list changed nothing and said nothing.
 *
 * The router, the HQ squad reader and the question extractor are
 * STUBBED (what the models would have said, the extractor now reporting the
 * question as a side request). Everything after is the shipped code.
 *
 * The fixture club (E2E Test FC, weekly) has its upcoming match at 4 of 5:
 * Alex Admin (OWNER), Colin Collector, Pat Player, Tom Third; Ben Bench on
 * the bench. Glazers is added here as a former member, DROPPED on the match.
 */
import { test, expect, resetDb } from "../fixtures";
import { MATCH, ORG_ID, PHONE, U } from "../helpers/constants";
import { E2E } from "../helpers/env";
import { engineOn, clearPipelineStubs, otherFacts, changeReading } from "../helpers/stub";
import type { TestDb } from "../helpers/test-db";
import type { APIRequestContext } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const KEY = { "x-api-key": E2E.WHATSAPP_API_KEY };
const HQ = "120363777000000091@g.us";
const ADMIN = PHONE.admin.replace(/^\+/, "");
const PLAYER = PHONE.player.replace(/^\+/, "");
const GLAZERS = "e2e-agoq-glazers";

/** The incident's exact words. */
const INCIDENT = "Glazers is out now.\n\n@Match Time what is the list?";
const UNTAGGED = "Glazers is out now";
const TR = "Glazers yok.\n\n@Match Time liste ne?";
const TOM_AND_LIST = "Tom is out.\n\n@Match Time what is the list?";
const TOM_UNTAGGED_Q = "Tom is out, who's got the bibs?";

/** The question extractor's raw answer, for the same body. */
const SQUAD_Q = { topic: "squad", personRef: "", statedCount: -1, table: "none", listSize: -1, listEnd: "top", period: "none", periodCount: -1, periodUnit: "none", feature: "none" };
/** One body answers both extractors: each reads its own fields. */
const outAndAsks = (who: string) => ({ ...otherFacts(who, "out", { confidence: 0.85 }), sideRequests: ["question"], ...SQUAD_Q });

/** The squad line, and the answer after it (which has blank lines of its own). */
const parts = (reply: unknown): [string, string] => {
  const s = String(reply);
  const i = s.indexOf("\n\n");
  return i < 0 ? [s, ""] : [s.slice(0, i), s.slice(i + 2)];
};

let seq = 0;
// Tagged by default: HQ answers only the Pi's real mention flag (2026-10-31).
async function say(request: APIRequestContext, text: string, senderPhone = ADMIN, tagged = true) {
  const messageId = `e2e-agoq-${++seq}`;
  const res = await request.post("/api/whatsapp/admin-group", {
    headers: KEY,
    data: { channel: "admin-group", botMentioned: tagged, groupId: HQ, messageId, text, senderPhone, timestamp: String(Math.floor(Date.now() / 1000)) },
  });
  expect(res.status(), await res.text()).toBe(200);
  return { ...(await res.json()), messageId };
}

const statusOf = async (db: TestDb, userId: string) =>
  (await db.one<{ status: string }>(`SELECT status FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`, [MATCH.upcoming, userId]))?.status ?? null;

test.beforeAll(async ({ db }) => {
  resetDb();
  await db.run(`UPDATE "Organisation" SET "adminGroupId" = $2, "adminChannelMode" = 'admin-group' WHERE id = $1`, [ORG_ID, HQ]);
  // Glazers: removed from the club, and dropped from the match, before the message.
  await db.run(`INSERT INTO "User" (id, email, name, "updatedAt") VALUES ($1, 'e2e-agoq-glazers@e2e.test', 'Glazers', now())`, [GLAZERS]);
  await db.run(`INSERT INTO "Membership" (id, "userId", "orgId", role, "leftAt") VALUES ('e2e-agoq-glazers-m', $1, $2, 'PLAYER', now())`, [GLAZERS, ORG_ID]);
  await db.run(`INSERT INTO "Attendance" (id, "matchId", "userId", status, position, "updatedAt") VALUES ('e2e-agoq-glazers-a', $1, $2, 'DROPPED', 9, now())`, [MATCH.upcoming, GLAZERS]);
  // The HQ squad reader reads the change and the question beside it
  // (2026-10-30); the question extractor reads its own fields from `facts`.
  const glazersOut = (alsoAsks: boolean) => changeReading([[{ new: "Glazers" }, "out"]], { alsoAsks });
  const tomOut = changeReading([["Tom Third", "out"]], { alsoAsks: true });
  engineOn({
    [INCIDENT]: { route: "other_att", facts: outAndAsks("Glazers"), reading: glazersOut(true) },
    [UNTAGGED]: { route: "other_att", reading: glazersOut(false) },
    [TR]: { route: "other_att", facts: outAndAsks("Glazers"), reading: glazersOut(true) },
    [TOM_AND_LIST]: { route: "other_att", facts: outAndAsks("Tom"), reading: tomOut },
    [TOM_UNTAGGED_Q]: { route: "other_att", facts: outAndAsks("Tom"), reading: tomOut },
  });
});

test.afterAll(() => {
  clearPipelineStubs();
  resetDb();
});

test("the incident: says Glazers is not on the list, then answers with the list, and records it", async ({ request, db }) => {
  const out = await say(request, INCIDENT);
  expect(out).toMatchObject({ handled: true, outcome: "squad-not-on-list+hq-answered", react: "✅" });
  const [line, list] = parts(out.replyText);
  expect(line).toMatch(/^I can't find Glazers on the list for .+, so nothing changed\.$/);
  // The players' group's own squad answer, from the real club.
  expect(list).toMatch(/Alex Admin/);
  expect(list).toMatch(/Tom Third/);
  expect(list).toMatch(/Ben Bench/);
  expect(list).not.toMatch(/Glazers/);
  expect(await statusOf(db, GLAZERS)).toBe("DROPPED");
  // The decision is on the HQ row, as the manager traced it.
  const row = await db.one<{ hqOutcome: string }>(`SELECT "hqOutcome" FROM "AdminGroupMessage" WHERE "waMessageId" = $1`, [out.messageId]);
  expect(row?.hqOutcome).toBe("squad-not-on-list+hq-answered");
});

test("the organiser's untagged instruction (2026-10-31): silent, nothing said", async ({ request }) => {
  expect(await say(request, UNTAGGED, ADMIN, false)).toMatchObject({ handled: false, replyText: null });
});

test("the same, tagged: the line alone, no tick (nothing was done)", async ({ request }) => {
  const out = await say(request, UNTAGGED);
  expect(out).toMatchObject({ handled: true, outcome: "squad-not-on-list", react: null });
  expect(out.replyText).toMatch(/^I can't find Glazers on the list for .+, so nothing changed\.$/);
});

test("the same from a player who is not an organiser, untagged: silence, as chatter", async ({ request }) => {
  expect(await say(request, UNTAGGED, PLAYER, false)).toMatchObject({ handled: false, replyText: null });
});

test("in Turkish", async ({ request, db }) => {
  await db.run(`UPDATE "Organisation" SET language = 'tr' WHERE id = $1`, [ORG_ID]);
  const out = await say(request, TR);
  await db.run(`UPDATE "Organisation" SET language = 'en' WHERE id = $1`, [ORG_ID]);
  expect(out).toMatchObject({ handled: true, outcome: "squad-not-on-list+hq-answered" });
  expect(parts(out.replyText)[0]).toMatch(/^.+ listesinde Glazers adında birini bulamadım, bu yüzden hiçbir şey değişmedi\.$/);
});

test("a change that lands, with the question: done, then the NEW list", async ({ request, db }) => {
  const out = await say(request, TOM_AND_LIST);
  expect(out).toMatchObject({ handled: true, outcome: "squad-changed+hq-answered", react: "✅" });
  const [done, list] = parts(out.replyText);
  expect(done).toMatch(/^Done: Tom Third out\./);
  expect(list).not.toMatch(/Tom Third/);
  expect(await statusOf(db, U.third)).toBe("DROPPED");
});

// 2026-10-31 (Kemal: "real tag pls"): untagged, neither the change nor the question.
test("a change and a question in HQ not asked of MatchTime: the organisers' own, nothing changed or said", async ({ request, db }) => {
  await db.run(`UPDATE "Attendance" SET status = 'CONFIRMED' WHERE "matchId" = $1 AND "userId" = $2`, [MATCH.upcoming, U.third]);
  expect(await say(request, TOM_UNTAGGED_Q, ADMIN, false)).toMatchObject({ handled: false, replyText: null });
  expect(await statusOf(db, U.third)).toBe("CONFIRMED");
});

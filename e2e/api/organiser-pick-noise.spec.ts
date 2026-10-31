/**
 * ORGANISER PICK, ONE PROMPT PER OPENING (2026-10-15), against Postgres and
 * the real routes. The club rehearsal of a Friday club ("the organisers
 * pick", HQ linked as the admin group) showed two kinds of noise in HQ:
 *
 *   1. In the first week, before any list existed (squad 0/18, one admin on
 *      the bench, a pasted list waiting for YES), HQ was asked to pick for
 *      "18 places open".
 *   2. Every change the admins made themselves ("put X in", "Y out")
 *      superseded the open round, and the new round carried the old
 *      round's drops, so HQ was told again that the same people had
 *      dropped out.
 *
 * Here: the admin group's own squad changes go through the real
 * admin-group route with the router and extractor STUBBED (no model);
 * players' OUT and IN go through the real attendance route; the pick
 * messages come from real due-posts polls. One STAND-IN: the pasted list
 * waiting for YES is inserted directly (its own route stamps its expiry on
 * the real clock, which these polls do not run on).
 *
 * The pick reader (2026-10-30) is STUBBED too: "4" picks the fourth on
 * the list, and every other HQ line is no pick and goes on to the
 * pipeline. January 2027, so London is GMT. Nothing here calls a model.
 */
import { test, expect, resetDb } from "../fixtures";
import { E2E } from "../helpers/env";
import { engineOn, clearPipelineStubs, changeReading, setOrganiserPickReaderStub } from "../helpers/stub";
import type { TestDb } from "../helpers/test-db";
import type { APIRequestContext } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const KEY = { "x-api-key": E2E.WHATSAPP_API_KEY };
const ORG = "e2e-opn-org";
const GROUP = "e2e-opn-group@g.us";
const HQ = "120363777000000041@g.us";
const MATCH_ID = "e2e-opn-match";
/** Friday 15 January 2027, 20:30 GMT. */
const KICKOFF = new Date("2027-01-15T20:30:00.000Z");
/** Wednesday 13 January, inside the pick hours. */
const WED = (hhmm: string) => `2027-01-13T${hhmm}:00.000Z`;

const P = {
  hamzah: { id: "e2e-opn-hamzah", name: "Hamzah Hussain", phone: "+447700950001" },
  raihan: { id: "e2e-opn-raihan", name: "Raihan Rahman", phone: "+447700950002" },
  carl: { id: "e2e-opn-carl", name: "Carl Cole", phone: "+447700950003" },
  dan: { id: "e2e-opn-dan", name: "Dan Dore", phone: "+447700950004" },
  eve: { id: "e2e-opn-eve", name: "Eve Ede", phone: "+447700950005" },
  kemal: { id: "e2e-opn-kemal", name: "Kemal Kaya", phone: "+447700950006" },
  wasim: { id: "e2e-opn-wasim", name: "Wasim Wali", phone: "+447700950007" },
  zed: { id: "e2e-opn-zed", name: "Zed Zulu", phone: "+447700950008" },
  ali: { id: "e2e-opn-ali", name: "Ali Aziz", phone: "+447700950009" },
  bob: { id: "e2e-opn-bob", name: "Bob Bell", phone: "+447700950010" },
  fay: { id: "e2e-opn-fay", name: "Fay Ford", phone: "+447700950011" },
} as const;
const digits = (p: string) => p.replace(/^\+/, "");

async function post(request: APIRequestContext, path: string, data: Record<string, unknown>) {
  const res = await request.post(path, { headers: KEY, data });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

/** The pick messages a real due-posts poll sends to the admin group. */
async function pickPosts(request: APIRequestContext, now: string): Promise<string[]> {
  const res = await request.get(`/api/whatsapp/due-posts?groupId=${encodeURIComponent(GROUP)}`, {
    headers: { ...KEY, "x-test-now": now, "x-mt-pi-caps": "admin-group" },
  });
  expect(res.status(), await res.text()).toBe(200);
  const instructions = (await res.json()).instructions as Array<{ kind: string; groupId?: string; text?: string }>;
  return instructions
    .filter((i) => i.kind === "admin-group-message" && /^(Bench|Yedek listesi):$/m.test(i.text ?? ""))
    .map((i) => i.text ?? "");
}

/** A player's own OUT or IN, in the players' group. */
const says = (request: APIRequestContext, who: { phone: string }, action: "IN" | "OUT") =>
  post(request, "/api/whatsapp/attendance", { phoneNumber: digits(who.phone), action, groupId: GROUP });

let seq = 0;
/** An admin's squad change in HQ, read by the real route (router stubbed). */
async function hq(request: APIRequestContext, text: string, person: string, polarity: "in" | "out") {
  // The HQ squad reader reads the change (2026-10-30), the member by name.
  const member = Object.values(P).find((p) => p.name.split(" ")[0] === person)?.name ?? person;
  engineOn({ [text]: { route: "other_att", reading: changeReading([[member, polarity]]) } });
  return post(request, "/api/whatsapp/admin-group", {
    channel: "admin-group",
    botMentioned: true,
    groupId: HQ,
    messageId: `e2e-opn-msg-${++seq}`,
    text,
    senderPhone: digits(P.hamzah.phone),
    timestamp: String(Math.floor(Date.now() / 1000)),
  });
}

const statusOf = async (db: TestDb, userId: string) =>
  (await db.one<{ status: string }>(`SELECT status FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`, [MATCH_ID, userId]))?.status;

const rounds = (db: TestDb) =>
  db.all<{ id: string; openPlaces: number; resolvedAt: Date | null; outcome: string | null; reason: string }>(
    `SELECT id, "openPlaces", "resolvedAt", outcome, reason FROM "OrganiserPickRound" WHERE "matchId" = $1 ORDER BY "createdAt"`,
    [MATCH_ID],
  );

async function setStatus(db: TestDb, who: { id: string }, status: string, position: number) {
  await db.run(
    `INSERT INTO "Attendance" (id, "matchId", "userId", status, position, "updatedAt")
     VALUES ($1, $2, $3, $4::"AttendanceStatus", $5, now())
     ON CONFLICT ("matchId", "userId") DO UPDATE SET status = EXCLUDED.status, position = EXCLUDED.position`,
    [`${who.id}-att`, MATCH_ID, who.id, status, position],
  );
}

test.beforeAll(async ({ db }) => {
  resetDb();
  setOrganiserPickReaderStub({ bodies: { "4": { kind: "pick", positions: [4] } } });
  await db.run(
    `INSERT INTO "Organisation" (id, name, slug, "inviteCode", "whatsappGroupId", "whatsappBotEnabled",
       "benchPickMode", "benchPickFallback", "listAnnouncer", "adminChannelMode", "adminGroupId", "adminGroupSubject", "updatedAt")
     VALUES ($1, 'Friday FNF', 'e2e-opn-fnf', 'e2e-opn-invite', $2, true, 'organiser', 'leave-empty', 'organisers',
       'admin-group', $3, 'FNF HQ', now())`,
    [ORG, GROUP, HQ],
  );
  await db.run(
    `INSERT INTO "Sport" (id, "orgId", name, "playersPerTeam", positions, "teamLabels", "updatedAt")
     VALUES ('e2e-opn-sport', $1, 'Football 2-a-side', 2, ARRAY['GK','DEF','MID','FWD'], ARRAY['Red','Yellow'], now())`,
    [ORG],
  );
  await db.run(
    `INSERT INTO "Activity" (id, "orgId", "sportId", name, "dayOfWeek", time, venue, "deadlineHours", "updatedAt")
     VALUES ('e2e-opn-act', $1, 'e2e-opn-sport', 'Friday 9-a-side', 5, '20:30', 'Goals', 1, now())`,
    [ORG],
  );
  for (const p of Object.values(P)) {
    await db.run(`INSERT INTO "User" (id, email, name, "phoneNumber", "updatedAt") VALUES ($1, $2, $3, $4, now())`, [
      p.id,
      `${p.id}@e2e.test`,
      p.name,
      p.phone,
    ]);
    const role = p === P.hamzah ? "OWNER" : p === P.raihan ? "ADMIN" : "PLAYER";
    await db.run(`INSERT INTO "Membership" (id, "userId", "orgId", role) VALUES ($1, $2, $3, $4)`, [`${p.id}-mem`, p.id, ORG, role]);
  }
  await db.run(
    `INSERT INTO "Match" (id, "activityId", date, "maxPlayers", status, "attendanceDeadline", "updatedAt")
     VALUES ($1, 'e2e-opn-act', $2, 4, 'UPCOMING', $3, now())`,
    [MATCH_ID, KICKOFF.toISOString(), new Date(KICKOFF.getTime() - 3600_000).toISOString()],
  );
  // The first week: nobody is in yet, and one admin has put himself on the
  // bench ("I'd rather just be a backup").
  await setStatus(db, P.hamzah, "BENCH", 1);
});

test.afterAll(() => {
  clearPipelineStubs();
  resetDb();
});

test("FIRST WEEK: squad 0/4 and one admin on the bench: no pick message, with or without a pasted list waiting", async ({ request, db }) => {
  // A pasted list is waiting for YES (stand-in, see the header).
  await db.run(
    `INSERT INTO "AdminSquadProposal" (id, "orgId", "matchId", "waMessageId", "proposedByUserId", "playingUserIds", "expiresAt")
     VALUES ('e2e-opn-paste-1', $1, $2, 'e2e-opn-paste-msg-1', $3, ARRAY[$4, $5, $6, $7], $8)`,
    [ORG, MATCH_ID, P.hamzah.id, P.carl.id, P.dan.id, P.eve.id, P.zed.id, WED("13:00")],
  );
  expect(await pickPosts(request, WED("10:00"))).toEqual([]);
  expect(await rounds(db)).toEqual([]);

  // The list was set aside: still nobody confirmed, still no prompt.
  await db.run(`UPDATE "AdminSquadProposal" SET "resolvedAt" = now(), outcome = 'superseded' WHERE id = 'e2e-opn-paste-1'`);
  expect(await pickPosts(request, WED("10:05"))).toEqual([]);
  expect(await rounds(db)).toEqual([]);
});

test("a pasted list waiting for YES holds the pick message; once it is answered, the drop is asked about", async ({ request, db }) => {
  // The squad is set: four in, three on the bench.
  await setStatus(db, P.carl, "CONFIRMED", 2);
  await setStatus(db, P.dan, "CONFIRMED", 3);
  await setStatus(db, P.eve, "CONFIRMED", 4);
  await setStatus(db, P.zed, "CONFIRMED", 5);
  await setStatus(db, P.kemal, "BENCH", 6);
  await setStatus(db, P.wasim, "BENCH", 7);
  await db.run(
    `INSERT INTO "AdminSquadProposal" (id, "orgId", "matchId", "waMessageId", "proposedByUserId", "playingUserIds", "expiresAt")
     VALUES ('e2e-opn-paste-2', $1, $2, 'e2e-opn-paste-msg-2', $3, ARRAY[$4], $5)`,
    [ORG, MATCH_ID, P.hamzah.id, P.dan.id, WED("12:00")],
  );

  await says(request, P.carl, "OUT");
  expect(await statusOf(db, P.carl.id)).toBe("DROPPED");
  expect(await pickPosts(request, WED("11:00"))).toEqual([]);
  expect(await rounds(db)).toEqual([]);

  // The list has expired: the drop is news, asked about once.
  const posts = await pickPosts(request, WED("12:01"));
  expect(posts).toHaveLength(1);
  expect(posts[0].split("\n")[0]).toBe("*Carl Cole* dropped out of *Friday 9-a-side* (Fri 15 Jan at 20:30). 1 place open, squad 3/4.");
  expect(await rounds(db)).toMatchObject([{ openPlaces: 1, resolvedAt: null, reason: "drop" }]);
});

test("STALE REPOST: the admins take Dan out and put Ali in themselves: no new pick message naming Carl again", async ({ request, db }) => {
  expect(await hq(request, "Dan out", "Dan", "out")).toMatchObject({ handled: true });
  expect(await statusOf(db, P.dan.id)).toBe("DROPPED");
  expect(await pickPosts(request, WED("13:30"))).toEqual([]);
  // The open round answers on, and knows the count.
  expect(await rounds(db)).toMatchObject([{ openPlaces: 2, resolvedAt: null }]);

  // "put Ali in" (not on the bench): the admins filled a place.
  expect(await hq(request, "put Ali in", "Ali", "in")).toMatchObject({ handled: true });
  expect(await statusOf(db, P.ali.id)).toBe("CONFIRMED");
  expect(await pickPosts(request, WED("15:00"))).toEqual([]);
  expect(await rounds(db)).toMatchObject([{ openPlaces: 1, resolvedAt: null }]);
});

test("a player's new drop is asked about once, naming only that drop; the admins' next fill posts nothing", async ({ request, db }) => {
  await says(request, P.eve, "OUT");
  const posts = await pickPosts(request, WED("16:30"));
  expect(posts).toHaveLength(1);
  expect(posts[0].split("\n")[0]).toBe("*Eve Ede* dropped out of *Friday 9-a-side* (Fri 15 Jan at 20:30). 2 places open, squad 2/4.");
  expect(await pickPosts(request, WED("16:35"))).toEqual([]);

  // "put Bob in" (17 of 18 in the rehearsal): Eve's drop is not announced again.
  expect(await hq(request, "put Bob in", "Bob", "in")).toMatchObject({ handled: true });
  expect(await statusOf(db, P.bob.id)).toBe("CONFIRMED");
  expect(await pickPosts(request, WED("18:00"))).toEqual([]);
  const r = await rounds(db);
  expect(r).toHaveLength(2);
  expect(r[1]).toMatchObject({ openPlaces: 1, resolvedAt: null });
});

test("somebody new on the bench while a place is open: one short bench update, no drop-out named again", async ({ request, db }) => {
  await says(request, P.fay, "IN");
  expect(await statusOf(db, P.fay.id)).toBe("BENCH");
  const posts = await pickPosts(request, WED("19:30"));
  expect(posts).toHaveLength(1);
  expect(posts[0]).toBe(
    [
      "The bench for *Friday 9-a-side* (Fri 15 Jan at 20:30) has changed. 1 place open, squad 3/4.",
      "",
      "Bench:",
      "1. Hamzah Hussain (no position, new)",
      "2. Kemal Kaya (no position, new)",
      "3. Wasim Wali (no position, new)",
      "4. Fay Ford (no position, new)",
      "",
      "Tag me with a number, a name or an @tag, e.g. *@Match Time 2*, or *@Match Time 2 3* for two. *@Match Time NONE* leaves it open. To tag me, type *@* and pick *Match Time* from the list.",
    ].join("\n"),
  );
  expect(await pickPosts(request, WED("19:35"))).toEqual([]);
  // A number answers the list as just sent. (Sent with a millisecond
  // timestamp: whole seconds would read as typed before the list went out,
  // which is the stale-numbers rule doing its job.)
  const picked = await post(request, "/api/whatsapp/admin-group", {
    channel: "admin-group",
    botMentioned: true,
    groupId: HQ,
    messageId: `e2e-opn-msg-${++seq}`,
    text: "4",
    senderPhone: digits(P.hamzah.phone),
    timestamp: new Date().toISOString(),
  });
  expect(picked).toMatchObject({ handled: true, outcome: "picked" });
  expect(await statusOf(db, P.fay.id)).toBe("CONFIRMED");
});

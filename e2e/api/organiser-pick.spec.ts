/**
 * ORGANISER PICK, END TO END AGAINST POSTGRES (slice 2b, 2026-10-01).
 * Plan: MDs/friday-group-features-plan-2026-09-30.md, sections 2.6 to 2.13.
 *
 * A Friday 9-a-side style club (4 places here, to keep it short) with
 * "the organisers pick" on and its HQ group linked as the admin group:
 *
 *   1. an OUT opens ONE pick round, posted in the admin group (a Pi that
 *      can post there), and no bench offer;
 *   2. "2" from an admin picks the second on the list: A1 back in the admin
 *      group, A2 in the community group, A3 to the player by DM;
 *   3. a second admin's reply after that gets E3 "Already filled", and two
 *      admins at the same instant: one A1, one E3;
 *   4. a name ("Kemal") and a real @tag each pick; an @tag nobody can be
 *      matched to gets E4; chat is ignored; an already-in player is E2;
 *   5. a club member not on the list: E1, then YES brings them in;
 *   6. nobody picks in time: the place is offered to the waiting list (D5);
 *   7. one-person DM mode: the owner's DM reply is read the same way;
 *   8. Sutton's shape (first-come, the fixture club) is unchanged: an IN
 *      takes a free place and an OUT opens a bench offer, no pick round.
 *
 * Deterministic: nothing here calls a model. January, so London is GMT.
 */
import { test, expect, resetDb } from "../fixtures";
import { MATCH, ORG_ID, PHONE, U } from "../helpers/constants";
import { E2E } from "../helpers/env";
import type { TestDb } from "../helpers/test-db";
import type { APIRequestContext } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const KEY = { "x-api-key": E2E.WHATSAPP_API_KEY };
const ORG = "e2e-op-org";
const GROUP = "e2e-op-group@g.us";
const HQ = "120363777000000031@g.us";
const MATCH_ID = "e2e-op-match";
/** Friday 15 January 2027, 20:30 GMT. */
const KICKOFF = new Date("2027-01-15T20:30:00.000Z");
/** Wednesday 13 January, 12:00: inside the pick hours. */
const WED_NOON = "2027-01-13T12:00:00.000Z";

const P = {
  hamzah: { id: "e2e-op-hamzah", name: "Hamzah Hussain", phone: "+447700940001" },
  raihan: { id: "e2e-op-raihan", name: "Raihan Rahman", phone: "+447700940002" },
  carl: { id: "e2e-op-carl", name: "Carl Cole", phone: "+447700940003" },
  dan: { id: "e2e-op-dan", name: "Dan Dore", phone: "+447700940004" },
  eve: { id: "e2e-op-eve", name: "Eve Ede", phone: "+447700940005" },
  kemal: { id: "e2e-op-kemal", name: "Kemal Kaya", phone: "+447700940006" },
  wasim: { id: "e2e-op-wasim", name: "Wasim Wali", phone: "+447700940007" },
  ali: { id: "e2e-op-ali", name: "Ali Aziz", phone: "+447700940008" },
  bob: { id: "e2e-op-bob", name: "Bob Bell", phone: "+447700940009" },
  cem: { id: "e2e-op-cem", name: "Cem Can", phone: "+447700940010" },
  zed: { id: "e2e-op-zed", name: "Zed Zulu", phone: "+447700940011" },
} as const;
const digits = (p: string) => p.replace(/^\+/, "");

async function post(request: APIRequestContext, path: string, data: Record<string, unknown>) {
  const res = await request.post(path, { headers: KEY, data });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

/** A real due-posts poll (claiming), from a Pi that can post in admin groups. */
async function poll(request: APIRequestContext, groupId: string, now: string) {
  const res = await request.get(`/api/whatsapp/due-posts?groupId=${encodeURIComponent(groupId)}`, {
    headers: { ...KEY, "x-test-now": now, "x-mt-pi-caps": "admin-group" },
  });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()).instructions as Array<{ kind: string; groupId?: string; text?: string; phone?: string }>;
}

const out = (request: APIRequestContext, who: { phone: string }) =>
  post(request, "/api/whatsapp/attendance", { phoneNumber: digits(who.phone), action: "OUT", groupId: GROUP });

let msgSeq = 0;
function reply(request: APIRequestContext, from: { phone: string }, text: string, extra: Record<string, unknown> = {}) {
  return post(request, "/api/whatsapp/admin-group", {
    channel: "admin-group",
    groupId: HQ,
    messageId: `e2e-op-msg-${++msgSeq}`,
    text,
    senderPhone: digits(from.phone),
    timestamp: new Date().toISOString(),
    ...extra,
  });
}

const statusOf = async (db: TestDb, userId: string) =>
  (await db.one<{ status: string }>(`SELECT status FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`, [MATCH_ID, userId]))?.status;

const rounds = (db: TestDb) =>
  db.all<{ id: string; channel: string; listUserIds: string[]; resolvedAt: Date | null; outcome: string | null; reason: string }>(
    `SELECT id, channel, "listUserIds", "resolvedAt", outcome, reason FROM "OrganiserPickRound" WHERE "matchId" = $1 ORDER BY "createdAt"`,
    [MATCH_ID],
  );

const jobs = (db: TestDb) =>
  db.all<{ kind: string; phone: string | null; text: string }>(`SELECT kind, phone, text FROM "BotJob" WHERE "orgId" = $1 ORDER BY "createdAt"`, [ORG]);

/** Poll until a pick message is emitted to the admin group, and return it. */
async function pickMessage(request: APIRequestContext, now = WED_NOON) {
  const instructions = await poll(request, GROUP, now);
  return instructions.filter((i) => i.kind === "admin-group-message");
}

test.beforeAll(async ({ db }) => {
  resetDb();
  await db.run(
    `INSERT INTO "Organisation" (id, name, slug, "inviteCode", "whatsappGroupId", "whatsappBotEnabled",
       "benchPickMode", "adminChannelMode", "adminGroupId", "adminGroupSubject", "updatedAt")
     VALUES ($1, 'Friday FNF', 'e2e-op-fnf', 'e2e-op-invite', $2, true, 'organiser', 'admin-group', $3, 'FNF HQ', now())`,
    [ORG, GROUP, HQ],
  );
  await db.run(
    `INSERT INTO "Sport" (id, "orgId", name, "playersPerTeam", positions, "teamLabels", "updatedAt")
     VALUES ('e2e-op-sport', $1, 'Football 2-a-side', 2, ARRAY['GK','DEF','MID','FWD'], ARRAY['Red','Yellow'], now())`,
    [ORG],
  );
  await db.run(
    `INSERT INTO "Activity" (id, "orgId", "sportId", name, "dayOfWeek", time, venue, "deadlineHours", "updatedAt")
     VALUES ('e2e-op-act', $1, 'e2e-op-sport', 'Friday 9-a-side', 5, '20:30', 'Goals', 1, now())`,
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
     VALUES ($1, 'e2e-op-act', $2, 4, 'UPCOMING', $3, now())`,
    [MATCH_ID, KICKOFF.toISOString(), new Date(KICKOFF.getTime() - 3600_000).toISOString()],
  );
  const squad: Array<[{ id: string }, string]> = [
    [P.hamzah, "CONFIRMED"],
    [P.carl, "CONFIRMED"],
    [P.dan, "CONFIRMED"],
    [P.eve, "CONFIRMED"],
    [P.kemal, "BENCH"],
    [P.wasim, "BENCH"],
    [P.ali, "BENCH"],
    [P.bob, "BENCH"],
    [P.cem, "BENCH"],
  ];
  for (const [i, [p, status]] of squad.entries()) {
    await db.run(
      `INSERT INTO "Attendance" (id, "matchId", "userId", status, position, "updatedAt") VALUES ($1, $2, $3, $4::"AttendanceStatus", $5, now())`,
      [`${p.id}-att`, MATCH_ID, p.id, status, i + 1],
    );
  }
  await db.run(
    `INSERT INTO "PlayerActivityPosition" (id, "userId", "activityId", positions, "updatedAt") VALUES ('e2e-op-pos', $1, 'e2e-op-act', ARRAY['GK'], now())`,
    [P.kemal.id],
  );
});

test.afterAll(() => {
  resetDb();
});

test("an OUT opens one pick round, posted in the admin group; no bench offer", async ({ request, db }) => {
  await out(request, P.carl);
  expect(await statusOf(db, P.carl.id)).toBe("DROPPED");
  expect(await db.all(`SELECT id FROM "BenchSlotOffer" WHERE "matchId" = $1`, [MATCH_ID])).toEqual([]);

  const posts = await pickMessage(request);
  expect(posts).toHaveLength(1);
  expect(posts[0].groupId).toBe(HQ);
  expect(posts[0].text).toBe(
    [
      "*Carl Cole* dropped out of *Friday 9-a-side* (Fri 15 Jan at 20:30). 1 place open, squad 3/4.",
      "",
      "Waiting list:",
      "1. Kemal Kaya (GK, new)",
      "2. Wasim Wali (no position, new)",
      "3. Ali Aziz (no position, new)",
      "4. Bob Bell (no position, new)",
      "5. Cem Can (no position, new)",
      "",
      "Reply here with a number, a name or an @tag, e.g. *2*, or *2 3* for two. *NONE* leaves it open.",
      "If nobody picks by Thursday 12:00, I'll offer the place to the whole waiting list.",
    ].join("\n"),
  );
  const r = await rounds(db);
  expect(r).toHaveLength(1);
  expect(r[0]).toMatchObject({ channel: "admin-group", reason: "drop", resolvedAt: null });

  // The next poll sends nothing new.
  expect(await pickMessage(request)).toEqual([]);
  expect(await rounds(db)).toHaveLength(1);
});

test("a chat message and a non-admin's number are ignored while the round is open", async ({ request }) => {
  expect(await reply(request, P.hamzah, "Wasim played well last week")).toMatchObject({ ignored: "not-a-pick", replyText: null });
  expect(await reply(request, P.kemal, "2")).toMatchObject({ ignored: "not-an-admin", replyText: null });
});

test("'2' picks the second on the list: A1 here, A2 in the group, A3 to the player", async ({ request, db }) => {
  await db.run(`DELETE FROM "BotJob" WHERE "orgId" = $1`, [ORG]);
  const res = await reply(request, P.raihan, "2");
  expect(res).toMatchObject({ handled: true, replyText: "✅ Done: *Wasim Wali* is in, replacing *Carl Cole* (picked by Raihan Rahman)." });
  expect(await statusOf(db, P.wasim.id)).toBe("CONFIRMED");
  const ev = await db.one<{ cause: string; actorKind: string; actorUserId: string }>(
    `SELECT cause, "actorKind", "actorUserId" FROM "AttendanceEvent" WHERE "matchId" = $1 AND "userId" = $2 ORDER BY at DESC LIMIT 1`,
    [MATCH_ID, P.wasim.id],
  );
  expect(ev).toEqual({ cause: "organiser-pick", actorKind: "admin", actorUserId: P.raihan.id });
  const j = await jobs(db);
  expect(j).toContainEqual({ kind: "group", phone: null, text: "✅ *Wasim Wali* is in, replacing *Carl Cole*. Squad *4/4*." });
  expect(j).toContainEqual({
    kind: "dm",
    phone: digits(P.wasim.phone),
    text: "You're in for Friday 20:30 at Goals ⚽ Can't make it after all? Just say *OUT*.",
  });
  expect((await rounds(db))[0]).toMatchObject({ outcome: "filled" });
  // The squad-complete post in an organiser club: the waiting list, never
  // "first to reply IN takes the slot".
  const complete = j.filter((x) => x.kind === "group" && x.text.includes("Squad complete"));
  expect(complete).toHaveLength(1);
  expect(complete[0].text).toContain("🪑 *Waiting list is open.* Say *IN* to go on the waiting list, and the organisers will pick who plays.");
  expect(j.some((x) => /takes the slot|first to reply/.test(x.text))).toBe(false);
});

test("a second admin's reply after the pick: E3 'Already filled'", async ({ request }) => {
  expect((await reply(request, P.hamzah, "3")).replyText).toBe("Already filled: *Wasim Wali* is in (picked by Raihan Rahman).");
  // A Pi retry of the same WhatsApp message applies nothing twice.
  const again = { channel: "admin-group", groupId: HQ, messageId: `e2e-op-msg-${msgSeq}`, text: "3", senderPhone: digits(P.hamzah.phone) };
  expect(await post(request, "/api/whatsapp/admin-group", again)).toMatchObject({ ignored: "duplicate", replyText: null });
});

test("two admins at the same instant: one gets the place, the other E3", async ({ request, db }) => {
  await out(request, P.dan);
  expect(await pickMessage(request)).toHaveLength(1);
  const [a, b] = await Promise.all([reply(request, P.hamzah, "1"), reply(request, P.raihan, "2")]);
  const texts = [a.replyText, b.replyText];
  expect(texts.filter((x: string) => x.startsWith("✅ Done:"))).toHaveLength(1);
  expect(texts.filter((x: string) => x.startsWith("Already filled:"))).toHaveLength(1);
  const confirmed = await db.one<{ n: string }>(`SELECT count(*)::text AS n FROM "Attendance" WHERE "matchId" = $1 AND status = 'CONFIRMED'`, [MATCH_ID]);
  expect(confirmed?.n).toBe("4");
});

test("a name ('Wasim', '@Kemal') resolves; an already-in player is E2; an unknown @tag is E4; a real @tag picks", async ({ request, db }) => {
  await out(request, P.eve);
  expect(await pickMessage(request)).toHaveLength(1);
  expect((await reply(request, P.hamzah, "Wasim")).replyText).toBe("*Wasim Wali* is already in. Pick someone else?");
  expect((await reply(request, P.hamzah, "@447700999999", { mentionNames: [{ jid: "447700999999@c.us" }] })).replyText).toBe(
    "I couldn't tell who that is, can you type their name?",
  );
  const waiting = await db.all<{ userId: string }>(
    `SELECT "userId" FROM "Attendance" WHERE "matchId" = $1 AND status = 'BENCH' ORDER BY position`,
    [MATCH_ID],
  );
  const first = Object.values(P).find((p) => p.id === waiting[0].userId)!;
  // A name typed with "@" (not a real tag) reads as the name.
  const res = await reply(request, P.hamzah, `@${first.name.split(" ")[0]}`);
  expect(res.replyText).toBe(`✅ Done: *${first.name}* is in, replacing *Eve Ede* (picked by Hamzah Hussain).`);

  // A real @tag: the Pi leaves "@<digits>" in the text and says who it is.
  await out(request, first);
  expect(await pickMessage(request)).toHaveLength(1);
  const res2 = await reply(request, P.raihan, `@Match Time @${digits(P.cem.phone)}`, {
    mentionNames: [{ jid: `${digits(P.cem.phone)}@c.us`, name: "cem" }],
  });
  expect(res2.replyText).toMatch(/^✅ Done: \*Cem Can\* is in/);
  expect(await statusOf(db, P.cem.id)).toBe("CONFIRMED");
});

test("a club member not on the waiting list: E1, then YES brings them in", async ({ request, db }) => {
  await out(request, P.cem);
  expect(await pickMessage(request)).toHaveLength(1);
  expect((await reply(request, P.hamzah, "Zed")).replyText).toBe("*Zed Zulu* isn't on the waiting list. Bring them in anyway? Reply *YES*.");
  expect(await statusOf(db, P.zed.id)).toBeUndefined();
  const yes = await reply(request, P.raihan, "YES");
  expect(yes.replyText).toMatch(/^✅ Done: \*Zed Zulu\* is in, replacing \*Cem Can\* \(picked by Raihan Rahman\)\.$/);
  expect(await statusOf(db, P.zed.id)).toBe("CONFIRMED");
});

test("nobody picks in time (D5): the place is offered to the whole waiting list", async ({ request, db }) => {
  await out(request, P.zed);
  const posts = await pickMessage(request, "2027-01-13T13:00:00.000Z");
  expect(posts).toHaveLength(1);
  // A day later, past the fallback time.
  await db.run(`DELETE FROM "BotJob" WHERE "orgId" = $1`, [ORG]);
  const later = await poll(request, GROUP, "2027-01-14T13:30:00.000Z");
  const offers = await db.all<{ replacingUserId: string | null }>(
    `SELECT "replacingUserId" FROM "BenchSlotOffer" WHERE "matchId" = $1 AND "resolvedAt" IS NULL`,
    [MATCH_ID],
  );
  expect(offers).toEqual([{ replacingUserId: P.zed.id }]);
  const r = await rounds(db);
  expect(r[r.length - 1]).toMatchObject({ outcome: "fallback-bench-offer" });
  expect(later.map((i) => i.text)).toContain(
    "Nobody picked for *Friday 9-a-side*, so I've offered the place to the waiting list: the first to say IN gets it.",
  );
  // And no new round opens while the offer runs.
  expect((await pickMessage(request, "2027-01-14T14:00:00.000Z")).filter((i) => (i.text ?? "").includes("dropped out"))).toEqual([]);
  // The first on the waiting list to say IN takes it now.
  const bench = await db.all<{ userId: string }>(`SELECT "userId" FROM "Attendance" WHERE "matchId" = $1 AND status = 'BENCH' ORDER BY position`, [MATCH_ID]);
  const taker = Object.values(P).find((p) => p.id === bench[0].userId)!;
  const claim = await post(request, "/api/whatsapp/dm-reply", { phone: digits(taker.phone), body: "YES", waMessageId: "e2e-op-claim-1" });
  expect(claim.handled).not.toBe("organiser-pick");
  expect(await statusOf(db, taker.id)).toBe("CONFIRMED");
});

test("one person by DM: the owner's DM reply is read the same way", async ({ request, db }) => {
  await db.run(`UPDATE "Organisation" SET "adminChannelMode" = 'one-person', "adminChannelUserId" = NULL WHERE id = $1`, [ORG]);
  await db.run(`UPDATE "BenchSlotOffer" SET "resolvedAt" = now() WHERE "matchId" = $1`, [MATCH_ID]);
  // The waiting list is empty by now: Carl says IN again and, the squad
  // being full, goes on it.
  await post(request, "/api/whatsapp/attendance", { phoneNumber: digits(P.carl.phone), action: "IN", groupId: GROUP });
  expect(await statusOf(db, P.carl.id)).toBe("BENCH");
  const confirmed = await db.all<{ userId: string }>(`SELECT "userId" FROM "Attendance" WHERE "matchId" = $1 AND status = 'CONFIRMED' AND "userId" <> $2`, [MATCH_ID, P.hamzah.id]);
  const leaver = Object.values(P).find((p) => p.id === confirmed[0].userId)!;
  await out(request, leaver);
  await db.run(`DELETE FROM "BotJob" WHERE "orgId" = $1`, [ORG]);
  await poll(request, GROUP, "2027-01-14T15:00:00.000Z");
  const dm = (await jobs(db)).filter((j) => j.kind === "dm" && j.text.includes("dropped out"));
  expect(dm.map((j) => j.phone)).toEqual([digits(P.hamzah.phone)]);
  expect(dm[0].text).toContain("Reply with a number or a name to bring someone in");

  await db.run(`DELETE FROM "BotJob" WHERE "orgId" = $1`, [ORG]);
  const res = await post(request, "/api/whatsapp/dm-reply", { phone: digits(P.hamzah.phone), body: "1", waMessageId: "e2e-op-dm-1" });
  expect(res).toMatchObject({ ok: true, handled: "organiser-pick", outcome: "picked" });
  const replyJob = (await jobs(db)).find((j) => j.kind === "dm" && j.phone === digits(P.hamzah.phone));
  expect(replyJob?.text).toBe(`✅ Done: *Carl Cole* is in, replacing *${leaver.name}*.`);
  expect(await statusOf(db, P.carl.id)).toBe("CONFIRMED");
  // A Pi retry of the same DM applies nothing twice.
  const again = await post(request, "/api/whatsapp/dm-reply", { phone: digits(P.hamzah.phone), body: "1", waMessageId: "e2e-op-dm-1" });
  expect(again.handled).not.toBe("organiser-pick");
});

test("Sutton unchanged: a first-come club fills a free place on IN and offers a drop to the bench", async ({ request, db }) => {
  // The fixture club: 4/5 confirmed, Ben on the bench, first-come.
  await post(request, "/api/whatsapp/attendance", { phoneNumber: digits(PHONE.fresh), action: "IN", groupId: E2E.GROUP_ID });
  const fresh = await db.one<{ status: string }>(`SELECT status FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`, [MATCH.upcoming, U.fresh]);
  expect(fresh?.status).toBe("CONFIRMED");
  // Its squad-complete post keeps the first-come promise, unchanged.
  const complete = await db.all<{ text: string }>(`SELECT text FROM "BotJob" WHERE "orgId" = $1 AND kind = 'group' AND text LIKE '%Squad complete%'`, [ORG_ID]);
  expect(complete.map((x) => x.text).join("\n")).toContain("the first to reply *IN* takes the slot");
  await post(request, "/api/whatsapp/attendance", { phoneNumber: digits(PHONE.player), action: "OUT", groupId: E2E.GROUP_ID });
  expect(await db.all(`SELECT id FROM "BenchSlotOffer" WHERE "matchId" = $1 AND "resolvedAt" IS NULL`, [MATCH.upcoming])).toHaveLength(1);
  expect(await db.all(`SELECT id FROM "OrganiserPickRound" WHERE "orgId" = $1`, [ORG_ID])).toEqual([]);
});

test("slice 3: no pick round before the drop-out deadline; the summary IS the first round", async ({ request, db }) => {
  const O = "e2e-op-dl-org";
  const G = "e2e-op-dl-group@g.us";
  const H = "120363777000000032@g.us";
  const M = "e2e-op-dl-match";
  await db.run(
    `INSERT INTO "Organisation" (id, name, slug, "inviteCode", "whatsappGroupId", "whatsappBotEnabled", "benchPickMode",
       "adminChannelMode", "adminGroupId", "dropOutDeadlineDay", "dropOutDeadlineTime", "updatedAt")
     VALUES ($1, 'Deadline FNF', 'e2e-op-dl', 'e2e-op-dl-invite', $2, true, 'organiser', 'admin-group', $3, 1, '21:00', now())`,
    [O, G, H],
  );
  await db.run(
    `INSERT INTO "Sport" (id, "orgId", name, "playersPerTeam", positions, "teamLabels", "updatedAt")
     VALUES ('e2e-op-dl-sport', $1, 'Football 1-a-side', 1, ARRAY['GK'], ARRAY['Red','Yellow'], now())`,
    [O],
  );
  await db.run(
    `INSERT INTO "Activity" (id, "orgId", "sportId", name, "dayOfWeek", time, venue, "deadlineHours", "updatedAt")
     VALUES ('e2e-op-dl-act', $1, 'e2e-op-dl-sport', 'Friday 1-a-side', 5, '20:30', 'Goals', 1, now())`,
    [O],
  );
  const people = [
    ["e2e-op-dl-owner", "Olly Owner", "+447700941001", "OWNER"],
    ["e2e-op-dl-a", "Ann Able", "+447700941002", "PLAYER"],
    ["e2e-op-dl-b", "Ben Best", "+447700941003", "PLAYER"],
  ] as const;
  for (const [id, name, phone, role] of people) {
    await db.run(`INSERT INTO "User" (id, email, name, "phoneNumber", "updatedAt") VALUES ($1, $2, $3, $4, now())`, [id, `${id}@e2e.test`, name, phone]);
    await db.run(`INSERT INTO "Membership" (id, "userId", "orgId", role) VALUES ($1, $2, $3, $4)`, [`${id}-mem`, id, O, role]);
  }
  await db.run(
    `INSERT INTO "Match" (id, "activityId", date, "maxPlayers", status, "attendanceDeadline", "updatedAt")
     VALUES ($1, 'e2e-op-dl-act', $2, 2, 'UPCOMING', $3, now())`,
    [M, KICKOFF.toISOString(), new Date(KICKOFF.getTime() - 3600_000).toISOString()],
  );
  for (const [i, [userId, status]] of ([["e2e-op-dl-owner", "CONFIRMED"], ["e2e-op-dl-a", "CONFIRMED"], ["e2e-op-dl-b", "BENCH"]] as const).entries()) {
    await db.run(
      `INSERT INTO "Attendance" (id, "matchId", "userId", status, position, "updatedAt") VALUES ($1, $2, $3, $4::"AttendanceStatus", $5, now())`,
      [`${userId}-att`, M, userId, status, i + 1],
    );
  }
  await post(request, "/api/whatsapp/attendance", { phoneNumber: "447700941002", action: "OUT", groupId: G });

  // Monday 18:00: before the 21:00 deadline, nothing goes to the admins.
  const before = await poll(request, G, "2027-01-11T18:00:00.000Z");
  expect(before.filter((i) => i.kind === "admin-group-message")).toEqual([]);
  expect(await db.all(`SELECT id FROM "OrganiserPickRound" WHERE "matchId" = $1`, [M])).toEqual([]);

  // Monday 21:05: ONE message, the summary as the first pick round.
  const after = (await poll(request, G, "2027-01-11T21:05:00.000Z")).filter((i) => i.kind === "admin-group-message");
  expect(after).toHaveLength(1);
  expect(after[0].text).toBe(
    [
      "Drop-out deadline passed for *Friday 1-a-side* (Fri 15 Jan at 20:30). 1 place open, squad 1/2.",
      "",
      "Waiting list:",
      "1. Ben Best (no position, new)",
      "",
      "Reply here with a number, a name or an @tag, e.g. *2*, or *2 3* for two. *NONE* leaves it open.",
      "If nobody picks by Tuesday 21:05, I'll offer the place to the whole waiting list.",
    ].join("\n"),
  );
  const r = await db.one<{ reason: string }>(`SELECT reason FROM "OrganiserPickRound" WHERE "matchId" = $1`, [M]);
  expect(r?.reason).toBe("deadline-summary");
  // NONE: the round closes and the place stays open; nothing re-asks.
  expect((await post(request, "/api/whatsapp/admin-group", { groupId: H, messageId: "e2e-op-dl-none", text: "NONE", senderPhone: "447700941001", timestamp: new Date().toISOString() })).replyText).toBe(
    "OK, I'll leave the place open. You can still pick from the waiting list on the match page.",
  );
  expect((await poll(request, G, "2027-01-11T21:30:00.000Z")).filter((i) => i.kind === "admin-group-message")).toEqual([]);
});

test("nobody picks with SEVERAL places open: one offer per waiting player, announced once (2026-10-06)", async ({ request, db }) => {
  // A new club's first week: one of five in, two on the waiting list.
  const O = "e2e-op-many-org";
  const G = "e2e-op-many-group@g.us";
  const H = "120363777000000033@g.us";
  const M = "e2e-op-many-match";
  await db.run(
    `INSERT INTO "Organisation" (id, name, slug, "inviteCode", "whatsappGroupId", "whatsappBotEnabled", "benchPickMode",
       "adminChannelMode", "adminGroupId", "updatedAt")
     VALUES ($1, 'New FNF', 'e2e-op-many', 'e2e-op-many-invite', $2, true, 'organiser', 'admin-group', $3, now())`,
    [O, G, H],
  );
  await db.run(
    `INSERT INTO "Sport" (id, "orgId", name, "playersPerTeam", positions, "teamLabels", "updatedAt")
     VALUES ('e2e-op-many-sport', $1, 'Football 5-a-side', 5, ARRAY['GK'], ARRAY['Red','Yellow'], now())`,
    [O],
  );
  await db.run(
    `INSERT INTO "Activity" (id, "orgId", "sportId", name, "dayOfWeek", time, venue, "deadlineHours", "updatedAt")
     VALUES ('e2e-op-many-act', $1, 'e2e-op-many-sport', 'Friday 5-a-side', 5, '20:30', 'Goals', 1, now())`,
    [O],
  );
  const people = [
    ["e2e-op-many-owner", "Olly Owner", "+447700942001", "OWNER", "CONFIRMED"],
    ["e2e-op-many-a", "Ann Able", "+447700942002", "PLAYER", "BENCH"],
    ["e2e-op-many-b", "Ben Best", "+447700942003", "PLAYER", "BENCH"],
  ] as const;
  await db.run(
    `INSERT INTO "Match" (id, "activityId", date, "maxPlayers", status, "attendanceDeadline", "updatedAt")
     VALUES ($1, 'e2e-op-many-act', $2, 5, 'UPCOMING', $3, now())`,
    [M, KICKOFF.toISOString(), new Date(KICKOFF.getTime() - 3600_000).toISOString()],
  );
  for (const [i, [id, name, phone, role, status]] of people.entries()) {
    await db.run(`INSERT INTO "User" (id, email, name, "phoneNumber", "updatedAt") VALUES ($1, $2, $3, $4, now())`, [id, `${id}@e2e.test`, name, phone]);
    await db.run(`INSERT INTO "Membership" (id, "userId", "orgId", role) VALUES ($1, $2, $3, $4)`, [`${id}-mem`, id, O, role]);
    await db.run(
      `INSERT INTO "Attendance" (id, "matchId", "userId", status, position, "updatedAt") VALUES ($1, $2, $3, $4::"AttendanceStatus", $5, now())`,
      [`${id}-att`, M, id, status, i + 1],
    );
  }

  // Wednesday noon: the admins are asked. Nobody answers.
  const asked = (await poll(request, G, WED_NOON)).filter((i) => i.kind === "admin-group-message");
  expect(asked).toHaveLength(1);
  expect(asked[0].text).toContain("There are 4 places open in *Friday 5-a-side*");

  // Thursday, past the fallback time, and the next few polls after it.
  const polls = [
    "2027-01-14T12:30:00.000Z",
    "2027-01-14T12:30:30.000Z",
    "2027-01-14T12:31:00.000Z",
    "2027-01-14T12:36:00.000Z",
    "2027-01-14T12:42:00.000Z",
  ];
  const sent: Array<{ kind: string; text?: string; phone?: string }> = [];
  for (const at of polls) sent.push(...(await poll(request, G, at)));

  // Four places, two people waiting: two offers, not four.
  const offers = await db.all<{ id: string }>(`SELECT id FROM "BenchSlotOffer" WHERE "matchId" = $1 AND "resolvedAt" IS NULL`, [M]);
  expect(offers).toHaveLength(2);
  expect(sent.filter((i) => i.kind === "admin-group-message").map((i) => i.text)).toEqual([
    "Nobody picked for *Friday 5-a-side*, so I've offered the open places to the waiting list: whoever says IN gets one.",
  ]);

  // The group is told ONCE, and each waiting player is told ONCE.
  const groupPosts = sent.filter((i) => i.kind === "bench-prompt");
  expect(groupPosts.map((i) => i.text)).toEqual([
    "🎟 2 slots just opened for *Friday 5-a-side* on Fri 15 Jan. *First to claim them play.*\n\n" +
      "@447700942002 @447700942003\n\n" +
      "Just reply *IN* here to take one. No rush and no timeout, the slots go to whoever replies first " +
      "and anyone who misses out stays on the bench. 🙏",
  ]);
  const dms = sent.filter((i) => i.kind === "dm" && /just opened/.test(i.text ?? ""));
  expect(dms.map((i) => i.phone).sort()).toEqual(["447700942002", "447700942003"]);
  expect(dms[0].text).toContain("2 slots just opened for Friday 5-a-side on Fri 15 Jan and you're on the bench.");

  // Both waiting players can still take a place each.
  for (const [n, phone] of ["447700942002", "447700942003"].entries()) {
    await post(request, "/api/whatsapp/dm-reply", { phone, body: "YES", waMessageId: `e2e-op-many-claim-${n}` });
  }
  const status = await db.all<{ status: string }>(`SELECT status FROM "Attendance" WHERE "matchId" = $1 ORDER BY position`, [M]);
  expect(status.map((s) => s.status)).toEqual(["CONFIRMED", "CONFIRMED", "CONFIRMED"]);
  expect(await db.all(`SELECT id FROM "BenchSlotOffer" WHERE "matchId" = $1 AND "resolvedAt" IS NULL`, [M])).toEqual([]);
  // And nothing announces the taken places again.
  const after = await poll(request, G, "2027-01-14T12:50:00.000Z");
  expect(after.filter((i) => i.kind === "bench-prompt" || /just opened/.test(i.text ?? ""))).toEqual([]);
});

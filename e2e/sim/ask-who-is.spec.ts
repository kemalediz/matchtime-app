/**
 * Group simulator: A NAME MATCHTIME COULD NOT PLACE IS ASKED ABOUT, AND
 * THE ANSWER IS ACTED ON (Sutton, 17 Nov 2026).
 *
 * 13:14 the organiser wrote "@Match Time Abu Ayoub is IN as a guest". The
 * extractor read it right (another person, in, "Abu Ayoub"); who-is-who
 * was not sure Abu Ayoub is not the member Yoobie and answered "ambiguous"
 * with Yoobie as the one candidate, so the sender would be asked. Nothing
 * asked: the engine dropped the claim and the route sent "I didn't catch
 * what you'd like me to do". Now MatchTime asks one question, and reads
 * the answer through the open-question mechanism:
 *
 *   "new"     Abu Ayoub becomes a member and is CONFIRMED;
 *   "Yoobie"  Yoobie is CONFIRMED.
 *
 * The REAL route, engine and writes; the router, the extractor and
 * who-is-who are stubbed (no model calls). Every person and number is
 * made up.
 */
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import type { TestDb } from "../helpers/test-db";
import { createGroup, type SimGroup } from "./group";
import { E2E } from "../helpers/env";
import { facts, otherClaim, otherFacts, stubCalls } from "../helpers/stub";

test.describe.configure({ mode: "serial" });
test.beforeAll(resetDb);

const ASKED = "@Match Time Abu Ayoub is IN as a guest";
const QUESTION = "Do you mean Yoobie, or is Abu Ayoub a new player?";
const NOT_UNDERSTOOD = /didn't catch/i;

const mkGroup = (request: APIRequestContext, db: TestDb) =>
  createGroup(request, db, {
    maxPlayers: 14,
    players: [
      { key: "olly", name: "Olly Organiser", role: "OWNER" },
      { key: "yoobie", name: "Yoobie" },
      { key: "pete", name: "Pete Player" },
    ],
    attendance: [{ key: "pete", status: "CONFIRMED" }],
  });

/** The organiser's message, with who-is-who not sure Abu Ayoub is not Yoobie. */
async function ask(g: SimGroup) {
  return g.post("olly", ASKED, {
    tag: true,
    route: "other_att",
    facts: otherFacts("Abu Ayoub", "in", { personKind: "named" }),
    people: { "Abu Ayoub": { verdict: "ambiguous", names: ["Yoobie"] } },
  });
}

const usersNamed = (g: SimGroup, name: string) =>
  g.db.all<{ id: string }>(
    `SELECT u.id FROM "User" u JOIN "Membership" m ON m."userId" = u.id WHERE m."orgId" = $1 AND u.name = $2`,
    [g.orgId, name],
  );

const openAsks = (g: SimGroup) =>
  g.db.all<{ text: string }>(`SELECT text FROM "SentNotification" WHERE kind = 'attendance-ask' AND key LIKE $1`, [`attendance-ask:${g.orgId}:%`]);

const statusOfUser = async (g: SimGroup, userId: string) =>
  (await g.db.one<{ status: string }>(`SELECT status FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`, [g.matchId, userId]))
    ?.status ?? null;

test("the organiser is asked, and \"new\" makes Abu Ayoub a new member, CONFIRMED", async ({ request, db }) => {
  const g = (await mkGroup(request, db)).attach(request);

  const q = await ask(g);
  expect(q.reply, "MatchTime asks one question").toBe(QUESTION);
  expect(q.reply ?? "").not.toMatch(NOT_UNDERSTOOD);
  // The question is its own row: what was asked, about whom, offering whom.
  const asks = await openAsks(g);
  expect(asks).toHaveLength(1);
  expect(JSON.parse(asks[0].text)).toMatchObject({ body: ASKED, ref: "Abu Ayoub", candidateIds: [g.player("yoobie").userId], answeredAt: null });
  expect(await g.attendanceOf("yoobie"), "Yoobie is not touched by the question").toBeNull();
  expect(await usersNamed(g, "Abu Ayoub"), "nobody is added before the answer").toEqual([]);

  // The answer, untagged: "new". The extractor is shown the earlier message
  // and reads the answer (stubbed here as the model would read it).
  const a = await g.post("olly", "new", {
    route: "other_att",
    facts: facts([otherClaim("Abu Ayoub", "in", { personKind: "named", newPlayer: true })], { answersClarification: true }),
  });
  const shown = stubCalls(E2E.EXTRACTOR_STUB_FILE).filter((c) => c.user.endsWith("\nnew"));
  expect(shown.at(-1)?.user, "the extractor sees what MatchTime asked about").toContain(
    `MATCHTIME ASKED them who someone in their earlier message is: "${ASKED}"`,
  );
  expect(a.reply ?? "").not.toMatch(NOT_UNDERSTOOD);
  const abu = await usersNamed(g, "Abu Ayoub");
  expect(abu, "Abu Ayoub is a new member").toHaveLength(1);
  expect(await statusOfUser(g, abu[0].id)).toBe("CONFIRMED");
  expect(await g.attendanceOf("yoobie"), "Yoobie still untouched").toBeNull();
  expect(a.intent, "the answer's own row says what happened").toBe("in");
  expect(JSON.parse((await openAsks(g))[0].text).answeredAt, "the question is closed").toEqual(expect.any(String));
});

test("the organiser is asked, and \"Yoobie\" puts Yoobie IN", async ({ request, db }) => {
  const g = (await mkGroup(request, db)).attach(request);

  const q = await ask(g);
  expect(q.reply).toBe(QUESTION);

  const a = await g.post("olly", "Yoobie", {
    route: "other_att",
    facts: facts([otherClaim("Yoobie", "in", { personKind: "named" })], { answersClarification: true }),
  });
  expect(a.reply ?? "").not.toMatch(NOT_UNDERSTOOD);
  expect((await g.attendanceOf("yoobie"))?.status).toBe("CONFIRMED");
  expect(await usersNamed(g, "Abu Ayoub"), "nobody new was added").toEqual([]);
});

// ── A DELETE OR AN EDIT OF THE MESSAGE ASKED ABOUT (PR #606) ─────────────
// The question's row holds the message's words ("body") and the name
// ("ref"). A delete closes it with no words; an author's edit keeps an open
// one for its hour (MatchTime acts on what it read), then the sweep takes them.

const digits = (p: string | null) => (p ?? "").replace(/\D/g, "");
let seq = 0;

/** The organiser's message under a WhatsApp id the change can name. */
async function askWithId(g: SimGroup): Promise<{ bare: string; reply: string | null }> {
  const bare = `3EB0ASK${Date.now().toString(16).toUpperCase()}${++seq}`;
  const r = await g.postBatch([
    {
      player: "olly",
      body: ASKED,
      tag: true,
      route: "other_att",
      facts: otherFacts("Abu Ayoub", "in", { personKind: "named" }),
      people: { "Abu Ayoub": { verdict: "ambiguous", names: ["Yoobie"] } },
      waMessageId: `false_${g.groupId}_${bare}_${digits(g.player("olly").phone)}@c.us`,
    },
  ]);
  return { bare, reply: r.results[0].reply };
}

async function changeBy(request: APIRequestContext, g: SimGroup, kind: "revoke" | "edit", bare: string) {
  const phone = digits(g.player("olly").phone);
  const res = await request.post("/api/whatsapp/message-change", {
    headers: { "x-api-key": E2E.WHATSAPP_API_KEY },
    data: { kind, chatId: g.groupId, messageId: bare, byAdmin: false, senderJids: [`${phone}@c.us`], senderPhone: phone },
  });
  expect(res.status(), await res.text()).toBe(200);
}

test("the message asked about is DELETED: the question is closed and keeps no words; the next message is not read as its answer", async ({ request, db }) => {
  const g = (await mkGroup(request, db)).attach(request);
  const { bare, reply } = await askWithId(g);
  expect(reply).toBe(QUESTION);
  await changeBy(request, g, "revoke", bare);

  const asks = await openAsks(g);
  expect(asks).toHaveLength(1);
  expect(asks[0].text).not.toContain("Abu Ayoub");
  expect(JSON.parse(asks[0].text)).toMatchObject({ body: "", ref: "", answeredAt: expect.any(String) });

  await g.post("olly", "new", { route: "other_att", facts: otherFacts("Someone", "in", { personKind: "named" }) });
  const shown = stubCalls(E2E.EXTRACTOR_STUB_FILE).filter((c) => c.user.endsWith("\nnew"));
  expect(shown.at(-1)?.user ?? "", "nothing of the deleted message is shown as an open question").not.toContain("MATCHTIME ASKED");
});

test("the message asked about is EDITED by its author: the question stays open with its words for its hour and is answered as today; the sweep then takes the words", async ({ request, db }) => {
  const g = (await mkGroup(request, db)).attach(request);
  const { bare, reply } = await askWithId(g);
  expect(reply).toBe(QUESTION);
  await changeBy(request, g, "edit", bare);
  expect(JSON.parse((await openAsks(g))[0].text)).toMatchObject({ body: ASKED, ref: "Abu Ayoub", answeredAt: null });

  const a = await g.post("olly", "new", {
    route: "other_att",
    facts: facts([otherClaim("Abu Ayoub", "in", { personKind: "named", newPlayer: true })], { answersClarification: true }),
  });
  expect(a.reply ?? "").not.toMatch(NOT_UNDERSTOOD);
  const abu = await usersNamed(g, "Abu Ayoub");
  expect(abu, "the answer is acted on, as without the edit").toHaveLength(1);
  expect(await statusOfUser(g, abu[0].id)).toBe("CONFIRMED");

  // An hour on, the hourly sweep: the question's words go (it was answered, so at once).
  const res = await request.get("/api/cron/bot-health", { headers: { authorization: `Bearer ${E2E.CRON_SECRET}` } });
  expect(res.status(), await res.text()).toBe(200);
  const after = await openAsks(g);
  expect(after.map((r) => r.text).join("\n")).not.toContain(ASKED);
  expect(JSON.parse(after[0].text)).toMatchObject({ body: "", ref: "", answeredAt: expect.any(String) });
  expect(await db.one(`SELECT "enforcedAt" IS NOT NULL AS done FROM "DeletedMessage" WHERE "chatId" = $1 AND "waMessageId" = $2`, [g.groupId, bare])).toEqual({ done: true });
});

test("an EDITED message's open question is left alone by the sweep inside its hour, and loses its words after it", async ({ request, db }) => {
  const g = (await mkGroup(request, db)).attach(request);
  const { bare } = await askWithId(g);
  await changeBy(request, g, "edit", bare);
  const sweep = async () => {
    const res = await request.get("/api/cron/bot-health", { headers: { authorization: `Bearer ${E2E.CRON_SECRET}` } });
    expect(res.status(), await res.text()).toBe(200);
  };
  await sweep();
  expect((await openAsks(g))[0].text).toContain(ASKED);
  // The hour is up.
  await db.run(`UPDATE "SentNotification" SET "createdAt" = now() - interval '61 minutes' WHERE kind = 'attendance-ask' AND key LIKE $1`, [`attendance-ask:${g.orgId}:%`]);
  await sweep();
  expect((await openAsks(g))[0].text).not.toContain("Abu Ayoub");
});

test("a player's untagged message about an unclear name stays silent: nothing asked", async ({ request, db }) => {
  const g = (await mkGroup(request, db)).attach(request);
  const r = await g.post("pete", "Abu Ayoub is IN", {
    route: "other_att",
    facts: otherFacts("Abu Ayoub", "in", { personKind: "named" }),
    people: { "Abu Ayoub": { verdict: "ambiguous", names: ["Yoobie"] } },
  });
  expect(r.reply).toBeNull();
  expect(r.groupPosts).toEqual([]);
});

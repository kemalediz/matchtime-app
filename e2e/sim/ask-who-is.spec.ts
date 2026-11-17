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

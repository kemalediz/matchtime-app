/**
 * WHAT A MONTHLY REGULAR COVERS, BY TAGGING MATCHTIME IN HQ (2026-11-16,
 * Kemal: every admin feature also works by WhatsApp), and the review of
 * PR #611.
 *
 * Against a real Postgres and the real admin-group route. The monthly
 * reader, the router and the admin extractor are STUBBED ($0; what the
 * real model reads for these words is the live check listed in the PR).
 * Everything after is the shipped code: the organiser gate, who-is-who
 * (its stub), the add (`applyMonthAdd`), the coverage write the months page
 * uses (`setMonthMemberCoverage`), and the question's answer target.
 *
 * The fixture: this month, priced at £7.50, started part-way here before
 * its first game; Riley joined just after that first game (a real join
 * date, games played since) and says he paid.
 *
 *   an add that says the whole month      he covers every game, priced so
 *   an add that says the games left       he covers the games left, nothing asked
 *   an add that says neither              he joins for the games left and
 *                                         MatchTime asks ONCE; the tagged
 *                                         answer "whole month" sets it
 *   an answer that names somebody else    is about that person (item 2)
 *   "Riley only pays for the games left"  never below his games since joining (item 1)
 *   two open questions                    a quoted reply answers the one it
 *                                         quotes; unclear: "which player?" (item 3)
 *   a player merged away since            "add them again" (item 10)
 *   neither said, in Turkish              asked in Turkish, answered by a quote
 *   a player                              the organisers-only line, nothing changed
 */
import type { APIRequestContext } from "@playwright/test";
import { formatInTimeZone } from "date-fns-tz";
import { test, expect, resetDb } from "../fixtures";
import { ACTIVITY_ID, ORG_ID, PHONE, U } from "../helpers/constants";
import { E2E } from "../helpers/env";
import { clearMonthlyReaderStub, clearPipelineStubs, engineOn, setMonthlyReaderStub, setMonthSeedReplyStub } from "../helpers/stub";
import { testDb, type TestDb } from "../helpers/test-db";
import { monthKickoffs } from "@/lib/month-signup-rules";
import { londonMonthStart, monthStartToDate } from "@/lib/squad-month-rules";
import { monthNameLabel } from "@/lib/i18n/dates";
import { pounds } from "@/lib/month-payment-copy";

test.describe.configure({ mode: "serial" });

const KEY = { "x-api-key": E2E.WHATSAPP_API_KEY };
const HQ = "120363777000000091@g.us";
const LONDON = "Europe/London";
const SHARE = 750;
const MONTH_ID = "e2e-hq-cov-month";
const THIS = londonMonthStart(new Date());
/** The seeded fixture: Tuesdays at 20:00. */
const KICKOFFS = monthKickoffs(THIS, 2, "20:00");
const NOW = Date.now();
const LEFT = KICKOFFS.filter((k) => k.getTime() > NOW).length;
const WHOLE = KICKOFFS.length;
/** A newcomer's "games left": at least one. */
const LOW = Math.max(1, LEFT);
/** Riley joined just after the first game: covered for every game since. */
const JOINED = new Date(KICKOFFS[0].getTime() + 60 * 60_000);
const SINCE = WHOLE - 1;
const MONTH = formatInTimeZone(KICKOFFS[0], LONDON, "MMMM");
const MONTH_NO = Number(THIS.slice(5, 7));
const games = (n: number) => `${n} ${n === 1 ? "game" : "games"}`;

const ADD_WHOLE = `@Match Time add Ian to the ${MONTH} list, he's paid the whole month`;
const ADD_LEFT = `@Match Time add Zara to the ${MONTH} list for the games left`;
const ADD_BEN = `@Match Time add Ben to the ${MONTH} list, he's paid`;
const ADD_OLIVIA = `@Match Time add Olivia to the ${MONTH} list, she's paid`;
const ADD_SAM = `@Match Time add Sam to the ${MONTH} list, he's paid`;
const ADD_DANNY = `@Match Time add Danny to the ${MONTH} list, he's paid`;
const ADD_ZAK = `@Match Time add Zak to the ${MONTH} list, he's paid`;
const ADD_GARY = `@Match Time add Gary to the ${MONTH} list, he's paid`;
const ANSWER_TWO = "@Match Time Olivia and Zara cover the whole month";
/** A member imported from the group by phone, with no name yet. */
const NAMELESS = { id: "e2e-hqcov-nameless", phone: "+447700900091" };
const ANSWER_WHOLE = "@Match Time whole month";
const RILEY_WHOLE = "@Match Time Riley covers the whole month";
const RILEY_LEFT = "@Match Time Riley only pays for the games left";
const RILEY_TR = "@Match Time Riley'nin ayını düzelt";
const ANSWER_TR = "@Match Time sadece kalanlar";
const TWO_PAID = "@Match Time fix Ian's and Zara's month";

/** The monthly reader's raw answer for "add <name> to the month". */
const addReading = (name: string, paid: boolean) => ({
  kind: "signup",
  month: 0,
  gameDay: 0,
  listOf: "",
  benchPart: false,
  lines: [],
  residual: "",
  choice: "in",
  signupMonth: MONTH_NO,
  signupFor: "other",
  signupWho: "",
  signupName: name,
  signupPaid: paid,
  signupPaidPence: 0,
  days: [],
  games: 0,
});
const coverage = (refs: string[], value: "" | "whole" | "left", route = "admin_ops") => ({
  route,
  facts: { action: "month_coverage", coveredRefs: refs, coverage: value, toMatchTime: true },
});

const member = (db: TestDb, userId: string) =>
  db.one<{ kind: string; gamesCovered: number; amountDuePence: number | null; paidAt: Date | null; claimed: boolean }>(
    `SELECT kind, "gamesCovered", "amountDuePence", "paidAt", ("paidClaimedAt" IS NOT NULL) AS claimed FROM "SquadMonthMember" WHERE "monthId" = $1 AND "userId" = $2`,
    [MONTH_ID, userId],
  );
const questions = (db: TestDb) =>
  db.all<{ askRef: string; text: string }>(`SELECT "askRef", text FROM "AdminGroupMessage" WHERE "orgId" = $1 AND "askRef" LIKE 'month-coverage:%' ORDER BY "createdAt"`, [ORG_ID]);

let seq = 0;
async function hq(request: APIRequestContext, text: string, who: "admin" | "player" = "admin", quoted?: { id: string; text: string }) {
  const res = await request.post("/api/whatsapp/admin-group", {
    headers: KEY,
    data: {
      channel: "admin-group",
      botMentioned: true,
      groupId: HQ,
      messageId: `e2e-hqcov-${++seq}`,
      text,
      senderPhone: PHONE[who].replace(/^\+/, ""),
      timestamp: String(Math.floor(Date.now() / 1000)),
      ...(quoted ? { quotedMessageId: quoted.id, quotedText: quoted.text, quotedFromMatchTime: true } : {}),
    },
  });
  expect(res.status(), await res.text()).toBe(200);
  return res.json() as Promise<{ outcome: string; replyText: string | null }>;
}

test.beforeAll(async () => {
  resetDb();
  const db = testDb();
  await db.run(`UPDATE "Organisation" SET "squadMode" = 'monthly', "rollingSquadEnabled" = false, "adminGroupId" = $2, "adminChannelMode" = 'admin-group' WHERE id = $1`, [ORG_ID, HQ]);
  const startedAt = new Date(monthStartToDate(THIS).getTime() + 3600_000);
  await db.run(
    `INSERT INTO "SquadMonth" (id, "orgId", "activityId", "monthStart", status, "gamesScheduled", "gamesPlayedBeforeStart", "sharePerGamePence", "pricedAt", "startedMidMonthAt", "updatedAt")
     VALUES ($1, $2, $3, $4::date, 'running', $5, 0, $6, $7, $7, now())`,
    [MONTH_ID, ORG_ID, ACTIVITY_ID, THIS, WHOLE, SHARE, startedAt.toISOString()],
  );
  // Riley joined just after the first game, for every game since, and says he paid.
  await db.run(
    `INSERT INTO "SquadMonthMember" (id, "monthId", "userId", kind, slot, "gamesCovered", "amountDuePence", "paidClaimedAt", "paidClaimSource", source, "joinedAt", "updatedAt")
     VALUES ($1, $2, $3, 'regular', 1, $4, $5, now(), 'organiser', 'admin', $6, now())`,
    [`${MONTH_ID}-riley`, MONTH_ID, U.rater, SINCE, SHARE * SINCE, JOINED.toISOString()],
  );
  // A member with no name yet (imported from the group by phone): the one
  // "Zak is 1" says the new player is (round 3, item 2).
  await db.run(`INSERT INTO "User" (id, email, name, "phoneNumber", "isActive", "updatedAt") VALUES ($1, $2, NULL, $3, true, now())`, [NAMELESS.id, `${NAMELESS.id}@e2e.test`, NAMELESS.phone]);
  await db.run(`INSERT INTO "Membership" (id, "userId", "orgId", role) VALUES ($1, $2, $3, 'PLAYER'::"MemberRole")`, [`mem-${NAMELESS.id}`, NAMELESS.id, ORG_ID]);
  setMonthSeedReplyStub({
    bodies: { "Zak is 1": JSON.stringify({ answer: "change", changes: [{ action: "match", member: "n1", listed: "u1", games: 0 }], confidence: 0.95 }) },
  });
  setMonthlyReaderStub({
    bodies: {
      [ADD_WHOLE]: addReading("Ian", true),
      [ADD_LEFT]: addReading("Zara", false),
      [ADD_BEN]: addReading("Ben", true),
      [ADD_OLIVIA]: addReading("Olivia", true),
      [ADD_SAM]: addReading("Sam", true),
      [ADD_DANNY]: addReading("Danny", true),
      [ADD_ZAK]: addReading("Zak", true),
      [ADD_GARY]: addReading("Gary", true),
    },
  });
  engineOn({
    [ADD_WHOLE]: coverage(["Ian"], "whole"),
    [ADD_LEFT]: coverage(["Zara"], "left"),
    [ADD_BEN]: coverage(["Ben"], ""),
    [ADD_OLIVIA]: coverage(["Olivia"], ""),
    [ADD_SAM]: coverage(["Sam"], ""),
    [ADD_DANNY]: coverage(["Danny"], ""),
    [ADD_ZAK]: coverage(["Zak"], ""),
    [ADD_GARY]: coverage(["Gary"], ""),
    [ANSWER_TWO]: coverage(["Olivia", "Zara"], "whole", "none"),
    // The router's call does not decide an answer to MatchTime's question.
    [ANSWER_WHOLE]: coverage([], "whole", "none"),
    [RILEY_WHOLE]: coverage(["Riley"], "whole"),
    [RILEY_LEFT]: coverage(["Riley"], "left"),
    [RILEY_TR]: coverage(["Riley"], ""),
    [ANSWER_TR]: coverage([], "left", "unsure"),
    [TWO_PAID]: { route: "admin_ops", facts: { action: "month_coverage", coveredRefs: ["Ian", "Zara"], coverage: "", toMatchTime: true } },
  });
});

test.afterAll(() => {
  clearMonthlyReaderStub();
  setMonthSeedReplyStub({});
  clearPipelineStubs();
  resetDb();
});

test.beforeEach(() => {
  test.skip(KICKOFFS[0].getTime() > NOW, "needs this month's first Tuesday behind us");
});

test("an add that says the whole month: he covers every game of it, priced so, and nothing is asked", async ({ request, db }) => {
  const r = await hq(request, ADD_WHOLE);
  expect(r).toMatchObject({ outcome: "month-add-done", replyText: `✅ Ian is on the ${MONTH} list as a regular for the whole month, ${games(WHOLE)}, marked as says paid.` });
  expect(await member(db, U.fresh)).toMatchObject({ kind: "regular", gamesCovered: WHOLE, amountDuePence: SHARE * WHOLE, paidAt: null, claimed: true });
  expect(await questions(db)).toEqual([]);
});

test("an add that says the games left: he covers them, and nothing is asked", async ({ request, db }) => {
  const r = await hq(request, ADD_LEFT);
  expect(r.outcome).toBe("month-add-done");
  expect(r.replyText).toBe(`✅ Zara is on the ${MONTH} list as a regular for the ${games(LOW)} left.`);
  expect(await member(db, U.extra)).toMatchObject({ kind: "regular", gamesCovered: LOW, claimed: false });
  expect(await questions(db)).toEqual([]);
});

test("an add that says neither: he joins for the games left, MatchTime asks once, and the plain tagged answer sets the whole month", async ({ request, db }) => {
  const r = await hq(request, ADD_BEN);
  expect(r.outcome).toBe("month-add-done");
  const ask = `📋 Ben on the ${MONTH} list: whole month, or just the games left? The whole month is ${games(WHOLE)}; ${LEFT} ${LEFT === 1 ? "is" : "are"} left. Tag me with your answer.`;
  expect(r.replyText).toBe(`✅ Ben is on the ${MONTH} list as a regular for the ${games(LOW)} left, marked as says paid.\n\n${ask}`);
  expect(await member(db, U.bench)).toMatchObject({ gamesCovered: LOW, claimed: true });
  // The question carries no payment (round 4, option a).
  expect(await questions(db)).toEqual([{ askRef: `month-coverage:${MONTH_ID}:${U.bench}`, text: r.replyText }]);

  const a = await hq(request, ANSWER_WHOLE);
  // Round 4, option a: an answer never records, changes or clears a claim.
  // He said he paid for the games left when he was added: that is kept, and
  // the reply says what the whole month leaves to pay.
  expect(a).toMatchObject({
    outcome: "hq-month-coverage-done",
    replyText: `✅ Ben Bench covers the whole of ${MONTH}: ${games(WHOLE)}. He still shows ${pounds(SHARE * (WHOLE - LOW))} to pay.`,
  });
  expect(await member(db, U.bench)).toMatchObject({ gamesCovered: WHOLE, amountDuePence: SHARE * WHOLE, paidAt: null, claimed: true });
});

test("REVIEW ITEM 2: right after a question about Olivia, 'Riley covers the whole month' changes Riley's, never Olivia's", async ({ request, db }) => {
  await hq(request, ADD_OLIVIA);
  expect((await questions(db)).at(-1)?.askRef).toBe(`month-coverage:${MONTH_ID}:${U.opt}`);
  const r = await hq(request, RILEY_WHOLE);
  expect(r).toMatchObject({ outcome: "hq-month-coverage-done", replyText: `✅ Riley Rater covers the whole of ${MONTH}: ${games(WHOLE)}. He still shows ${pounds(SHARE * (WHOLE - SINCE))} to pay.` });
  expect(await member(db, U.rater)).toMatchObject({ gamesCovered: WHOLE, amountDuePence: SHARE * WHOLE, paidAt: null, claimed: true });
  expect(await member(db, U.opt)).toMatchObject({ gamesCovered: LOW });
});

test("REVIEW ITEM 1: 'Riley only pays for the games left' never cuts the games he has played since he joined", async ({ request, db }) => {
  const down = await hq(request, RILEY_LEFT);
  expect(down).toMatchObject({ outcome: "hq-month-coverage-done", replyText: `✅ Riley Rater covers ${SINCE} of the ${WHOLE} games of ${MONTH}.` });
  expect(await member(db, U.rater)).toMatchObject({ gamesCovered: SINCE, amountDuePence: SHARE * SINCE });
  // Again: nothing lower is possible, whatever the day.
  const again = await hq(request, RILEY_LEFT);
  expect(again.outcome).toBe("hq-month-coverage-same");
  expect(again.replyText).toContain(`already covers ${SINCE} of the ${WHOLE} games`);
  expect(await member(db, U.rater)).toMatchObject({ gamesCovered: SINCE });
});

test("REVIEW ITEM 3: two open questions; a reply quoting the EARLIER one answers it; then an unclear plain answer asks which player", async ({ request, db }) => {
  const sam = await hq(request, ADD_SAM);
  const danny = await hq(request, ADD_DANNY);
  expect((await questions(db)).slice(-2).map((q) => q.askRef)).toEqual([`month-coverage:${MONTH_ID}:${U.stale}`, `month-coverage:${MONTH_ID}:${U.dup}`]);
  expect(danny.replyText).toContain("Danny on the");

  const quoted = await hq(request, ANSWER_WHOLE, "admin", { id: "e2e-unknown-stanza-sam", text: sam.replyText! });
  expect(quoted).toMatchObject({ outcome: "hq-month-coverage-done", replyText: `✅ Sam Stale covers the whole of ${MONTH}: ${games(WHOLE)}. He still shows ${pounds(SHARE * (WHOLE - LOW))} to pay.` });
  expect(await member(db, U.stale)).toMatchObject({ gamesCovered: WHOLE });
  expect(await member(db, U.dup)).toMatchObject({ gamesCovered: LOW });

  // Plain, with somebody's message since the newest question: not clear which.
  const which = await hq(request, ANSWER_WHOLE);
  expect(which.outcome).toBe("hq-month-coverage-which");
  // Ben's and Sam's are settled; Olivia's (answered by naming Riley) and Danny's are open.
  expect(which.replyText).toBe(`Which player do you mean: Olivia Opty or Danny Dup? Reply to my question about them, or tag me with their name, for example "@Match Time Olivia covers the whole month".`);
  expect(await member(db, U.dup)).toMatchObject({ gamesCovered: LOW });

  // Then a reply quoting Danny's settles his.
  const d = await hq(request, ANSWER_WHOLE, "admin", { id: "e2e-unknown-stanza-danny", text: danny.replyText! });
  expect(d.outcome).toBe("hq-month-coverage-done");
  expect(await member(db, U.dup)).toMatchObject({ gamesCovered: WHOLE });
});

test("ROUND 3, item 1: an answer naming two players changes both, and names both", async ({ request, db }) => {
  // A fresh question about Gary, and the very next message, in the place
  // of its answer, names Olivia and Zara: it is about them, both.
  await hq(request, ADD_GARY);
  expect((await questions(db)).at(-1)?.askRef).toBe(`month-coverage:${MONTH_ID}:${U.guest}`);
  const r = await hq(request, ANSWER_TWO);
  expect(r.outcome).toBe("hq-month-coverage-done");
  expect(r.replyText).toContain(`✅ Olivia Opty covers the whole of ${MONTH}: ${games(WHOLE)}.`);
  expect(r.replyText).toContain(`✅ Zara Zest covers the whole of ${MONTH}: ${games(WHOLE)}.`);
  expect(await member(db, U.opt)).toMatchObject({ gamesCovered: WHOLE });
  expect(await member(db, U.extra)).toMatchObject({ gamesCovered: WHOLE });
  expect(await member(db, U.guest)).toMatchObject({ gamesCovered: LOW });
});

test("ROUND 3, item 2: the REAL merge (the 'who is this?' answer) between question and answer: the answer goes to the surviving member", async ({ request, db }) => {
  // A brand-new name: a new player with no phone joins for the games left,
  // the organiser is asked who he is (by DM) and what he covers (here).
  const added = await hq(request, ADD_ZAK);
  expect(added.outcome).toBe("month-add-done");
  const zakNew = (await db.one<{ id: string }>(`SELECT u.id FROM "User" u JOIN "SquadMonthMember" s ON s."userId" = u.id WHERE s."monthId" = $1 AND u.name = 'Zak'`, [MONTH_ID]))!.id;
  expect((await questions(db)).at(-1)?.askRef).toBe(`month-coverage:${MONTH_ID}:${zakNew}`);
  // His DM answer "Zak is 1": the new player is folded into the member with
  // no name by the user-merge tool (the real `applyUserMerge`).
  const res = await request.post("/api/whatsapp/dm-reply", {
    headers: KEY,
    data: { phone: PHONE.admin.replace(/^\+/, ""), body: "Zak is 1", waMessageId: `e2e-hqcov-dm-${++seq}`, authorName: "Alex Admin" },
  });
  expect(res.status(), await res.text()).toBe(200);
  expect(await res.json()).toMatchObject({ handled: "month-newcomers-matched" });
  expect(await db.one<{ isActive: boolean }>(`SELECT "isActive" FROM "User" WHERE id = $1`, [zakNew])).toMatchObject({ isActive: false });
  expect(await db.one<{ n: number }>(`SELECT COUNT(*)::int AS n FROM "UserMerge" WHERE "oldUserId" = $1 AND "survivorUserId" = $2`, [zakNew, NAMELESS.id])).toEqual({ n: 1 });

  // Then "whole month" in HQ: it is the survivor's coverage that changes.
  const r = await hq(request, ANSWER_WHOLE);
  expect(r).toMatchObject({ outcome: "hq-month-coverage-done", replyText: `✅ Zak covers the whole of ${MONTH}: ${games(WHOLE)}. He still shows ${pounds(SHARE * (WHOLE - LOW))} to pay.` });
  expect(await member(db, NAMELESS.id)).toMatchObject({ gamesCovered: WHOLE, claimed: true });
});

test("neither said, in Turkish: asked in Turkish, and the answer quoting it sets the games left", async ({ request, db }) => {
  await db.run(`UPDATE "Organisation" SET language = 'tr' WHERE id = $1`, [ORG_ID]);
  try {
    await hq(request, RILEY_WHOLE);
    expect(await member(db, U.rater)).toMatchObject({ gamesCovered: WHOLE });
    const monthTr = monthNameLabel("tr", KICKOFFS[0]);
    const asked = await hq(request, RILEY_TR);
    expect(asked.outcome).toBe("hq-month-coverage-asked");
    expect(asked.replyText).toBe(
      `📋 ${monthTr} listesindeki Riley Rater: ayın tamamı mı, yoksa sadece kalan maçlar mı? Ayın tamamı ${WHOLE} maç; ${LEFT} maç kaldı. Cevabını beni etiketleyerek yaz.`,
    );
    expect((await questions(db)).at(-1)?.askRef).toBe(`month-coverage:${MONTH_ID}:${U.rater}`);
    expect(await member(db, U.rater)).toMatchObject({ gamesCovered: WHOLE });

    const a = await hq(request, ANSWER_TR, "admin", { id: "e2e-unknown-stanza", text: asked.replyText! });
    expect(a).toMatchObject({ outcome: "hq-month-coverage-done", replyText: `✅ Riley Rater, ${monthTr} ayının ${WHOLE} maçından ${SINCE} maçı kapsıyor.` });
    expect(await member(db, U.rater)).toMatchObject({ gamesCovered: SINCE });
  } finally {
    await db.run(`UPDATE "Organisation" SET language = 'en' WHERE id = $1`, [ORG_ID]);
  }
});

test("a player who is not an organiser: the organisers-only line, and nothing changes", async ({ request, db }) => {
  const before = await member(db, U.rater);
  const r = await hq(request, RILEY_WHOLE, "player");
  expect(r.outcome).toBe("hq-only-organisers");
  expect(await member(db, U.rater)).toEqual(before);
});

test("ROUND 4, item 4: one reply asking about two players: a plain 'whole month' asks which; quoting the reply by its id, other lines first, asks which too", async ({ request, db }) => {
  const before = { ian: await member(db, U.fresh), zara: await member(db, U.extra) };
  const asked = await hq(request, TWO_PAID);
  expect(asked.outcome).toBe("hq-month-coverage-asked");
  // Both questions logged with the WHOLE reply as their words, so the ack
  // stamps the reply's id on both.
  const qs = (await questions(db)).slice(-2);
  expect(qs.map((q) => q.askRef)).toEqual([`month-coverage:${MONTH_ID}:${U.fresh}`, `month-coverage:${MONTH_ID}:${U.extra}`]);
  expect(qs.map((q) => q.text)).toEqual([asked.replyText, asked.replyText]);
  expect(asked.replyText).not.toContain("already paid");

  const plain = await hq(request, ANSWER_WHOLE);
  expect(plain.outcome, JSON.stringify(plain)).toBe("hq-month-coverage-which");
  expect(plain.replyText).toContain("Which player do you mean: Ian Innes or Zara Zest?");

  // As the ack leaves it: the reply's stanza id on both question rows. The
  // quote carries only its id and its first line.
  await db.run(`UPDATE "AdminGroupMessage" SET "waStanzaId" = '3EB0TWOPAID' WHERE "orgId" = $1 AND "askRef" LIKE $2 AND text = $3`, [ORG_ID, `month-coverage:${MONTH_ID}:%`, asked.replyText]);
  const quoted = await hq(request, ANSWER_WHOLE, "admin", { id: "3EB0TWOPAID", text: asked.replyText!.split("\n")[0] });
  expect(quoted.outcome).toBe("hq-month-coverage-which");
  // Nothing changed for either.
  expect(await member(db, U.fresh)).toEqual(before.ian);
  expect(await member(db, U.extra)).toEqual(before.zara);
});

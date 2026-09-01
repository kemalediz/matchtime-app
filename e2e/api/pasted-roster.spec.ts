/**
 * The pasted-roster defect, reproduced DETERMINISTICALLY.
 *
 * PR #35's self-replay sweep ran the current analyzer against itself:
 * same message, same reconstructed world, same model, twice. Three of
 * its four write-level disagreements were one message shape — a pasted
 * numbered roster. The 2026-06-07 batch
 * (`g-ab95248799:2026-06-07T17:35:23.730Z`, triage card in
 * `.e2e/replay/<runId>/triage.md`) came back as:
 *
 *   run A  →  Mo, Nabeel
 *   run B  →  Adam, Amir, Ehtisham Ul Haq, Martin, Mo
 *
 * from the SAME two messages against the SAME 0/14 squad. Neither run
 * wrote the union. A player's place in a squad decided by luck.
 *
 * A live replay costs money and is, by definition, not reproducible on
 * demand. So this spec does the thing the live sweep cannot: it feeds
 * the route BOTH of the model outputs that were actually observed, on
 * the identical real input, through the stub seam — and asserts the
 * database ends up in the same place either way. That turns model
 * non-determinism into a deterministic, free, repeatable test.
 *
 * Before the clamp it fails: the two runs leave different squads.
 * After it, both leave the squad untouched, because a re-paste is a
 * restatement of a list and not a registration event. Groups that
 * really do maintain their squad by re-pasting have
 * `lib/squad-from-list.ts` behind `featureSquadFromList`, which keeps
 * the previous list and can diff it; this route cannot and must not
 * guess.
 */
import { test, expect, postAnalyze, resetDb } from "../fixtures";
import { setLlmStub, type StubVerdict } from "../helpers/stub";
import { U, PHONE, MATCH } from "../helpers/constants";
import type { TestDb } from "../helpers/test-db";

test.describe.configure({ mode: "serial" });

/** The real message Adam Khandaza posted at 17:35 on 2026-06-07 — the
 *  seed list, five names. Word joiners (U+2060) are the ones WhatsApp
 *  leaves behind on a copy-paste, kept verbatim. */
const ADAM_PASTE = `In sha Allah 9pm Thursday 11 June Wimbledon Goals 7 a side football:

1. Ehtisham
2. Amir
3. ⁠Martin
4. Adam
5. Mo`;

/** Nabeel's re-paste seconds later — the same list with his own line
 *  appended. This is the ritual: copy, append, re-post. */
const NABEEL_PASTE = `${ADAM_PASTE}
6. ⁠ NABEEL`;

/** What the model emitted on run A. Adam's paste read as noise; Nabeel's
 *  registered Nabeel himself and picked "Mo" out of the list. */
const RUN_A: [StubVerdict, StubVerdict] = [
  { intent: "noise", registerAttendance: null, react: null, reply: null, confidence: 0.9, reasoning: "run A" },
  {
    intent: "in",
    registerAttendance: "IN",
    registerFor: [{ name: "Mo", action: "IN" }],
    react: "👍",
    confidence: 0.9,
    reasoning: "run A",
  },
];

/** What the model emitted on run B, on byte-identical input. Adam's
 *  paste registered Adam plus four names off the list; Nabeel's — the
 *  one that actually added a name — read as noise. */
const RUN_B: [StubVerdict, StubVerdict] = [
  {
    intent: "in",
    registerAttendance: "IN",
    registerFor: [
      { name: "Ehtisham", action: "IN" },
      { name: "Amir", action: "IN" },
      { name: "Martin", action: "IN" },
      { name: "Mo", action: "IN" },
    ],
    react: "👍",
    confidence: 0.9,
    reasoning: "run B",
  },
  { intent: "noise", registerAttendance: null, react: null, reply: null, confidence: 0.9, reasoning: "run B" },
];

let n = 0;
const msgId = () => `e2e-roster-${Date.now()}-${++n}`;

interface Row {
  name: string;
  status: string;
}

/** Everyone with an attendance row on the upcoming match, by name. The
 *  squad as a set — the only thing §10 step 3 turns on. */
async function squad(db: TestDb): Promise<string[]> {
  const rows = await db.all<Row>(
    `SELECT u.name AS name, a.status AS status
       FROM "Attendance" a JOIN "User" u ON u.id = a."userId"
      WHERE a."matchId" = $1
      ORDER BY u.name`,
    [MATCH.upcoming],
  );
  return rows.map((r) => `${r.name}:${r.status}`);
}

/** Members of the e2e org, by name — a registerFor for an unknown name
 *  PROVISIONS one, which is the most expensive form of over-registering
 *  (a ghost player nobody can contact). */
async function members(db: TestDb): Promise<string[]> {
  const rows = await db.all<{ name: string }>(
    `SELECT u.name AS name FROM "Membership" m JOIN "User" u ON u.id = m."userId"
      WHERE m."orgId" = $1 AND m."leftAt" IS NULL ORDER BY u.name`,
    ["e2e-org"],
  );
  return rows.map((r) => r.name);
}

/**
 * Reset to the fixture world, rename two unregistered seed users to the
 * real senders, replay the batch with the given model output, and read
 * back the squad. The rename is what lets the REAL message be posted by
 * senders the route can actually resolve — "Adam" and "NABEEL" are
 * slots in the list, so the self-registration half of the clamp is
 * exercised too.
 */
async function replay(
  request: Parameters<typeof postAnalyze>[0],
  db: TestDb,
  verdicts: [StubVerdict, StubVerdict],
): Promise<{ squad: string[]; members: string[] }> {
  resetDb();
  await db.run(`UPDATE "User" SET name = 'Adam Khandaza' WHERE id = $1`, [U.fresh]);
  await db.run(`UPDATE "User" SET name = 'Nabeel' WHERE id = $1`, [U.extra]);

  const a = msgId();
  const b = msgId();
  setLlmStub({ [a]: verdicts[0], [b]: verdicts[1] });
  await postAnalyze(request, [
    { waMessageId: a, body: ADAM_PASTE, authorPhone: PHONE.fresh, authorName: "Adam Khandaza" },
    { waMessageId: b, body: NABEEL_PASTE, authorPhone: PHONE.extra, authorName: "Nabeel" },
  ]);
  return { squad: await squad(db), members: await members(db) };
}

test("the same pasted roster leaves the SAME squad whichever way the model reads it", async ({
  request,
  db,
}) => {
  const a = await replay(request, db, RUN_A);
  const b = await replay(request, db, RUN_B);

  // THE DEFECT. Before the clamp: A leaves Nabeel + a provisioned "Mo";
  // B leaves Adam Khandaza + provisioned Amir, Ehtisham, Martin, Mo.
  expect(b.squad, "the same message must not produce two different squads").toEqual(a.squad);
  expect(b.members, "the same message must not provision two different member sets").toEqual(
    a.members,
  );
});

test("neither reading registers anyone — a re-paste is a restatement, not a registration", async ({
  request,
  db,
}) => {
  resetDb();
  const baseline = { squad: await squad(db), members: await members(db) };

  const a = await replay(request, db, RUN_A);
  expect(a.squad).toEqual(baseline.squad);
  // The rename is the only membership difference; nobody NEW was
  // provisioned off the list.
  expect(a.members).toHaveLength(baseline.members.length);
  expect(a.members).not.toContain("Mo");

  const b = await replay(request, db, RUN_B);
  expect(b.squad).toEqual(baseline.squad);
  expect(b.members).toHaveLength(baseline.members.length);
  for (const ghost of ["Amir", "Ehtisham", "Martin", "Mo"]) {
    expect(b.members, `${ghost} must not be provisioned off a pasted list`).not.toContain(ghost);
  }
});

test("a real add ALONGSIDE a paste still registers — the clamp is not a mute button", async ({
  request,
  db,
}) => {
  resetDb();
  const id = msgId();
  setLlmStub({
    [id]: {
      intent: "in",
      registerAttendance: null,
      // "Amir" is a slot in the list and goes; "Ian Innes" is named in
      // the prose and stays.
      registerFor: [
        { name: "Amir", action: "IN" },
        { name: "Ian Innes", action: "IN" },
      ],
      react: "👍",
      confidence: 0.9,
      reasoning: "stub",
    },
  });
  await postAnalyze(request, [
    {
      waMessageId: id,
      body: `${ADAM_PASTE}\n\nalso adding Ian Innes, he messaged me`,
      authorPhone: PHONE.admin,
      authorName: "Alex Admin",
    },
  ]);

  const s = await squad(db);
  expect(s.some((r) => r.startsWith("Ian Innes:"))).toBe(true);
  expect(s.some((r) => r.startsWith("Amir:"))).toBe(false);
  expect(await members(db)).not.toContain("Amir");
});

test("the clamp never eats a drop — an OUT beside a paste still fires", async ({
  request,
  db,
}) => {
  resetDb();
  const before = await db.one<{ status: string }>(
    `SELECT status FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`,
    [MATCH.upcoming, U.player],
  );
  expect(before?.status).toBe("CONFIRMED");

  const id = msgId();
  setLlmStub({
    [id]: {
      intent: "out",
      registerAttendance: "OUT",
      react: "👋",
      confidence: 0.95,
      reasoning: "stub",
    },
  });
  // Pat pastes the list AND says he is out. The clamp only ever removes
  // additions, so the OUT survives even though "Pat" is not a slot.
  await postAnalyze(request, [
    {
      waMessageId: id,
      body: `can't make it lads, someone take my spot\n${ADAM_PASTE}`,
      authorPhone: PHONE.player,
      authorName: "Pat Player",
    },
  ]);

  const after = await db.one<{ status: string }>(
    `SELECT status FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`,
    [MATCH.upcoming, U.player],
  );
  expect(after?.status).toBe("DROPPED");
});

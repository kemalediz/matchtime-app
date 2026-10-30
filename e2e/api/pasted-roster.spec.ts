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
 * the route BOTH of the model readings that were actually observed, on
 * the identical real input, through the stub seam — and asserts the
 * database ends up in the same place either way. That turns model
 * non-determinism into a deterministic, free, repeatable test.
 *
 * ── 2026-10-30: THE LIST IS READ BY THE SQUAD READER ────────────────
 *
 * The numbered-list arithmetic (`reconcilePastedRoster`) is deleted (no
 * string parsing). A pasted list in the players' group is read by the
 * squad reader (`hq-squad-reader.ts`, `place: "players"`), stubbed here;
 * the route registers only the names it adds to a list that restates
 * the squad. The first tests below send lists the reader is not stubbed
 * for ("other"), so they pin that nothing else registers off a list.
 *
 * ── PORTED 2026-09-06, §10 STEP 8 ───────────────────────────────────
 *
 * The two readings were `AnalysisVerdict`s; they are now two sets of
 * EXTRACTOR FACTS, which is the same disagreement one layer down: run A
 * found one third-party claim off the list, run B found four. Nothing
 * about the input, the world or the expected end state changed.
 *
 * The guard did not move either. `reconcilePastedRoster` runs in
 * `analyze/route.ts` BEFORE the engine and
 * `attendance-engine-batch.ts` refuses any message `parsePastedRoster`
 * recognises, so a paste is decided by arithmetic over the list and the
 * roster post, never by whoever read it. That is why both readings land
 * in the same place: neither of them is consulted.
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
import { claim, engineOn, facts, otherClaim, selfIn, setHqSquadReaderStub, setPastedListStub, type BodyRouting } from "../helpers/stub";

/** The squad reader's reading of a list (2026-10-30): every line a person,
 *  each member named (the stub seam turns a name into the ref it gave). */
function listRead(names: string[], members: string[]): Record<string, unknown> {
  return {
    kind: "squad",
    lines: names.map((name) => ({ name, member: members.includes(name) ? name : "", section: "playing", person: true })),
    out: [],
  };
}
const SEEDED = ["Alex Admin", "Colin Collector", "Pat Player", "Tom Third", "Ian Innes"];
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

/** What the pipeline read on run A. Adam's paste came back with nothing
 *  in it; Nabeel's found his own IN plus "Mo" picked off the list. */
const RUN_A: [BodyRouting, BodyRouting] = [
  { route: "none" },
  {
    route: "self_att",
    facts: facts([claim(), otherClaim("Mo", "in")]),
  },
];

/** What it read on run B, on byte-identical input. Adam's paste found
 *  Adam plus four names off the list; Nabeel's — the one that actually
 *  added a name — came back with nothing. */
const RUN_B: [BodyRouting, BodyRouting] = [
  {
    route: "other_att",
    facts: facts([
      claim(),
      otherClaim("Ehtisham", "in"),
      otherClaim("Amir", "in"),
      otherClaim("Martin", "in"),
      otherClaim("Mo", "in"),
    ]),
  },
  { route: "none" },
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
  readings: [BodyRouting, BodyRouting],
): Promise<{ squad: string[]; members: string[] }> {
  resetDb();
  await db.run(`UPDATE "User" SET name = 'Adam Khandaza' WHERE id = $1`, [U.fresh]);
  await db.run(`UPDATE "User" SET name = 'Nabeel' WHERE id = $1`, [U.extra]);

  const a = msgId();
  const b = msgId();
  engineOn({ [ADAM_PASTE]: readings[0], [NABEEL_PASTE]: readings[1] });
  // The router flags both as pasted lists (a fact, 2026-10-30): that, not
  // the numbered shape, is what clamps what the engine may act on.
  setPastedListStub({ bodies: [ADAM_PASTE, NABEEL_PASTE] });
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

/* ══════════════════════════════════════════════════════════════════════
 * INVERTED 2026-09-06 (§10 STEP 8). THIS IS AN ACCEPTED, DOCUMENTED LOSS.
 * ══════════════════════════════════════════════════════════════════════
 *
 * WAS: "a real add ALONGSIDE a paste still registers — the clamp is not a
 * mute button". `clampRosterDerivedWrites` removed only the names the
 * LIST mentions, so "also adding Ian Innes" travelling beside a paste
 * still registered Ian.
 *
 * `analyze/route.ts`'s pasted-roster section states the change in terms:
 * the peel "loses only the residue — names the model found that the LIST
 * does not mention, i.e. prose travelling alongside a paste ('here's the
 * list, also adding Kieran'). Kieran now needs one more message, which is
 * §13's stated trade: a missed add is recoverable in one message." The
 * whole message is claimed by `reconcilePastedRoster`, which computes the
 * new lines from the list and the roster post and never consults an
 * extractor at all.
 *
 * So the test is INVERTED rather than deleted: the loss is written down
 * as a passing assertion, where a club can be told about it and where
 * restoring the behaviour would show up as a failure asking whether the
 * trade was reconsidered on purpose.
 */
test("a real add alongside a paste is LOST — the accepted cost of the paste peel", async ({
  request,
  db,
}) => {
  resetDb();
  const id = msgId();
  const body = `${ADAM_PASTE}\n\nalso adding Ian Innes, he messaged me`;
  // Perfectly good facts, and they are never consulted: "Amir" is a slot
  // in the list, "Ian Innes" is named only in the prose.
  engineOn({
    [body]: {
      route: "other_att",
      facts: facts([otherClaim("Amir", "in"), otherClaim("Ian Innes", "in")]),
    },
  });
  setPastedListStub({ bodies: [body] });
  await postAnalyze(request, [
    {
      waMessageId: id,
      body,
      authorPhone: PHONE.admin,
      authorName: "Alex Admin",
    },
  ]);

  const s = await squad(db);
  expect(
    s.some((r) => r.startsWith("Ian Innes:")),
    "the prose add is lost with the rest of the residue; Ian needs one more message",
  ).toBe(false);
  // The half that has not changed, and is the more expensive direction:
  // nobody off the LIST is registered or provisioned either.
  expect(s.some((r) => r.startsWith("Amir:"))).toBe(false);
  expect(await members(db)).not.toContain("Amir");
});

/** The seeded upcoming match confirms Alex, Colin, Pat and Tom in that
 *  order (Ben is on the bench). A forward of MatchTime's own roster post
 *  restates exactly that prefix and fills slot 5 — the S26 shape. */
const OF_RECORD_PASTE =
  "1. Alex Admin\n2. Colin Collector\n3. Pat Player\n4. Tom Third\n5. Ian Innes";

test("a paste the reader reads as the squad registers the added name — whatever the extractor read", async ({
  request,
  db,
}) => {
  // Two readings of the identical message. The model's own picks off
  // the list are discarded and recomputed from the squad, so it does
  // not matter which of these it produced.
  const readings: BodyRouting[] = [
    { route: "other_att", facts: facts([]) },
    {
      route: "other_att",
      // over-reads the list: re-registers two confirmed players and
      // misses nothing only by accident
      facts: facts([
        otherClaim("Alex Admin", "in"),
        otherClaim("Colin Collector", "in"),
        otherClaim("Ian Innes", "in"),
      ]),
    },
  ];

  const outcomes: string[][] = [];
  for (const reading of readings) {
    resetDb();
    const id = msgId();
    engineOn({ [OF_RECORD_PASTE]: reading });
    setHqSquadReaderStub({ bodies: { [OF_RECORD_PASTE]: listRead(SEEDED, SEEDED) } });
  setPastedListStub({ bodies: [OF_RECORD_PASTE] });
    await postAnalyze(request, [
      {
        waMessageId: id,
        body: OF_RECORD_PASTE,
        authorPhone: PHONE.admin,
        authorName: "Alex Admin",
      },
    ]);
    outcomes.push(await squad(db));
  }

  expect(outcomes[1]).toEqual(outcomes[0]);
  expect(outcomes[0]).toContain("Ian Innes:CONFIRMED");
  // …and nobody who was already confirmed was touched or duplicated.
  expect(outcomes[0].filter((r) => r.startsWith("Alex Admin:"))).toHaveLength(1);
});

test("the sender appending their OWN name registers them, not a third party", async ({
  request,
  db,
}) => {
  resetDb();
  const id = msgId();
  engineOn({ [OF_RECORD_PASTE]: { route: "other_att" } });
  setHqSquadReaderStub({ bodies: { [OF_RECORD_PASTE]: listRead(SEEDED, SEEDED) } });
  setPastedListStub({ bodies: [OF_RECORD_PASTE] });
  await postAnalyze(request, [
    {
      waMessageId: id,
      body: OF_RECORD_PASTE,
      authorPhone: PHONE.fresh,
      authorName: "Ian Innes",
    },
  ]);
  expect(await squad(db)).toContain("Ian Innes:CONFIRMED");
});

/* ══════════════════════════════════════════════════════════════════════
 * FIXED 2026-09-07. This was `test.fail()` — the fourth instance of the
 * "terminal short-circuit skips every guard below" class recorded in
 * MEMORY.md, and the block that documented it is deleted here as its own
 * comment instructed.
 * ══════════════════════════════════════════════════════════════════════
 *
 * WHAT WAS WRONG. `analyze/route.ts`'s pasted-roster section called
 * `decidePastedRosterRegistration` on every message and, for ANY message
 * it called a roster, did `statsRequestIds.add(...)` — which peels the
 * WHOLE message out of `fresh` before the router ever runs. The sender's
 * own OUT, sitting in the same message as the paste, was never routed,
 * never extracted, never decided and never written. Pat said "can't make
 * it lads, someone take my spot", pasted the list, and stayed down as
 * playing: the squad reads full, the vacated slot is never offered, and
 * the club turns up short.
 *
 * WHAT FIXED IT. The paste branch now owns the LIST, not the MESSAGE. It
 * still does the arithmetic (`reconcilePastedRoster`) and still registers
 * the appended names, but it leaves the message in the batch and defers
 * its own row/reply until after the owners have run. The engine's blanket
 * refusal of the shape (`attendance-engine-batch.ts`) narrowed in the same
 * change: a roster-shaped message may now carry exactly ONE thing, the
 * SENDER'S OWN DROP (`clampPastedRosterFacts`). Everything else the model
 * reads off a list — third-party INs, and the sender's own IN — is still
 * discarded, which is what keeps the two readings below landing in the
 * same place.
 *
 * WHY A DROP AND NOT AN IN. A paste can never REMOVE anyone by
 * arithmetic, so an OUT beside a paste has no other owner; and PR #35
 * measured that an IN read off a list is exactly the non-deterministic
 * write PR #39 existed to stop. §13's asymmetry points the same way: "a
 * missed add is recoverable in one message; a wrong registration on a
 * paid match is not" — and a missed DROP is neither of those, it is the
 * club a player short on the night.
 * ══════════════════════════════════════════════════════════════════════ */
test("the peel never eats a drop — an OUT beside a paste still fires", async ({
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
  const body = `can't make it lads, someone take my spot\n${ADAM_PASTE}`;
  engineOn({ [body]: { route: "self_att", facts: selfIn({ polarity: "out" }) } });
  setPastedListStub({ bodies: [body] });
  // Pat pastes the list AND says he is out. The clamp keeps the sender's
  // own OUT, so it survives even though "Pat" is not a slot.
  await postAnalyze(request, [
    {
      waMessageId: id,
      body,
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

test("an OF-RECORD paste that ALSO carries the sender's drop does BOTH", async ({
  request,
  db,
}) => {
  // The other half of the fix. The peel-never-eats-a-drop case above is
  // a list that is NOT of record, where the branch registers nobody and
  // the only thing at stake is the drop. This one is the shape where the
  // branch really acts: the paste restates the squad in Match Context
  // order and appends Ian, AND its sender says he is out in the same
  // message.
  //
  // Two owners write for one message — section 4 of `analyze/route.ts`
  // registers Ian arithmetically, the engine drops Pat — and exactly one
  // of them speaks. That is the same shape as PR #33's "a recruit ask
  // alongside a drop must do BOTH", and it is the property a peel cannot
  // have.
  resetDb();
  const id = msgId();
  const body = `${OF_RECORD_PASTE}\n\nI can't make it myself though lads`;
  engineOn({ [body]: { route: "self_att", facts: selfIn({ polarity: "out" }) } });
  setHqSquadReaderStub({ bodies: { [body]: listRead(SEEDED, SEEDED) } });
  setPastedListStub({ bodies: [body] });
  await postAnalyze(request, [
    {
      waMessageId: id,
      body,
      authorPhone: PHONE.player,
      authorName: "Pat Player",
    },
  ]);

  const s = await squad(db);
  // The list's arithmetic still ran…
  expect(s, "the appended name is still registered from the list").toContain(
    "Ian Innes:CONFIRMED",
  );
  // …and the sender's own drop was not swallowed by it.
  expect(s, "the sender's own drop must not be eaten by the paste").toContain(
    "Pat Player:DROPPED",
  );
  // Nobody else off the list moved: Alex, Colin and Tom were already
  // confirmed and stay exactly as they were, once each.
  expect(s.filter((r) => r.startsWith("Alex Admin:"))).toEqual(["Alex Admin:CONFIRMED"]);
  expect(s.filter((r) => r.startsWith("Tom Third:"))).toEqual(["Tom Third:CONFIRMED"]);
});

test("a drop with no list in it is completely unaffected by the paste branch", async ({
  request,
  db,
}) => {
  // The control. The router did not flag it as a list, so neither the
  // squad reader nor the clamp has any opinion about it.
  resetDb();
  const id = msgId();
  const body = "can't make it lads, someone take my spot";
  engineOn({ [body]: { route: "self_att", facts: selfIn({ polarity: "out" }) } });
  await postAnalyze(request, [
    { waMessageId: id, body, authorPhone: PHONE.player, authorName: "Pat Player" },
  ]);
  expect(await squad(db)).toContain("Pat Player:DROPPED");
});

test("a list that leaves a confirmed player off does not restate the squad: nobody registered, nobody dropped", async ({
  request,
  db,
}) => {
  resetDb();
  const body = "1. Alex Admin\n2. Colin Collector\n3. Tom Third\n4. Ian Innes";
  engineOn({ [body]: { route: "other_att", facts: facts([]) } });
  setHqSquadReaderStub({ bodies: { [body]: listRead(["Alex Admin", "Colin Collector", "Tom Third", "Ian Innes"], SEEDED) } });
  setPastedListStub({ bodies: [body] });
  const before = await squad(db);
  await postAnalyze(request, [{ waMessageId: msgId(), body, authorPhone: PHONE.admin, authorName: "Alex Admin" }]);
  expect(await squad(db)).toEqual(before);
});

test("a player who dropped is never brought back by a list", async ({ request, db }) => {
  resetDb();
  await db.run(`UPDATE "Attendance" SET status = 'DROPPED' WHERE "matchId" = $1 AND "userId" = $2`, [MATCH.upcoming, U.third]);
  const body = "1. Alex Admin\n2. Colin Collector\n3. Pat Player\n4. Tom Third\n5. Ian Innes";
  engineOn({ [body]: { route: "other_att", facts: facts([]) } });
  setHqSquadReaderStub({ bodies: { [body]: listRead(SEEDED, SEEDED) } });
  setPastedListStub({ bodies: [body] });
  await postAnalyze(request, [{ waMessageId: msgId(), body, authorPhone: PHONE.admin, authorName: "Alex Admin" }]);
  const s = await squad(db);
  expect(s).toContain("Ian Innes:CONFIRMED");
  expect(s).toContain("Tom Third:DROPPED");
});

test("a list the router does not flag as a pasted list is not read", async ({ request, db }) => {
  resetDb();
  engineOn({ [OF_RECORD_PASTE]: { route: "other_att", facts: facts([]) } });
  setHqSquadReaderStub({ bodies: { [OF_RECORD_PASTE]: listRead(SEEDED, SEEDED) } });
  setPastedListStub({});
  const before = await squad(db);
  await postAnalyze(request, [{ waMessageId: msgId(), body: OF_RECORD_PASTE, authorPhone: PHONE.admin, authorName: "Alex Admin" }]);
  expect(await squad(db)).toEqual(before);
});

// ── THE ROUTER'S FLAG DECIDES, NEVER THE SHAPE (2026-10-30) ────────────
//
// The attendance engine clamped a list by `parsePastedRoster`, a test on
// the numbering of the words, until the "no string parsing" sweep. Now a
// message is a list when the router says so (`pasted_list`), with the
// squad reader's answer. A numbered body the router did not flag is an
// ordinary message, read by the attendance extractor like any other.
test("a numbered body the router did NOT flag is an ordinary message: its claims are read", async ({ request, db }) => {
  resetDb();
  const body = "1. Alex Admin\n2. Colin Collector\n3. Pat Player\n4. Tom Third\n5. Ian Innes";
  engineOn({ [body]: { route: "self_att", facts: selfIn() } });
  setPastedListStub({});
  await postAnalyze(request, [{ waMessageId: msgId(), body, authorPhone: PHONE.fresh, authorName: "Ian Innes" }]);
  expect(await squad(db)).toContain("Ian Innes:CONFIRMED");
});

test("the same body flagged as a pasted list: the sender's own IN read off it is refused", async ({ request, db }) => {
  resetDb();
  const body = "1. Alex Admin\n2. Colin Collector\n3. Pat Player\n4. Tom Third\n5. Ian Innes";
  engineOn({ [body]: { route: "self_att", facts: selfIn() } });
  // The reader reads it as something other than the squad, so the list
  // registers nobody either: what the engine was given is all that could.
  setHqSquadReaderStub({ bodies: {} });
  setPastedListStub({ bodies: [body] });
  await postAnalyze(request, [{ waMessageId: msgId(), body, authorPhone: PHONE.fresh, authorName: "Ian Innes" }]);
  expect((await squad(db)).some((r) => r.startsWith("Ian Innes:"))).toBe(false);
});

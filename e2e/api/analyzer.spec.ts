/**
 * Apply-path integration tests — /api/whatsapp/analyze.
 *
 * Each test says what the ROUTER answered and what the EXTRACTOR found
 * for a body, POSTs a batch the way the Pi bot does, and asserts the
 * deterministic server-side apply path via direct DB reads. No Anthropic
 * call, no WhatsApp send (BotJobs are just rows).
 *
 * Tests are serial and share cumulative state on the UPCOMING match:
 *   start    4/5 confirmed (admin, collector, player, third) + Ben on bench
 *   T1 IN    Ian "in"             → CONFIRMED (5/5)
 *   T2 IN    Zara "in" while full → BENCH
 *   T3 OUT   Pat drops            → DROPPED + open BenchSlotOffer
 *   T4 BENCH admin demotes Tom (registerFor BENCH) → BENCH, slot freed
 *
 * ════════════════════════════════════════════════════════════════════════
 * PORTED 2026-09-06 (§10 STEP 8). SIX CASES MOVED SEAM; THREE WERE
 * DELETED EARLIER, AND THIS IS WHERE THEY WENT.
 * ════════════════════════════════════════════════════════════════════════
 *
 * The verdict seam wrote the file `analyzeBatch` read. `analyzeBatch`,
 * `SYSTEM_PROMPT`, `AnalysisVerdict` and `executeVerdict` are all
 * deleted. The six cases that pin a shipped behaviour of the apply path
 * — capacity, the bench-slot offer, a demote that must not open one, the
 * batch-final squad post, the banter-drop guard, the retry dedupe — are
 * ported here to `engineOn({ body: { route, facts } })`, which is the
 * same seam `e2e/sim/attendance-engine.spec.ts` drives.
 *
 * TWO ASSERTION VALUES CHANGED, both for the same reason, and each says
 * so at its own site: a third-party move reacts 👍 rather than 🪑,
 * because `pipeline/engine.ts:reactFor` gives a status react only when
 * the SENDER's own row moved, and the `AnalyzedMessage.handledBy` audit
 * column reads `attendance-engine` rather than `llm` (the WIRE field in
 * the response is still `llm` for every owned message).
 *
 * ── THE THREE THAT WERE DELETED, AND WHERE EACH IS COVERED NOW ───────
 *
 * These three are NOT portable, because the thing they tested is gone
 * rather than moved. Each asserted a SAFETY NET whose only input was a
 * field on `AnalysisVerdict`, and §10 step 6/8 deleted all three nets
 * from `analyze/route.ts`:
 *
 *   1. "bench-demote SAFETY NET: reply claims the move but registerFor
 *      is empty → server still demotes" (Salman Shelly, 2026-06-11,
 *      9afa357). Input: `verdict.reply`, a prose regex.
 *   2. "OUT safety net must NOT fire on a group-level chase" (Kemal,
 *      2026-05-28). Input: `verdict.reasoning`, a prose regex, in the
 *      over-fire direction.
 *   3. "OUT safety net: replacement_request with no registerAttendance
 *      drops the sender" (Mojib/Habib, 2026-05-26, f35dfe6). Same input,
 *      under-fire direction.
 *
 * COVERED NOW BY `src/lib/__tests__/seatbelt-deletion.test.ts`, which
 * inverts rather than retires: it asserts the three markers are ABSENT
 * from the route, that `executeVerdict` and the verdict types are gone,
 * and — the load-bearing half — that each net's input (`intent`,
 * `reasoning`, `reply`) appears in NO owned route's extractor schema, so
 * the error class cannot be reintroduced silently. It also asserts each
 * of the three incident DATES still has a replayable case in
 * `e2e/corpus/incidents.jsonl`, which is what stops "the incident moved"
 * from becoming "the incident was forgotten". The OUT net's own regex
 * logic remains unit-tested against real production reasoning strings in
 * `src/lib/__tests__/out-safety-net.test.ts`.
 *
 * Restating those three here against a verdict would be
 * asserting that a deleted guard still fires on input nothing can
 * produce — a green tick over nothing, which is the shape this codebase
 * hunts rather than writes.
 */
import { test, expect, postAnalyze, resetDb } from "../fixtures";
import { engineOn, otherFacts, selfIn, selfOut } from "../helpers/stub";
import { U, MATCH } from "../helpers/constants";
import type { TestDb } from "../helpers/test-db";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  resetDb();
});

let n = 0;
const msgId = () => `e2e-analyzer-${Date.now()}-${++n}`;

interface AttendanceRow {
  status: string;
  userId: string;
}

const attendance = (db: TestDb, userId: string) =>
  db.one<AttendanceRow>(
    `SELECT * FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`,
    [MATCH.upcoming, userId],
  );

const confirmedCount = (db: TestDb) =>
  db.count(
    `SELECT COUNT(*) FROM "Attendance" WHERE "matchId" = $1 AND status = 'CONFIRMED'`,
    [MATCH.upcoming],
  );

test("a self IN claim registers the sender as CONFIRMED", async ({ request, db }) => {
  const id = msgId();
  engineOn({ "Count me in for Tuesday lads": { route: "self_att", facts: selfIn() } });
  const res = await postAnalyze(request, [
    { waMessageId: id, body: "Count me in for Tuesday lads", authorPhone: "447700900009", authorName: "Ian Innes" },
  ]);
  const r = res.results.find((x: { waMessageId: string }) => x.waMessageId === id);
  expect(r.handledBy).toBe("llm");
  expect(r.react).toBe("✅"); // server recomputes the react from the real slot

  const att = await attendance(db, U.fresh);
  expect(att?.status).toBe("CONFIRMED");
});

test("IN on a full squad lands on the BENCH", async ({ request, db }) => {
  const id = msgId();
  engineOn({ "in for tuesday too": { route: "self_att", facts: selfIn() } });
  const res = await postAnalyze(request, [
    { waMessageId: id, body: "in for tuesday too", authorPhone: "447700900010", authorName: "Zara Zest" },
  ]);
  const r = res.results.find((x: { waMessageId: string }) => x.waMessageId === id);
  expect(r.react).toBe("🪑");

  const att = await attendance(db, U.extra);
  expect(att?.status).toBe("BENCH");
  expect(await confirmedCount(db)).toBe(5); // capacity respected
});

test("a self OUT claim drops the sender and opens a bench-slot offer", async ({ request, db }) => {
  const id = msgId();
  engineOn({
    "Sorry lads, something came up tonight, count me out": {
      route: "self_att",
      facts: selfOut(),
    },
  });
  const res = await postAnalyze(request, [
    { waMessageId: id, body: "Sorry lads, something came up tonight, count me out", authorPhone: "447700900003", authorName: "Pat Player" },
  ]);
  const r = res.results.find((x: { waMessageId: string }) => x.waMessageId === id);
  expect(r.react).toBe("👋");

  const att = await attendance(db, U.player);
  expect(att?.status).toBe("DROPPED");

  // Slot freed + bench non-empty → an OPEN BenchSlotOffer for Pat's slot.
  const offer = await db.one(
    `SELECT * FROM "BenchSlotOffer" WHERE "matchId" = $1 AND "resolvedAt" IS NULL AND "replacingUserId" = $2`,
    [MATCH.upcoming, U.player],
  );
  expect(offer).not.toBeNull();
});

test("third-party BENCH demote: CONFIRMED → BENCH, slot freed, no duplicate", async ({ request, db }) => {
  const before = await confirmedCount(db);
  const id = msgId();
  engineOn({
    "@Match Time move Tom to the bench please": {
      route: "other_att",
      facts: otherFacts("Tom Third", "bench"),
    },
  });
  const res = await postAnalyze(request, [
    { waMessageId: id, body: "@Match Time move Tom to the bench please", authorPhone: "447700900001", authorName: "Alex Admin", botMentioned: true },
  ]);
  const r = res.results.find((x: { waMessageId: string }) => x.waMessageId === id);
  // 👍, not 🪑: Alex's own row did not move, and a 🪑 on his message would
  // read as Alex being benched. `reactFor(status, self)` is the one place
  // that decides it.
  expect(r.react).toBe("👍");
  // The move is announced ONCE, and the sentence is the composer's. It
  // used to be `verdict.reply` passing through, with the assertion that
  // the deleted bench-demote net did not double it; there is nothing left
  // that could speak twice, so what is asserted is that the move is
  // announced at all and names the player it moved.
  expect(r.reply).toContain("Tom");
  expect((r.reply.match(/Tom/g) ?? []).length).toBe(1);

  const att = await attendance(db, U.third);
  expect(att?.status).toBe("BENCH");
  // Exactly one attendance row for Tom (no duplicate registration).
  const tomRows = await db.count(
    `SELECT COUNT(*) FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`,
    [MATCH.upcoming, U.third],
  );
  expect(tomRows).toBe(1);
  // Slot freed: confirmed count went DOWN by one.
  expect(await confirmedCount(db)).toBe(before - 1);
  // A demote (unlike a drop) must NOT open a bench-slot offer for Tom.
  const offer = await db.one(
    `SELECT * FROM "BenchSlotOffer" WHERE "matchId" = $1 AND "resolvedAt" IS NULL AND "replacingUserId" = $2`,
    [MATCH.upcoming, U.third],
  );
  expect(offer).toBeNull();
});

test("two squad questions in one batch: two answers, one roster, no contradiction", async ({ request, db }) => {
  // ── THE COMMENT THAT USED TO BE HERE WAS A KNOWN-STALE COUNT ──────
  //
  // It described a world produced by a test that had already been
  // deleted, said so, and asked the next person to fix it as part of the
  // port. This is that fix: the counts are READ rather than hard-coded,
  // so the case cannot go stale again and still says the thing that
  // matters — the number in the post is the number in the table.
  //
  // ── AND THE COLLAPSE IS NARROWER THAN IT WAS. MEASURED. ──────────
  //
  // The old title was "multiple squad-state replies collapse into ONE
  // batch-final status post", and the old body fed two CONTRADICTORY
  // model-authored replies ("We're 5/5 — full squad", "Bench is empty")
  // so the collapse could be seen silencing one and replacing the other.
  //
  // Neither can be authored now: both answers are composed from the same
  // `SquadState` read out of the database, so they cannot disagree. What
  // this batch actually produces is TWO sends — the roster post for the
  // `count` question and a one-line "On the bench: …" for the `bench`
  // one — because `composeSquadStateReply`'s collapse only claims replies
  // that SHOW SQUAD STATE, and the bench line is not one.
  //
  // That is a real difference from the old behaviour and it is asserted
  // rather than glossed: two people asked two different questions and
  // both got a true answer, which is not the failure this file is named
  // for. The failure it IS named for is two posts that contradict each
  // other, and that is what the assertions below rule out.
  const idA = msgId();
  const idB = msgId();
  engineOn({
    "@Match Time are we full for tuesday?": {
      route: "question",
      facts: { topic: "count", personRef: null, statedCount: null },
    },
    "@Match Time who's on the bench?": {
      route: "question",
      facts: { topic: "bench", personRef: null, statedCount: null },
    },
  });
  const before = await confirmedCount(db);
  const res = await postAnalyze(request, [
    { waMessageId: idA, body: "@Match Time are we full for tuesday?", authorPhone: "447700900001", authorName: "Alex Admin", botMentioned: true },
    { waMessageId: idB, body: "@Match Time who's on the bench?", authorPhone: "447700900002", authorName: "Colin Collector", botMentioned: true },
  ]);
  const spoke = res.results
    .map((x: { reply: string | null }) => x.reply ?? "")
    .filter((t: string) => t.length > 0);
  expect(spoke.length, "both questions are answered").toBe(2);

  // Exactly ONE of them carries the roster block. Two roster posts in one
  // batch is §3.2 S36 and is the thing the collapse exists to stop.
  const rosters = spoke.filter((t: string) => t.includes("*Playing:*"));
  expect(rosters, `one roster post per batch, got ${JSON.stringify(spoke)}`).toHaveLength(1);
  expect(rosters[0]).toContain(`${before}/5`);

  // And they AGREE, because both are arithmetic over the same rows: the
  // bench named in the short answer is the bench listed in the roster.
  const bench = await db.all<{ name: string }>(
    `SELECT u.name FROM "Attendance" a JOIN "User" u ON u.id = a."userId"
      WHERE a."matchId" = $1 AND a.status = 'BENCH'`,
    [MATCH.upcoming],
  );
  for (const b of bench) for (const t of spoke) expect(t).toContain(b.name);

  // A question answers; it never writes.
  expect(await confirmedCount(db)).toBe(before);
});

test("banter-drop guard: third-party OUT for a player active in the batch is refused", async ({ request, db }) => {
  // Colin is CONFIRMED and chatting in this very batch; Pat (not an
  // admin) posts banter that the stubbed "LLM" misreads as a real drop
  // (the Zeeshan 2026-06-12 incident). The guard must strip the OUT,
  // keep Colin CONFIRMED, and silence the lying reply.
  const pre = await attendance(db, U.collector);
  expect(pre?.status).toBe("CONFIRMED");

  const idChat = msgId();
  const idBanter = msgId();
  // The extractor CORRECTLY reports the OUT claim — the text contains
  // one — which is §6.2's point exactly: deciding it is banter needs
  // corroboration only the engine can see. Colin's own message carries
  // the IN claim that contradicts it.
  engineOn({
    "😂😂 never, I'm playing": { route: "self_att", facts: selfIn() },
    "Colin is out lads 😂😂": { route: "other_att", facts: otherFacts("Colin", "out") },
  });
  const res = await postAnalyze(request, [
    { waMessageId: idChat, body: "😂😂 never, I'm playing", authorPhone: "447700900002", authorName: "Colin Collector" },
    { waMessageId: idBanter, body: "Colin is out lads 😂😂", authorPhone: "447700900003", authorName: "Pat Player" },
  ]);
  const r = res.results.find((x: { waMessageId: string }) => x.waMessageId === idBanter);
  expect(r.reply).toBeNull(); // never announce a drop we refused to make
  expect(r.react).toBeNull(); // 👋 would imply the drop happened

  const att = await attendance(db, U.collector);
  expect(att?.status).toBe("CONFIRMED"); // Colin untouched
});

// ─── THREE SAFETY-NET TESTS WERE DELETED HERE (§10 step 8, 2026-09-06) ──
//
//   • "bench-demote SAFETY NET: reply claims the move but registerFor is
//      empty → server still demotes"      (Salman Shelly 2026-06-11, 9afa357)
//   • "OUT safety net must NOT fire on a group-level chase"
//                                          (Kemal 2026-05-28, the over-fire
//                                           direction and why `notDropping`
//                                           existed)
//   • "OUT safety net: replacement_request with no registerAttendance drops
//      the sender"                         (Mojib/Habib 2026-05-26, f35dfe6)
//
//   All three drove a prose regex over a field on `AnalysisVerdict`
//   (`reply`, `reasoning`) and all three nets are deleted from
//   `analyze/route.ts`. The file header carries the full argument and
//   names where each is covered now:
//   `src/lib/__tests__/seatbelt-deletion.test.ts` (the nets are gone AND
//   their inputs are unrepresentable in every owned route's extractor
//   schema, AND each incident date still has a case in
//   `e2e/corpus/incidents.jsonl`), plus
//   `src/lib/__tests__/out-safety-net.test.ts` for the OUT regex itself.
//
//   THE DELETION IS NOT "the incident stopped mattering". It is "the
//   input the guard read cannot be produced any more": one `polarity`
//   per claim cannot contradict itself, and no schema has a `reasoning`
//   or a `reply` field for a regex to parse.

test("duplicate waMessageId is deduped (bot retry safety)", async ({ request }) => {
  const id = msgId();
  engineOn({ "noise message": { route: "none" } });
  const body = { waMessageId: id, body: "noise message", authorPhone: "447700900001", authorName: "Alex Admin" as string | null };
  await postAnalyze(request, [body]);
  const second = await postAnalyze(request, [body]);
  const r = second.results.find((x: { waMessageId: string }) => x.waMessageId === id);
  expect(r.handledBy).toBe("deduped");
});

// PR #250 review, fix 7. The dedupe above looks an id up among the STORED
// rows, so two copies of a NEW message in one batch both passed it. The
// Pi can build such a batch when a catch-up re-reads a message the live
// handler has just buffered.
test("the same NEW message twice in ONE batch is analysed once", async ({ request, db }) => {
  const id = msgId();
  const other = msgId();
  engineOn({ "noise twice": { route: "none" }, "another line": { route: "none" } });
  const copy = { waMessageId: id, body: "noise twice", authorPhone: "447700900001", authorName: "Alex Admin" as string | null };
  const res = await postAnalyze(request, [
    copy,
    { waMessageId: other, body: "another line", authorPhone: "447700900001", authorName: "Alex Admin" },
    { ...copy },
  ]);
  const mine = res.results.filter((x: { waMessageId: string }) => x.waMessageId === id);
  expect(mine).toHaveLength(1);
  expect(mine[0].handledBy).not.toBe("deduped");
  expect(res.results.filter((x: { waMessageId: string }) => x.waMessageId === other)).toHaveLength(1);
  expect(await db.count(`SELECT COUNT(*) FROM "AnalyzedMessage" WHERE "waMessageId" = $1`, [id])).toBe(1);
});

test("a self OUT twice in ONE batch is acted on once: one attendance event, one result", async ({ request, db }) => {
  const id = msgId();
  engineOn({ "cant make it now sorry all": { route: "self_att", facts: selfOut() } });
  const copy = { waMessageId: id, body: "cant make it now sorry all", authorPhone: "447700900009", authorName: "Ian Innes" as string | null };
  const before = await db.count(`SELECT COUNT(*) FROM "AttendanceEvent" WHERE "userId" = $1`, [U.fresh]);
  const res = await postAnalyze(request, [copy, { ...copy }]);
  expect(res.results.filter((x: { waMessageId: string }) => x.waMessageId === id)).toHaveLength(1);
  expect(await db.count(`SELECT COUNT(*) FROM "AnalyzedMessage" WHERE "waMessageId" = $1`, [id])).toBe(1);
  expect((await db.count(`SELECT COUNT(*) FROM "AttendanceEvent" WHERE "userId" = $1`, [U.fresh])) - before).toBeLessThanOrEqual(1);
});

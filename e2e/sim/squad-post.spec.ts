/**
 * Group-simulator scenario matrix — SQUAD MESSAGING.
 *
 * The Sutton Lads 2026-06-12 failure class: contradictory squad posts,
 * stale counts, missing bench, raw-digit "names", impossible totals and
 * hallucinated bench promotions. Every squad display must match the
 * database, whatever the LLM verdicts claimed.
 *
 * As of §10 step 4 (2026-09-01) it does so by COMPOSITION rather than
 * correction: `composeSquadStateReply` replaces any reply that shows
 * squad state, or claims a move the database does not support, with a
 * post built from the rows. The post-processors these cases were
 * written against — `enforceCanonicalRoster`,
 * `rewriteOverconfidentPromotion` and the two promotion strips — are
 * gone.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * PORTED 2026-09-06 (§10 STEP 8) — AND FIVE OF THE SIX CASES LOST THEIR
 * PREMISE ALTOGETHER
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Every case here worked the same way: hand the route a stale, wrong or
 * impossible squad claim as `verdict.reply` and assert the truth came
 * out instead. "We're 5/5 — full squad ✅", "Bench is empty", "9 players
 * for Tuesday", "Greg Gale moves up from the bench".
 *
 * NOTHING CAN MAKE THOSE CLAIMS ANY MORE. A reply is composed by
 * `pipeline/compose.ts` from a `SquadState` read out of the database;
 * there is no channel by which a model-authored sentence enters the
 * route. The failure class the file is named for — the Sutton Lads
 * 2026-06-12 contradictory posts — was closed by construction in step 4
 * and its last input was removed in step 8.
 *
 * SO THE FILE IS REBUILT AROUND WHAT IS STILL FALSIFIABLE, which is the
 * other half of every one of those cases and the half that can still go
 * wrong: the batch-final post states the DATABASE's counts, names and
 * bench, it is emitted ONCE per batch however many messages asked, and a
 * raw-digit pushname never appears in it. Those are properties of the
 * composer and the collapse, not of a patcher, and they are asserted
 * against a world the batch itself changed.
 *
 * WHAT IS GONE AND IS NOT COMING BACK: "the stale prose does not
 * survive". There is no prose to survive.
 */
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import type { TestDb } from "../helpers/test-db";
import { createGroup, SimGroup } from "./group";
import { selfIn } from "../helpers/stub";

const IN = { route: "self_att", facts: selfIn() };
/** A question the answer engine owns; the ANSWER is composed from the
 *  database, so the stub can only say what was asked ABOUT. */
const ask = (topic: string) => ({
  route: "question",
  facts: { topic, personRef: null, statedCount: null },
});

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  resetDb();
});

let g: SimGroup;
const group = async (request: APIRequestContext, db: TestDb) =>
  (g ??= await createGroup(request, db, {
    maxPlayers: 5,
    attendance: [
      { key: "owner", status: "CONFIRMED" },
      { key: "alice", status: "CONFIRMED" },
      { key: "pete", status: "CONFIRMED" },
      { key: "greg", status: "BENCH" },
    ],
  })).attach(request);

test("a burst of mixed messages collapses to ONE squad+bench post built from the final DB state", async ({ request, db }) => {
  const grp = await group(request, db);
  const batch = await grp.postBatch([
    { player: "dan", body: "in", ...IN },
    // Two questions in the same batch as a write. §10 step 7's
    // `batchCarriesAnythingElse` declines to own EITHER of them, because
    // its answers are composed from a PRE-WRITE snapshot and "yes,
    // you're 3/5" beside somebody's own "in" is a claim about a squad
    // that no longer exists. The old file could not express that: the
    // mega-prompt answered both and the collapse silenced one.
    {
      player: "owner",
      body: "@Match Time are we full for tuesday?",
      tag: true,
      ...ask("count"),
    },
    {
      player: "alice",
      body: "@Match Time who's on the bench?",
      tag: true,
      ...ask("bench"),
    },
  ]);

  // Dan registered (3 → 4 confirmed).
  expect((await grp.counts()).confirmed).toBe(4);

  // ONE send for the whole batch, and it is the batch-final squad post
  // built from the rows the batch just wrote.
  const spoke = batch.results.filter((r) => (r.reply ?? "").length > 0);
  expect(spoke, `one speaker per batch, got: ${JSON.stringify(batch.results.map((r) => r.reply))}`)
    .toHaveLength(1);
  const post = spoke[0].reply!;
  expect(post).toContain("Based on all the messages I've picked up");
  expect(post).toContain("*4/5*");
  expect(post).toContain("need *1 more*");
  expect(post).toContain("*Playing:*");
  expect(post).toContain("5. 🥁"); // open slot shown as a drum
  // Bench is ALWAYS listed.
  expect(post).toContain("*Waiting list (1):*");
  expect(post).toContain("Greg Gale");
  // …and the counts are the DATABASE's, not the pre-batch snapshot's.
  expect(post).not.toContain("3/5");
  expect(post).not.toContain("5/5");
  // Nothing was queued as a second group message alongside it.
  expect(batch.groupPosts).toEqual([]);
});

/* ── PORTED 2026-09-06 (§10 step 8). WAS: "a single stale squad reply is
 * replaced wholesale by the composed post". The stale reply was a
 * `verdict.reply`; there is no such thing. What remains falsifiable is
 * that a count question ON ITS OWN — no write in the batch, so the
 * answer engine really does own it — is answered from the database. */
test("a count question on its own is answered from the database", async ({ request, db }) => {
  const grp = await group(request, db);
  const r = await grp.post("pete", "@Match Time how many are we?", {
    tag: true,
    ...ask("count"),
  });
  expect(r.reply, "the squad is 4/5 and MatchTime says so").toMatch(/4\s*\/\s*5|4 of 5/);
  expect(r.reply).not.toContain("2/5");
  expect(r.reply).not.toContain("5/5");
});

test('a FULL squad is reported full, with no slot-open language anywhere', async ({ request, db }) => {
  const grp = await group(request, db);
  await grp.post("felix", "in", IN); // 5/5 now
  const r = await grp.post("owner", "@Match Time where are we at?", {
    tag: true,
    ...ask("count"),
  });
  expect(r.reply).toContain("5/5");
  expect(r.reply).not.toContain("4/5");
  expect(r.reply).not.toMatch(/slot[s]? open/i);
});

/* ── DELETED 2026-09-06 (§10 step 8): "never a total above the cap: an
 * impossible count is replaced by the real one".
 *
 * The input was `verdict.reply = "We've got 9 players for Tuesday"` — a
 * count no state of the database could produce, fed in so the clamp (and
 * later the composer) could be seen replacing it. Every reply is now
 * arithmetic over rows, so there is no way to author "9" against a squad
 * of 5 and nothing left for the assertion to be about. The invariant it
 * protected — the number in the post is the number in the table — is
 * asserted positively by the two cases either side of this comment.
 *
 * `src/lib/pipeline/__tests__/compose.test.ts` covers the formatting
 * itself against hand-built `SquadState`s, which is where a count bug
 * would now be introduced. */

test("a bench answer never promotes anyone, and says who is actually on it", async ({ request, db }) => {
  // WAS: 'never "X moves up from the bench" while X is still benched',
  // driven by a hallucinated `verdict.reply`. The hallucination cannot be
  // authored; the property that a READ never writes still can be, and
  // that is the half worth keeping — `handleTeams`/`handleQuestion` have
  // no branch that can move a row.
  const grp = await group(request, db);
  expect(await grp.bench()).toContain("Greg Gale"); // still benched
  const r = await grp.post("owner", "@Match Time who's on the bench?", {
    tag: true,
    ...ask("bench"),
  });
  expect(r.reply ?? "").toContain("Greg Gale");
  expect(r.reply ?? "").not.toContain("moves up");
  expect((await grp.attendanceOf("greg"))?.status).toBe("BENCH");
});

test("a raw-digit pushname never appears as a player name anywhere", async ({ request, db }) => {
  const grp = await group(request, db);
  const digits = "447700909999";
  const batch = await grp.postBatch([
    {
      body: "in",
      author: { name: digits, phone: "" }, // @lid sender, digit pushname
      ...IN,
    },
    { player: "owner", body: "@Match Time who's in then?", tag: true, ...ask("squad") },
    { player: "alice", body: "@Match Time and the bench?", tag: true, ...ask("bench") },
  ]);

  // Squad full → the unknown sender is provisioned neutrally and benched.
  expect(batch.results[0].react).toBe("🪑");
  expect(await grp.bench()).toContain("New player");
  // The batch-final post shows the real bench, digit-free. It is the
  // batch's ONE send: the two questions are declined because the batch
  // also writes (§10 step 7's mixed-batch rule), so the assertion moved
  // from "the last question's reply" to "whatever spoke".
  const spoke = batch.results.filter((r) => (r.reply ?? "").length > 0);
  expect(spoke).toHaveLength(1);
  const status = spoke[0].reply!;
  expect(status).toContain("*Waiting list (2):*");
  expect(status).toContain("Greg Gale");
  expect(status).toContain("New player");
  // No reply, post or DM anywhere contains the raw digits.
  for (const r of batch.results) expect(r.reply ?? "").not.toContain(digits);
  for (const t of batch.groupPosts) expect(t).not.toContain(digits);
  for (const d of batch.dms) expect(d.text).not.toContain(digits);
});

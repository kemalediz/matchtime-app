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
 * gone. Two cases below were re-recorded because they asserted the
 * output of a patcher; each says so and why.
 */
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import type { TestDb } from "../helpers/test-db";
import { createGroup, SimGroup } from "./group";

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
    { player: "dan", body: "in" }, // default-inferred IN verdict
    {
      player: "owner",
      body: "@Match Time are we full for tuesday?",
      tag: true, // question → requires a tag under the interaction contract
      verdict: {
        intent: "question",
        reply: "We're 5/5 — full squad ✅ no more spots.",
        react: null,
        confidence: 0.95,
        reasoning: "stub: stale claim",
      },
    },
    {
      player: "alice",
      body: "@Match Time who's on the bench?",
      tag: true, // question → requires a tag under the interaction contract
      verdict: {
        intent: "question",
        reply: "Bench is empty — nobody on standby right now.",
        react: null,
        confidence: 0.95,
        reasoning: "stub: wrong bench claim",
      },
    },
  ]);

  // Dan registered (3 → 4 confirmed).
  expect((await grp.counts()).confirmed).toBe(4);

  // Both squad-state replies collapse into ONE deterministic status post
  // on the LAST message; the earlier one is silenced.
  const [, ownerR, aliceR] = batch.results;
  expect(ownerR.reply).toBeNull();
  expect(aliceR.reply).toContain("Based on all the messages I've picked up");
  expect(aliceR.reply).toContain("*4/5*");
  expect(aliceR.reply).toContain("need *1 more*");
  expect(aliceR.reply).toContain("*Playing:*");
  expect(aliceR.reply).toContain("5. 🥁"); // open slot shown as a drum
  // Bench is ALWAYS listed.
  expect(aliceR.reply).toContain("*Bench (1):*");
  expect(aliceR.reply).toContain("Greg Gale");
  // The lies never surface.
  expect(aliceR.reply).not.toContain("Bench is empty");
  expect(aliceR.reply).not.toContain("5/5");
});

// RE-RECORDED 2026-09-01 (§10 step 4). This used to assert the output of
// the count/slots-open/need-N PATCHER: "1 slot open" was the model's
// "three slots open" rewritten in place. There is no patcher any more —
// a single stale squad reply is replaced by the composed post, so the
// stale prose is not corrected, it is gone. The assertions that mattered
// (the truth is stated, the stale claims never surface) are kept and
// tightened; only the expectation of surviving PROSE was dropped, and it
// was an expectation about a mechanism that no longer exists.
test("a single stale squad reply is replaced wholesale by the composed post", async ({ request, db }) => {
  const grp = await group(request, db);
  const r = await grp.post("pete", "@Match Time how many are we?", {
    tag: true,
    verdict: {
      intent: "question",
      reply: "We're 2/5 — three slots open, need *3 more* lads!",
      react: null,
      confidence: 0.95,
      reasoning: "stub: stale snapshot",
    },
  });
  expect(r.reply).toContain("*4/5*");
  expect(r.reply).toContain("need *1 more*");
  expect(r.reply).toContain("*Playing:*");
  expect(r.reply).toContain("*Bench (1):*");
  expect(r.reply).not.toContain("2/5");
  expect(r.reply).not.toMatch(/slots? open/i);
  expect(r.reply).not.toContain("need *3 more*");
});

test('never "5/5 with a slot open": full-squad truth wipes slot-open prose', async ({ request, db }) => {
  const grp = await group(request, db);
  await grp.post("felix", "in"); // 5/5 now
  const r = await grp.post("owner", "@Match Time where are we at?", {
    tag: true,
    verdict: {
      intent: "question",
      reply: "We're 4/5 — one slot open for tuesday.",
      react: null,
      confidence: 0.95,
      reasoning: "stub: stale contradiction",
    },
  });
  expect(r.reply).toContain("5/5");
  expect(r.reply).not.toContain("4/5");
  expect(r.reply).not.toMatch(/slot[s]? open/i);
});

// RE-RECORDED 2026-09-01 (§10 step 4). The old assertion, `toContain("5
// players")`, was the CLAMP's output — "9 players" rewritten to the cap
// in place. A count that cannot be true is now a claim the database
// contradicts, so the whole sentence is replaced by the composed post,
// which states the real count in its own words.
test("never a total above the cap: an impossible count is replaced by the real one", async ({ request, db }) => {
  const grp = await group(request, db);
  const r = await grp.post("alice", "@Match Time strong turnout this week?", {
    tag: true,
    verdict: {
      intent: "question",
      reply: "We've got 9 players for Tuesday — squad looks strong.",
      react: null,
      confidence: 0.9,
      reasoning: "stub: impossible total",
    },
  });
  expect(r.reply).toContain("*5/5*");
  expect(r.reply).not.toContain("9 players");
});

test('never "X moves up from the bench" while X is still benched', async ({ request, db }) => {
  const grp = await group(request, db);
  expect(await grp.bench()).toContain("Greg Gale"); // still benched
  const r = await grp.post("owner", "@Match Time are we sorted?", {
    tag: true,
    verdict: {
      intent: "question",
      reply: "Greg Gale moves up from the bench — all sorted.",
      react: null,
      confidence: 0.9,
      reasoning: "stub: hallucinated promotion",
    },
  });
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
      verdict: {
        intent: "in",
        registerAttendance: "IN",
        react: "👍",
        confidence: 0.95,
        reasoning: "stub: lid IN",
      },
    },
    {
      player: "owner",
      body: "@Match Time who's in then?",
      tag: true,
      verdict: {
        intent: "question",
        reply: "Squad check: we're 3/5 — need 2.",
        react: null,
        confidence: 0.95,
        reasoning: "stub",
      },
    },
    {
      player: "alice",
      body: "@Match Time and the bench?",
      tag: true,
      verdict: {
        intent: "question",
        reply: "Bench is empty.",
        react: null,
        confidence: 0.95,
        reasoning: "stub",
      },
    },
  ]);

  // Squad full → the unknown sender is provisioned neutrally and benched.
  expect(batch.results[0].react).toBe("🪑");
  expect(await grp.bench()).toContain("New player");
  // The collapsed batch-final post shows the real bench, digit-free.
  const status = batch.results[2].reply;
  expect(status).toContain("*Bench (2):*");
  expect(status).toContain("Greg Gale");
  expect(status).toContain("New player");
  // No reply, post or DM anywhere contains the raw digits.
  for (const r of batch.results) expect(r.reply ?? "").not.toContain(digits);
  for (const t of batch.groupPosts) expect(t).not.toContain(digits);
  for (const d of batch.dms) expect(d.text).not.toContain(digits);
});

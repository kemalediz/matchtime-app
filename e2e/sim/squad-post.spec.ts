/**
 * Group-simulator scenario matrix — SQUAD MESSAGING.
 *
 * The Sutton Lads 2026-06-12 failure class: contradictory squad posts,
 * stale counts, missing bench, raw-digit "names", impossible totals and
 * hallucinated bench promotions. The server post-processors
 * (composeSquadStatusPost / enforceCanonicalRoster / promotion strips)
 * must make every squad display match the database, whatever the LLM
 * verdicts claimed.
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
      body: "are we full for tuesday?",
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
      body: "who's on the bench?",
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

test("a single stale squad reply is re-canonicalised: count, slots-open and need-N prose all recomputed", async ({ request, db }) => {
  const grp = await group(request, db);
  const r = await grp.post("pete", "how many are we?", {
    verdict: {
      intent: "question",
      reply: "We're 2/5 — three slots open, need *3 more* lads!",
      react: null,
      confidence: 0.95,
      reasoning: "stub: stale snapshot",
    },
  });
  expect(r.reply).toContain("4/5");
  expect(r.reply).toContain("1 slot open");
  expect(r.reply).toContain("need *1 more*");
  expect(r.reply).not.toContain("2/5");
  expect(r.reply).not.toContain("three slots open");
});

test('never "5/5 with a slot open": full-squad truth wipes slot-open prose', async ({ request, db }) => {
  const grp = await group(request, db);
  await grp.post("felix", "in"); // 5/5 now
  const r = await grp.post("owner", "where are we at?", {
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

test("never a total above the cap: impossible player counts are clamped to the truth", async ({ request, db }) => {
  const grp = await group(request, db);
  const r = await grp.post("alice", "strong turnout this week", {
    verdict: {
      intent: "question",
      reply: "We've got 9 players for Tuesday — squad looks strong.",
      react: null,
      confidence: 0.9,
      reasoning: "stub: impossible total",
    },
  });
  expect(r.reply).toContain("5 players");
  expect(r.reply).not.toContain("9 players");
});

test('never "X moves up from the bench" while X is still benched', async ({ request, db }) => {
  const grp = await group(request, db);
  expect(await grp.bench()).toContain("Greg Gale"); // still benched
  const r = await grp.post("owner", "are we sorted?", {
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
      body: "who's in then?",
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
      body: "and the bench?",
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

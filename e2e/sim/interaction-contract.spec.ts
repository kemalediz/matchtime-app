/**
 * Group-simulator regression corpus — INTERACTION CONTRACT.
 *
 * Commercialisation safety net. Drives the REAL analyze pipeline (LLM
 * stubbed) and proves MatchTime is CONSERVATIVE and PREDICTABLE:
 *
 *  - It does NOTHING on banter / hypotheticals / past-tense / third-person
 *    chatter, EVEN when a canned action verdict is fed (the deterministic
 *    gate must suppress the action — DB unchanged, no posts, no reacts).
 *  - It ACTS without a tag only on a player's own clear self-attendance.
 *  - It REQUIRES an @Match Time tag for questions / team ops.
 *  - The full-squad rollover never advances a casual "In" to next week.
 *
 * Case #1 is seeded verbatim from TODAY'S real Sutton Lads transcript
 * (2026-06-18) — the messages that must all be ignored.
 */
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import type { TestDb } from "../helpers/test-db";
import { createGroup, SimGroup, type StubVerdict } from "./group";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  resetDb();
});

// A canned ACTION verdict — fed deliberately on noise cases to PROVE the
// server-side gate suppresses the action regardless of what the LLM said.
const inVerdict: StubVerdict = {
  intent: "in",
  registerAttendance: "IN",
  react: "👍",
  confidence: 0.9,
  reasoning: "stub: canned IN to test the gate suppresses it",
};
const questionVerdict = (reply: string): StubVerdict => ({
  intent: "question",
  registerAttendance: null,
  react: null,
  reply,
  confidence: 0.9,
  reasoning: "stub: canned question answer",
});

// ── Case #1: today's Sutton Lads transcript — all must be IGNORED ──────
test.describe("Case #1 — today's Sutton Lads transcript (all noise)", () => {
  let g: SimGroup;
  const group = async (request: APIRequestContext, db: TestDb) =>
    (g ??= await createGroup(request, db, {
      maxPlayers: 14,
      attendance: [
        { key: "owner", status: "CONFIRMED" },
        { key: "alice", status: "CONFIRMED" },
        { key: "pete", status: "CONFIRMED" },
        { key: "dan", status: "CONFIRMED" },
      ],
    })).attach(request);

  // The exact transcript lines (paraphrased only to fit fictitious roster
  // names where a real handle appeared). Each one must be a no-op.
  const transcript: Array<{ key: string; body: string; verdict?: StubVerdict }> = [
    { key: "pete", body: "@Nabeel bro I was second in line to play" },
    {
      key: "dan",
      body: "they asked can anyone step in I said in you can check up the messages",
      // A REPORT of having said in, not a real IN. This is LLM-extraction
      // territory (the model must classify it noise) — the live spec
      // asserts the real model does. Here we feed the correct noise
      // verdict (default) so the corpus pins the end-to-end no-op.
    },
    {
      key: "felix",
      body: "The way its worked in the past the person next in line on the bench automatically gets the spot",
    },
    { key: "greg", body: "Return of mandem fc vs" },
    { key: "henry", body: "This week we have a special player" },
    { key: "ivan", body: "Because of him the teams will be unbalanced" },
    { key: "jake", body: "The player is Zeeshan" },
    { key: "kyle", body: "Rage bait" },
    {
      key: "liam",
      body: "If I was in the team it won't be ruined",
      // THE false-IN bug: hypothetical fed as an IN verdict → must NOT write.
      verdict: inVerdict,
    },
    { key: "mike", body: "Martin and ayaaz on the same team is ridiculous" },
    { key: "noah", body: "Fair point, Martin has 7 goals this season" },
    { key: "quinn", body: "Bro we'll make the teams manually this week" },
  ];

  test("the whole transcript leaves the DB untouched and MT silent", async ({ request, db }) => {
    const grp = await group(request, db);
    const before = await grp.counts();
    const jobsBefore = (await grp.botJobs()).length;

    const r = await grp.postBatch(transcript.map((t) => ({ player: t.key, body: t.body, verdict: t.verdict })));

    // No outbound posts/DMs.
    expect(r.groupPosts).toEqual([]);
    expect(r.dms).toEqual([]);
    // No reaction, no reply on any message.
    for (const res of r.results) {
      expect(res.react, `react on "${res.intent}"`).toBeNull();
      expect(res.reply, `reply on "${res.intent}"`).toBeNull();
    }
    // DB unchanged.
    const after = await grp.counts();
    expect(after.confirmed).toBe(before.confirmed);
    expect(after.bench).toBe(before.bench);
    expect(after.dropped).toBe(before.dropped);
    expect((await grp.botJobs()).length).toBe(jobsBefore);

    // Explicitly: the hypothetical "If I was in" author (liam, not in the
    // seeded squad) never got an attendance row. (The counts-unchanged
    // assertions above already prove no NEW writes for anyone.)
    expect(await grp.attendanceOf("liam")).toBeNull();
  });
});

// ── Positive controls ─────────────────────────────────────────────────
test.describe("positive controls", () => {
  let g: SimGroup;
  const group = async (request: APIRequestContext, db: TestDb) =>
    (g ??= await createGroup(request, db, {
      maxPlayers: 14,
      attendance: [
        { key: "owner", status: "CONFIRMED" },
        { key: "alice", status: "CONFIRMED" },
        { key: "pete", status: "CONFIRMED" },
      ],
    })).attach(request);

  test('bare "In" (no tag) → registers CONFIRMED', async ({ request, db }) => {
    const grp = await group(request, db);
    const r = await grp.post("greg", "In");
    expect(r.react).toBe("✅");
    expect(await grp.confirmed()).toContain("Greg Gale");
  });

  test('bare "Out" (no tag) → drops', async ({ request, db }) => {
    const grp = await group(request, db);
    await grp.post("henry", "in"); // get henry confirmed first
    expect(await grp.confirmed()).toContain("Henry Hill");
    const r = await grp.post("henry", "Out");
    expect(r.react).toBe("👋");
    expect(await grp.dropped()).toContain("Henry Hill");
  });

  test('untagged "what are the teams?" → noise (no reply)', async ({ request, db }) => {
    const grp = await group(request, db);
    const r = await grp.post("pete", "what are the teams?", {
      verdict: questionVerdict("Red: …, Yellow: …"),
    });
    expect(r.react).toBeNull();
    expect(r.reply).toBeNull();
    expect(r.groupPosts).toEqual([]);
  });

  test('"@Match Time what are the teams?" (tagged) → answers', async ({ request, db }) => {
    const grp = await group(request, db);
    const r = await grp.post(
      "pete",
      "@Match Time what are the teams?",
      { verdict: questionVerdict("Here's the squad so far …"), tag: true },
    );
    expect(r.reply).not.toBeNull();
  });

  test('"@Match Time generate the teams" (tagged) → generates', async ({ request, db }) => {
    // Fresh full squad so the balancer has both teams to fill (maxPlayers
    // 8 → 4-a-side). The team line-up is composed into the reply.
    const grp = (
      await createGroup(request, db, {
        maxPlayers: 8,
        attendance: [
          { key: "owner", status: "CONFIRMED" },
          { key: "alice", status: "CONFIRMED" },
          { key: "pete", status: "CONFIRMED" },
          { key: "dan", status: "CONFIRMED" },
          { key: "felix", status: "CONFIRMED" },
          { key: "greg", status: "CONFIRMED" },
          { key: "henry", status: "CONFIRMED" },
          { key: "ivan", status: "CONFIRMED" },
        ],
      })
    ).attach(request);
    const r = await grp.post("owner", "@Match Time generate the teams", {
      verdict: {
        intent: "generate_teams_request",
        react: "⚽",
        reply: null,
        confidence: 0.95,
        teamNames: null,
        includeNames: null,
        teamOverrides: null,
        reasoning: "stub: generate",
      },
      tag: true,
    });
    // The composed team line-up appears (Red/Yellow default labels).
    const post = r.reply ?? "";
    expect(post).toContain("Red");
    expect(post).toContain("Yellow");
  });

  test('untagged "generate the teams" → noise (no team post)', async ({ request, db }) => {
    const grp = (
      await createGroup(request, db, {
        maxPlayers: 8,
        attendance: [
          { key: "owner", status: "CONFIRMED" },
          { key: "alice", status: "CONFIRMED" },
          { key: "pete", status: "CONFIRMED" },
          { key: "dan", status: "CONFIRMED" },
          { key: "felix", status: "CONFIRMED" },
          { key: "greg", status: "CONFIRMED" },
          { key: "henry", status: "CONFIRMED" },
          { key: "ivan", status: "CONFIRMED" },
        ],
      })
    ).attach(request);
    const r = await grp.post("owner", "generate the teams", {
      verdict: {
        intent: "generate_teams_request",
        react: "⚽",
        reply: null,
        confidence: 0.95,
        teamNames: null,
        includeNames: null,
        teamOverrides: null,
        reasoning: "stub: generate but untagged",
      },
    });
    expect(r.groupPosts).toEqual([]);
    expect(r.reply).toBeNull();
    expect(r.react).toBeNull();
  });
});

// ── Full-squad rollover (Deliverable 2 end-to-end) ────────────────────
test.describe("full-squad rollover", () => {
  test('FULL this-week match + empty next-week match → "In" benches on THIS week, not next', async ({
    request,
    db,
  }) => {
    const grp = await createGroup(request, db, {
      maxPlayers: 4,
      upcomingMatch: { daysFromNow: 0 }, // tonight (today)
      attendance: [
        { key: "owner", status: "CONFIRMED" },
        { key: "alice", status: "CONFIRMED" },
        { key: "pete", status: "CONFIRMED" },
        { key: "dan", status: "CONFIRMED" }, // 4/4 → FULL
      ],
    });
    const thisWeek = grp.matchId!;
    const nextWeek = await grp.addMatch({ daysFromNow: 7 }); // empty next-week match

    // A casual "In" while tonight is FULL.
    const r = await grp.post("greg", "in");

    // Must land on THIS week as BENCH (squad full), NOT next week.
    expect(r.react).toBe("🪑");
    expect(await grp.bench(thisWeek)).toContain("Greg Gale");
    // Next week's match must be completely untouched.
    expect(await grp.confirmed(nextWeek)).toEqual([]);
    expect(await grp.bench(nextWeek)).toEqual([]);
    expect(await grp.attendanceOf("greg", nextWeek)).toBeNull();
  });
});

/**
 * Group-simulator scenario — TEAM NAME GENERATION (stubbed LLM).
 *
 * When an admin asks MatchTime to generate the teams AND to invent the
 * team names for the week, the bot:
 *   - sanitises + persists the chosen pair to Match.teamLabels (the
 *     highest-precedence per-match display override), and
 *   - uses those names everywhere that match's teams are shown (the
 *     generation post AND later surfaces like the match-day reminder).
 *
 * Control case: a plain "generate teams" (teamNames:null) leaves
 * Match.teamLabels empty and the post falls back to Red/Yellow.
 *
 * Verdicts are stubbed (deterministic) — only the persistence + display
 * wiring is under test here; the LLM's name-choosing is covered by the
 * live suite (teams-live.spec.ts).
 */
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import type { TestDb } from "../helpers/test-db";
import { createGroup, SimGroup } from "./group";
import { londonAt } from "../helpers/constants";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  resetDb();
});

// maxPlayers 8 → 4-a-side → 8 confirmed players fills both teams.
const FULL_ATTENDANCE = [
  { key: "owner", status: "CONFIRMED" as const },
  { key: "alice", status: "CONFIRMED" as const },
  { key: "pete", status: "CONFIRMED" as const },
  { key: "dan", status: "CONFIRMED" as const },
  { key: "felix", status: "CONFIRMED" as const },
  { key: "greg", status: "CONFIRMED" as const },
  { key: "henry", status: "CONFIRMED" as const },
  { key: "ivan", status: "CONFIRMED" as const },
];

async function matchLabels(grp: SimGroup): Promise<string[]> {
  const row = await grp.db.one<{ teamLabels: string[] }>(
    `SELECT "teamLabels" FROM "Match" WHERE id = $1`,
    [grp.matchId!],
  );
  return row?.teamLabels ?? [];
}

test('(a) admin asks MT to pick names → Match.teamLabels persisted + used in the post and later surfaces', async ({
  request,
  db,
}) => {
  const grp = (
    await createGroup(request, db, {
      maxPlayers: 8,
      attendance: FULL_ATTENDANCE,
      // upcoming match is today so the match-day reminder fires on the tick.
      upcomingMatch: { daysFromNow: 0 },
    })
  ).attach(request);

  // Before: no per-match override.
  expect(await matchLabels(grp)).toEqual([]);

  const r = await grp.post(
    "alice",
    "@Match Time generate the teams. Team names will be something you randomly select for this week",
    {
      verdict: {
        intent: "generate_teams_request",
        react: "⚽",
        confidence: 0.95,
        teamNames: ["Falcons", "Sharks"],
        includeNames: null,
        teamOverrides: null,
        reasoning: "stub: generate teams + MT picks the names",
      },
    },
  );

  // Persisted as the per-match display override (index 0 = RED, 1 = YELLOW).
  expect(await matchLabels(grp)).toEqual(["Falcons", "Sharks"]);

  // The generation post uses the fun names, not Red/Yellow.
  const post = r.reply ?? "";
  expect(post).toContain("Falcons");
  expect(post).toContain("Sharks");
  expect(post).not.toContain("Red");
  expect(post).not.toContain("Yellow");

  // A later surface (the match-day teams reminder) also shows the names.
  const due = await grp.duePosts(londonAt(0, 17, 0));
  const teamsBlock = due.find(
    (d) => typeof d.text === "string" && /Falcons/.test(d.text),
  );
  expect(teamsBlock, "match-day teams reminder should show the fun names").toBeTruthy();
  expect(teamsBlock!.text).toContain("Falcons");
  expect(teamsBlock!.text).toContain("Sharks");
  expect(teamsBlock!.text).not.toContain("Red");
  expect(teamsBlock!.text).not.toContain("Yellow");
});

test('(b) control: plain "generate teams" → Match.teamLabels stays empty, post uses Red/Yellow', async ({
  request,
  db,
}) => {
  const grp = (
    await createGroup(request, db, {
      maxPlayers: 8,
      attendance: FULL_ATTENDANCE,
    })
  ).attach(request);

  expect(await matchLabels(grp)).toEqual([]);

  const r = await grp.post("alice", "generate the teams", {
    verdict: {
      intent: "generate_teams_request",
      react: "⚽",
      confidence: 0.95,
      teamNames: null,
      includeNames: null,
      teamOverrides: null,
      reasoning: "stub: generate teams, no naming request",
    },
  });

  // No naming request → no per-match override written.
  expect(await matchLabels(grp)).toEqual([]);

  const post = r.reply ?? "";
  expect(post).toContain("Red");
  expect(post).toContain("Yellow");
});

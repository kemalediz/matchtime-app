/**
 * Group-simulator scenario — SHOW EXISTING TEAMS (stubbed LLM).
 *
 * The bug: "@Match Time show the teams once more" used to misclassify as
 * generate_teams_request, which RE-RAN the balancer (reshuffle, possible
 * rename via fun-names). The fix adds a `show_teams_request` intent that
 * RE-POSTS the already-generated teams verbatim — no balancer, no
 * mutation of TeamAssignment rows or Match.teamLabels.
 *
 * Scenarios:
 *   (a) teams already exist + show_teams_request → same teams re-posted
 *       (same players per side, same labels); TeamAssignment rows + labels
 *       UNCHANGED.
 *   (b) show_teams_request with NO teams → "not generated yet" reply;
 *       nothing created.
 *   (c) regression: generate_teams_request still generates teams.
 *
 * Verdicts are stubbed (deterministic) — only the re-post + no-mutation
 * wiring is under test here; live classification is covered by
 * show-teams-live.spec.ts.
 */
import { test, expect, resetDb } from "../fixtures";
import { createGroup, SimGroup } from "./group";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  resetDb();
});

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

async function matchStatus(grp: SimGroup): Promise<string> {
  const row = await grp.db.one<{ status: string }>(
    `SELECT status FROM "Match" WHERE id = $1`,
    [grp.matchId!],
  );
  return row!.status;
}

/** TeamAssignment rows as a stable, comparable snapshot. */
async function teamRows(
  grp: SimGroup,
): Promise<Array<{ name: string; team: string }>> {
  return grp.db.all<{ name: string; team: string }>(
    `SELECT u.name, ta.team
       FROM "TeamAssignment" ta JOIN "User" u ON u.id = ta."userId"
      WHERE ta."matchId" = $1
      ORDER BY ta.team ASC, u.name ASC`,
    [grp.matchId!],
  );
}

test("(a) teams exist + show_teams_request → same teams re-posted, no reshuffle / no mutation", async ({
  request,
  db,
}) => {
  const grp = (
    await createGroup(request, db, {
      maxPlayers: 8,
      attendance: FULL_ATTENDANCE,
    })
  ).attach(request);

  // First, generate the teams with bot-picked fun names so we can assert
  // the labels survive the re-post too.
  const gen = await grp.post(
    "alice",
    "@Match Time generate the teams, pick fun names",
    {
      verdict: {
        intent: "generate_teams_request",
        react: "⚽",
        confidence: 0.95,
        teamNames: ["Falcons", "Sharks"],
        includeNames: null,
        teamOverrides: null,
        reasoning: "stub: generate + fun names",
      },
    },
  );
  const generatedPost = gen.reply ?? "";
  expect(generatedPost).toContain("Falcons");
  expect(generatedPost).toContain("Sharks");

  // Snapshot the canonical state after generation.
  const rowsBefore = await teamRows(grp);
  expect(rowsBefore.length).toBe(8);
  expect(await matchLabels(grp)).toEqual(["Falcons", "Sharks"]);
  expect(await matchStatus(grp)).toBe("TEAMS_GENERATED");

  // Now ask to SEE them again.
  const show = await grp.post("pete", "@Match Time show the teams once more", {
    verdict: {
      intent: "show_teams_request",
      react: "👀",
      confidence: 0.95,
      reasoning: "stub: re-post existing teams",
    },
  });

  const showPost = show.reply ?? "";
  // Re-post shows the SAME labels + SAME players.
  expect(showPost).toContain("Falcons");
  expect(showPost).toContain("Sharks");
  for (const r of rowsBefore) {
    expect(showPost).toContain(r.name);
  }

  // CRITICAL: nothing mutated — same TeamAssignment rows, same labels.
  expect(await teamRows(grp)).toEqual(rowsBefore);
  expect(await matchLabels(grp)).toEqual(["Falcons", "Sharks"]);

  // The re-post is byte-identical to the original generation post body
  // (the formatter is shared).
  expect(showPost).toBe(generatedPost);
});

test('(b) show_teams_request with NO teams yet → "not generated" reply, nothing created', async ({
  request,
  db,
}) => {
  const grp = (
    await createGroup(request, db, {
      maxPlayers: 8,
      attendance: FULL_ATTENDANCE,
    })
  ).attach(request);

  expect((await teamRows(grp)).length).toBe(0);

  const show = await grp.post("alice", "@Match Time show me the teams again", {
    verdict: {
      intent: "show_teams_request",
      react: "🤔",
      confidence: 0.95,
      reasoning: "stub: show teams but none exist",
    },
  });

  const reply = show.reply ?? "";
  expect(reply.toLowerCase()).toContain("generate");
  expect(reply.length).toBeGreaterThan(0);

  // Nothing was created — no teams, status untouched.
  expect((await teamRows(grp)).length).toBe(0);
  expect(await matchStatus(grp)).toBe("UPCOMING");
});

test("(c) regression: generate_teams_request still generates teams", async ({
  request,
  db,
}) => {
  const grp = (
    await createGroup(request, db, {
      maxPlayers: 8,
      attendance: FULL_ATTENDANCE,
    })
  ).attach(request);

  expect((await teamRows(grp)).length).toBe(0);

  const r = await grp.post("alice", "generate the teams", {
    verdict: {
      intent: "generate_teams_request",
      react: "⚽",
      confidence: 0.95,
      teamNames: null,
      includeNames: null,
      teamOverrides: null,
      reasoning: "stub: plain generate",
    },
  });

  const post = r.reply ?? "";
  expect(post).toContain("Red");
  expect(post).toContain("Yellow");
  expect((await teamRows(grp)).length).toBe(8);
  expect(await matchStatus(grp)).toBe("TEAMS_GENERATED");
});

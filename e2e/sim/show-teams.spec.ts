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
 * The router and the teams extractor are stubbed (deterministic) — only
 * the re-post + no-mutation wiring is under test here; live
 * classification is covered by show-teams-live.spec.ts.
 *
 * ── PORTED 2026-09-06, §10 STEP 8 ───────────────────────────────────
 *
 * `intent: "show_teams_request"` vs `"generate_teams_request"` became
 * one route (`balancer`) and one FACT (`TeamFacts.action`, "show" vs
 * "generate"). That is not cosmetic: §3.2 S19's incident was the model
 * picking the wrong one of two INTENT NAMES, and `types.ts` records that
 * `team_ops` was renamed `balancer` for exactly that reason. The
 * distinction the file exists for is now a field on a schema rather than
 * a word in a prompt.
 */
import { test, expect, resetDb } from "../fixtures";
import { createGroup, SimGroup } from "./group";

/** The teams extractor's raw body. `action` is the whole test. */
const teams = (action: "show" | "generate", teamNames: [string, string] | null = null) => ({
  route: "balancer",
  facts: { action, includeRefs: [], teamNames, swaps: [], pairings: [] },
});

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
      // Teams are built only on match day (2026-09-29), so the match is today.
      upcomingMatch: { daysFromNow: 0 },
    })
  ).attach(request);

  // First, generate the teams with bot-picked fun names so we can assert
  // the labels survive the re-post too.
  const gen = await grp.post("alice", "@Match Time generate the teams, pick fun names", {
    ...teams("generate", ["Falcons", "Sharks"]),
    tag: true,
  });
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
    ...teams("show"),
    tag: true,
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

  // ── ONE ASSERTION RELAXED, 2026-09-06, AND EXACTLY ONE ──────────
  //
  // This required the re-post to be BYTE-IDENTICAL to the generation
  // post, on the grounds that "the formatter is shared". It no longer
  // is: `generate` composes its post inside `generateTeamsForMatch`,
  // while `show` emits a `teams_post` speech act that
  // `pipeline/compose.ts` renders through `group-copy.ts`. The two
  // differ by the kickoff label alone — "— 21:00 at Sim Arena" against
  // "— Tue 21:00 at Sim Arena".
  //
  // Byte-equality was a proxy for the thing that matters, so the thing
  // that matters is asserted directly instead: the same two labels, the
  // same players, in the same order, on the same sides. A reshuffle or a
  // rename would fail this exactly as it failed the old one; only a
  // difference in how the kickoff is worded now passes.
  const teamBlocks = (post: string) =>
    post
      .split("\n")
      .filter((l) => /^\*|^\d+\./.test(l.trim()))
      .join("\n");
  expect(teamBlocks(showPost)).toBe(teamBlocks(generatedPost));
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
    ...teams("show"),
    tag: true,
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
      // Teams are built only on match day (2026-09-29), so the match is today.
      upcomingMatch: { daysFromNow: 0 },
    })
  ).attach(request);

  expect((await teamRows(grp)).length).toBe(0);

  // Interaction contract: team ops require an @Match Time tag.
  const r = await grp.post("alice", "@Match Time generate the teams", {
    tag: true,
    ...teams("generate"),
  });

  const post = r.reply ?? "";
  expect(post).toContain("Red");
  expect(post).toContain("Yellow");
  expect((await teamRows(grp)).length).toBe(8);
  expect(await matchStatus(grp)).toBe("TEAMS_GENERATED");
});

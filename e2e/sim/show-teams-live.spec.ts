/**
 * SHOW vs GENERATE TEAMS — LIVE-LLM classification suite.
 *
 * Drives the REAL Anthropic model (no stubbed verdict) to confirm the
 * analyzer distinguishes:
 *   - SEE / re-post CURRENT teams  → intent "show_teams_request"
 *   - CREATE / CHANGE the teams    → intent "generate_teams_request"
 *
 * Opt-in: only runs when MT_SIM_LIVE_LLM=1. Default suite SKIPS it.
 *
 * Run: MT_SIM_LIVE_LLM=1 npx tsx e2e/run.ts sim/show-teams-live.spec.ts
 */
import { test, expect, resetDb } from "../fixtures";
import { createGroup, SimGroup } from "./group";

const LIVE = process.env.MT_SIM_LIVE_LLM === "1";

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

/** Pre-generate teams so a "show the teams" request has something to
 *  re-post and the model isn't tempted to read intent from an empty state. */
async function withGeneratedTeams(
  request: import("@playwright/test").APIRequestContext,
  db: import("../helpers/test-db").TestDb,
): Promise<SimGroup> {
  const grp = (
    await createGroup(request, db, {
      maxPlayers: 8,
      attendance: FULL_ATTENDANCE,
    })
  ).attach(request);
  await db.run(`UPDATE "Match" SET status = 'TEAMS_GENERATED' WHERE id = $1`, [
    grp.matchId!,
  ]);
  // Seed TeamAssignment rows directly (live mode skips the stub, so we
  // can't drive a generate verdict deterministically here).
  const rows = await db.all<{ id: string }>(
    `SELECT "userId" AS id FROM "Attendance" WHERE "matchId" = $1 AND status = 'CONFIRMED' ORDER BY position ASC`,
    [grp.matchId!],
  );
  let i = 0;
  for (const r of rows) {
    await db.run(
      `INSERT INTO "TeamAssignment" (id, "matchId", "userId", team)
       VALUES ($1, $2, $3, $4)`,
      [
        `live-ta-${grp.matchId}-${i}`,
        grp.matchId!,
        r.id,
        i % 2 === 0 ? "RED" : "YELLOW",
      ],
    );
    i++;
  }
  return grp;
}

(LIVE ? test.describe : test.describe.skip)(
  "show vs generate teams classification LIVE (real Anthropic model)",
  () => {
    test.describe.configure({ mode: "serial" });
    test.beforeAll(resetDb);

    const SHOW_PHRASES = [
      "@Match Time show the teams once more",
      "@Match Time show me the teams again",
    ];
    const GENERATE_PHRASES = [
      "@Match Time generate the teams",
      "@Match Time redo the teams",
      "@Match Time shuffle the teams",
    ];

    for (const phrase of SHOW_PHRASES) {
      test(`"${phrase}" → show_teams_request`, async ({ request, db }) => {
        test.setTimeout(120_000);
        const grp = await withGeneratedTeams(request, db);
        const r = await grp.post("alice", phrase);
        // eslint-disable-next-line no-console
        console.log(`[show-teams-live] "${phrase}" → ${r.intent}`);
        expect(r.intent).toBe("show_teams_request");
      });
    }

    for (const phrase of GENERATE_PHRASES) {
      test(`"${phrase}" → generate_teams_request`, async ({ request, db }) => {
        test.setTimeout(120_000);
        const grp = await withGeneratedTeams(request, db);
        const r = await grp.post("alice", phrase);
        // eslint-disable-next-line no-console
        console.log(`[show-teams-live] "${phrase}" → ${r.intent}`);
        expect(r.intent).toBe("generate_teams_request");
      });
    }
  },
);

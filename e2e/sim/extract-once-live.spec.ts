/**
 * ONE EXTRACTION PER MESSAGE, LIVE (Sutton FC, 2026-10-20).
 *
 * Production batch f3898ab5 ran the teams extractor twice on "@Match
 * Time generate the teams", once for the answer owner and once for
 * team-ops. This drives the REAL router and extractors on the dev key
 * through the real analyze route and reads back what was billed: one
 * extraction per message in `pipelineTrace`, and the club's ledger
 * (`OrgAiUsage`) itemised against it.
 *
 * Opt-in: runs only when MT_SIM_LIVE_LLM=1. About 5 model calls.
 * Run: MT_SIM_LIVE_LLM=1 npx tsx e2e/run.ts sim/extract-once-live.spec.ts
 */
import { test, expect, resetDb } from "../fixtures";
import type { TestDb } from "../helpers/test-db";
import { createGroup } from "./group";

const LIVE = process.env.MT_SIM_LIVE_LLM === "1";

const FULL_ATTENDANCE = ["owner", "alice", "pete", "dan", "felix", "greg", "henry", "ivan"].map((key) => ({
  key,
  status: "CONFIRMED" as const,
}));

type Trace = { router?: { route: string }; extractions: Array<Record<string, any>> };

async function traceAndLedger(db: TestDb, orgId: string, body: string) {
  const row = await db.one<{ pipelineTrace: Trace }>(
    `SELECT "pipelineTrace" FROM "AnalyzedMessage" WHERE "orgId" = $1 AND body = $2`,
    [orgId, body],
  );
  const usage = await db.one<{ calls: number; costUsd: number }>(
    `SELECT calls, "costUsd" FROM "OrgAiUsage" WHERE "orgId" = $1`,
    [orgId],
  );
  const t = row!.pipelineTrace;
  const traced = t.extractions.flatMap((x) => x.calls as Array<{ costUsd?: number }>);
  // eslint-disable-next-line no-console
  console.log(
    `[extract-once-live] ${JSON.stringify(body)}: route=${t.router?.route} ` +
      `extractions=${JSON.stringify(t.extractions.map((x) => ({ owner: x.owner, extractor: x.extractor, sharedWith: x.sharedWith, calls: x.calls.length, costUsd: x.calls.map((c: any) => c.costUsd) })))} ` +
      `ledger calls=${usage?.calls} costUsd=${usage?.costUsd} (extractor calls in trace=${traced.length})`,
  );
  return { t, usage };
}

(LIVE ? test.describe : test.describe.skip)("one extraction per message, LIVE", () => {
  test.describe.configure({ mode: "serial" });
  test.beforeAll(resetDb);

  test("'@Match Time generate the teams': one teams extractor call, read by both owners", async ({ request, db }) => {
    test.setTimeout(120_000);
    const grp = (await createGroup(request, db, { maxPlayers: 8, attendance: FULL_ATTENDANCE })).attach(request);
    const body = "@Match Time generate the teams";
    await grp.post("alice", body, { tag: true });
    const { t } = await traceAndLedger(db, grp.orgId, body);
    expect(t.router?.route).toBe("balancer");
    expect(t.extractions).toHaveLength(1);
    expect(t.extractions[0]).toMatchObject({ extractor: "teams", facts: { kind: "teams", action: "generate" } });
    expect(t.extractions[0].calls).toHaveLength(1);
    expect(t.extractions[0].sharedWith).toEqual(["team_ops"]);
  });

  test("a score: one score extractor call", async ({ request, db }) => {
    test.setTimeout(120_000);
    const grp = (
      await createGroup(request, db, {
        upcomingMatch: false,
        completedMatch: {
          daysAgo: 1,
          status: "TEAMS_PUBLISHED",
          redScore: null,
          yellowScore: null,
          confirmedKeys: ["owner", "alice", "pete", "dan"],
          teams: { owner: "RED", pete: "RED", alice: "YELLOW", dan: "YELLOW" },
        },
      })
    ).attach(request);
    const body = "@Match Time 5-3 to red last night";
    await grp.post("owner", body, { tag: true });
    const { t } = await traceAndLedger(db, grp.orgId, body);
    expect(t.router?.route).toBe("score");
    expect(t.extractions).toHaveLength(1);
    expect(t.extractions[0]).toMatchObject({ owner: "score", extractor: "score" });
    expect(t.extractions[0].calls).toHaveLength(1);
  });
});

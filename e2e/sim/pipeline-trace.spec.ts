/**
 * `AnalyzedMessage.pipelineTrace`, through the REAL analyze route and a
 * REAL database.
 *
 * 2026-09-24: the extractor said `polarity: "bench"` for Erdal's plain
 * "in", the engine benched him, and the database could not say which
 * stage was wrong. The unit tests in `src/lib/pipeline/__tests__/
 * trace.test.ts` prove the trace is built, bounded and never breaks
 * analysis. This proves the wiring: the route opens the collector, the
 * gate and the runner record into it, and the row carries it after the
 * request.
 *
 * Driven through the two stub seams, like `attendance-engine.spec.ts`:
 * the router stub says the route, the extractor stub the facts JSON (so
 * `parseFacts` still runs for real). No model is called.
 */
import { test, expect, resetDb } from "../fixtures";
import { createGroup } from "./group";
import {
  claim,
  clearExtractorStub,
  clearRouterStub,
  facts,
  setExtractorStub,
  setRouterStub,
} from "../helpers/stub";

const LIVE = process.env.MT_SIM_LIVE_LLM === "1";

(LIVE ? test.describe.skip : test.describe)("pipeline trace on AnalyzedMessage", () => {
  test.describe.configure({ mode: "serial" });
  test.beforeAll(resetDb);
  test.afterEach(() => {
    clearRouterStub();
    clearExtractorStub();
  });

  test("the row keeps the router's route and the extractor's claims", async ({ request, db }) => {
    const g = await createGroup(request, db, { attendance: [] });
    setRouterStub({ floor: false, bodies: { in: "self_att" } });
    setExtractorStub({ bodies: { in: facts([claim({ polarity: "bench", confidence: 0.61 })]) } });

    await g.postBatch([{ player: "pete", body: "in" }]);

    const row = await db.one<{ handledBy: string; pipelineTrace: Record<string, any> | null }>(
      `SELECT "handledBy", "pipelineTrace" FROM "AnalyzedMessage" WHERE "orgId" = $1 AND body = 'in'`,
      [g.orgId],
    );
    expect(row?.handledBy).toBe("attendance-engine");
    const t = row!.pipelineTrace!;
    expect(t, "the route saved a trace for the message").not.toBeNull();
    expect(t.v).toBe(1);
    expect(t.router).toMatchObject({ route: "self_att", floor: false });
    expect(t.extractions).toHaveLength(1);
    expect(t.extractions[0]).toMatchObject({
      owner: "attendance",
      route: "self_att",
      extractor: "attendance",
      client: "extractor-stub",
      facts: { kind: "attendance", claims: [{ polarity: "bench", subject: "sender", confidence: 0.61 }] },
    });
  });

  test("a message routed to banter still records its route, and no extraction", async ({ request, db }) => {
    const g = await createGroup(request, db, { attendance: [] });
    setRouterStub({ floor: false, bodies: { "😂😂": "none" } });

    await g.postBatch([{ player: "pete", body: "😂😂" }]);

    const row = await db.one<{ pipelineTrace: Record<string, any> | null }>(
      `SELECT "pipelineTrace" FROM "AnalyzedMessage" WHERE "orgId" = $1 AND body = '😂😂'`,
      [g.orgId],
    );
    expect(row!.pipelineTrace).toMatchObject({ v: 1, router: { route: "none" }, extractions: [] });
  });
});

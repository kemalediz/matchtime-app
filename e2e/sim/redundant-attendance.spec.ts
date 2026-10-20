/**
 * A REPEATED CLAIM IS ACKNOWLEDGED LIKE A FRESH ONE, through the REAL
 * analyze route and a REAL database (FNF, 2026-10-20).
 *
 * Naim, already taken out by an organiser, typed "@Match Time out" in the
 * players' group and saw nothing at all. A fresh OUT gets 👋; a repeated
 * one now gets the same 👋, with no write and no message. The same for an
 * IN from a player already in (✅).
 *
 * The history the Pi sends carries the sender's own line in its RAW
 * spelling ("@158055467598020 out"), exactly as it did for Naim, so the
 * route's alignment (`lib/history-own-lines.ts`) runs on the path too.
 * The extractor is stubbed with the facts the live model returns for the
 * corrected input; the unit test `redundant-attendance-claim.test.ts`
 * pins what the extractor is shown.
 */
import { test, expect, resetDb } from "../fixtures";
import { createGroup } from "./group";
import { claim, clearExtractorStub, clearRouterStub, facts } from "../helpers/stub";

const LIVE = process.env.MT_SIM_LIVE_LLM === "1";

(LIVE ? test.describe.skip : test.describe)("a repeated attendance claim", () => {
  test.describe.configure({ mode: "serial" });
  test.beforeAll(resetDb);
  test.afterEach(() => {
    clearRouterStub();
    clearExtractorStub();
  });

  test("OUT when already out: 👋, still DROPPED, nothing said", async ({ request, db }) => {
    const g = await createGroup(request, db, {
      attendance: [
        { key: "dan", status: "CONFIRMED" as const },
        { key: "pete", status: "DROPPED" as const },
      ],
    });
    const res = await g.postBatch(
      [{ player: "pete", body: "@Match Time out", tag: true, route: "self_att", facts: facts([claim({ polarity: "out" })]) }],
      {
        history: [{ authorName: "Pete", body: "@158055467598020 out" }],
      },
    );

    expect(res.results[0].react).toBe("👋");
    expect(res.results[0].reply ?? null).toBeNull();
    expect((await g.attendanceOf("pete"))?.status).toBe("DROPPED");
    expect(await g.counts()).toMatchObject({ confirmed: 1 });
    expect(res.groupPosts).toEqual([]);
    expect(res.dms).toEqual([]);
  });

  test("IN when already in: ✅, still CONFIRMED, nothing said", async ({ request, db }) => {
    const g = await createGroup(request, db, {
      attendance: [{ key: "pete", status: "CONFIRMED" as const }],
    });
    const res = await g.postBatch([
      { player: "pete", body: "@Match Time in", tag: true, route: "self_att", facts: facts([claim({ polarity: "in" })]) },
    ]);

    expect(res.results[0].react).toBe("✅");
    expect(res.results[0].reply ?? null).toBeNull();
    expect((await g.attendanceOf("pete"))?.status).toBe("CONFIRMED");
    expect(await g.counts()).toMatchObject({ confirmed: 1 });
    expect(res.groupPosts).toEqual([]);
  });
});

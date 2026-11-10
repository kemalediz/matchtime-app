/**
 * THE 2026-11-10 SUTTON FC INCIDENT, END TO END THROUGH THE REAL ROUTE.
 *
 *   Tue 12:14 GMT  Kemal: "@Match Time reduce my strength for this match as
 *                  I am quite tired."
 *                  → router `admin_ops`, admin extractor `other`, and the
 *                    admin fallback sent the club's settings page.
 *
 * The rating adjuster reads the week's chat (`AnalyzedMessage` bodies) when
 * the teams are made, so the message itself does what was asked. Pinned
 * here against Postgres: as the rewritten prompts read it (router
 * `balancer`, teams extractor `form`), MatchTime says it is noted, builds
 * nothing, never mentions settings, and the message is kept where the
 * adjuster reads it.
 *
 * The router and the extractor are STUBBED: no model is called.
 */
import { test, expect, postAnalyze, resetDb } from "../fixtures";
import { engineOn } from "../helpers/stub";
import { MATCH, NAME, PHONE, U } from "../helpers/constants";
import type { TestDb } from "../helpers/test-db";

test.describe.configure({ mode: "serial" });

let n = 0;
const msgId = () => `e2e-formnote-${Date.now()}-${++n}`;

const TIRED = "@Match Time reduce my strength for this match as I am quite tired.";
const FORM_ROUTING = {
  route: "balancer",
  facts: { action: "form", includeRefs: [], teamNames: [], swaps: [], moves: [], pairings: [], swapSides: false, toMatchTime: true },
};

async function teamRows(db: TestDb): Promise<number> {
  return db.count(`SELECT COUNT(*) FROM "TeamAssignment" WHERE "matchId" = $1`, [MATCH.upcoming]);
}

function resultFor(res: { results: Array<Record<string, unknown>> }, id: string) {
  const r = res.results.find((x) => x.waMessageId === id);
  expect(r, JSON.stringify(res.results)).toBeTruthy();
  return r as { reply: string | null; intent: string };
}

test.describe("a form note is noted for the teams, never sent to settings", () => {
  test.beforeEach(() => {
    resetDb();
  });

  test("THE INCIDENT: noted for when the teams are made, nothing built, the message kept for the adjuster", async ({
    request,
    db,
  }) => {
    engineOn({ [TIRED]: FORM_ROUTING });
    const id = msgId();
    const res = await postAnalyze(request, [
      { waMessageId: id, body: TIRED, authorPhone: PHONE.admin, authorName: NAME.admin, botMentioned: true },
    ]);
    const r = resultFor(res, id);
    expect(r.reply).toBe("Noted: I'll take it into account when the teams are made, for this match only.");
    expect(r.reply).not.toContain("settings");
    expect(r.intent).toBe("form_note");
    expect(await teamRows(db)).toBe(0);

    // What the rating adjuster reads when the teams are made.
    const row = await db.one<{ body: string; intent: string }>(
      `SELECT body, intent FROM "AnalyzedMessage" WHERE "waMessageId" = $1`,
      [id],
    );
    expect(row).toMatchObject({ body: TIRED, intent: "form_note" });
  });

  test("teams already made: it counts if they are made again, and the sheet is untouched", async ({ request, db }) => {
    for (const [userId, team] of [
      [U.admin, "RED"],
      [U.player, "YELLOW"],
    ] as const) {
      await db.run(
        `INSERT INTO "TeamAssignment" (id, "matchId", "userId", team) VALUES ($1, $2, $3, $4::"Team")`,
        [`e2e-ta-formnote-${userId}`, MATCH.upcoming, userId, team],
      );
    }
    engineOn({ [TIRED]: FORM_ROUTING });
    const id = msgId();
    const res = await postAnalyze(request, [
      { waMessageId: id, body: TIRED, authorPhone: PHONE.admin, authorName: NAME.admin, botMentioned: true },
    ]);
    expect(resultFor(res, id).reply).toBe(
      "Noted. The teams for this match are already made, so I'll take it into account if they are made again.",
    );
    expect(await teamRows(db)).toBe(2);
  });
});

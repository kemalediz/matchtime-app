/**
 * A PLAYER ANSWERS THE ROSTER CHECK-IN: LIVE-LLM, END TO END (2026-10-19).
 *
 * "Evet bu ay varım" (yes, I'm in this month) was read as `maybe` on Haiku
 * 5.5, and so was "yes I'm in this month": the old prompt treated a yes
 * for a stated stretch as a hedge. `scripts/dryrun-roster-survey.ts`
 * measures the classifier on its own; this drives the REAL model through
 * the REAL /api/whatsapp/dm-reply route, with an open check-in seeded for
 * Tom Third. No stub.
 *
 * Each reply must save `in` and queue the "marked you as in" reply in the
 * club's language. Once each (Kemal's cheap test plan). Opt-in: only runs
 * when MT_SIM_LIVE_LLM=1, on the developer key.
 *
 *   MT_SIM_LIVE_LLM=1 npx tsx e2e/run.ts sim/roster-survey-live.spec.ts
 */
import { test, expect, resetDb } from "../fixtures";
import type { TestDb } from "../helpers/test-db";
import { U, ORG_ID, PHONE } from "../helpers/constants";
import { E2E } from "../helpers/env";
import { buildRosterSurveyConfirmation } from "../../src/lib/dm-copy";

const LIVE = process.env.MT_SIM_LIVE_LLM === "1";
const SURVEY = "e2e-roster-survey-live";

async function openCheckIn(db: TestDb, lang: "en" | "tr") {
  await db.run(`UPDATE "Organisation" SET language = $1 WHERE id = $2`, [lang, ORG_ID]);
  await db.run(
    `INSERT INTO "RosterSurvey" (id, "orgId", "sentByUserId", status, "createdAt", "updatedAt")
     VALUES ($1, $2, $3, 'open', now(), now())`,
    [SURVEY, ORG_ID, U.admin],
  );
  await db.run(
    `INSERT INTO "RosterSurveyDM" (id, "surveyId", "userId", "sentAt", "createdAt")
     VALUES ($1, $2, $3, now(), now())`,
    [`${SURVEY}-dm`, SURVEY, U.third],
  );
}

(LIVE ? test.describe : test.describe.skip)("roster check-in LIVE (real Anthropic model)", () => {
  test.describe.configure({ mode: "serial" });
  test.beforeEach(resetDb);

  for (const [lang, body] of [
    ["tr", "Evet bu ay varım"],
    ["en", "yes I'm in this month"],
  ] as const) {
    test(`${lang}: ${JSON.stringify(body)} keeps the player on the roster`, async ({ request, db }) => {
      await openCheckIn(db, lang);
      const res = await request.post("/api/whatsapp/dm-reply", {
        headers: { "x-api-key": E2E.WHATSAPP_API_KEY },
        data: { phone: PHONE.third, body, waMessageId: `live-roster-${lang}-${Date.now()}`, authorName: null },
      });
      expect(res.status(), await res.text()).toBe(200);
      const json = await res.json();
      console.log(`[roster-live] ${lang} ${JSON.stringify(body)} → ${JSON.stringify(json)}`);
      expect(json).toMatchObject({ action: "recorded", category: "in" });

      const saved = await db.one<{ response: string; rawReply: string }>(
        `SELECT response, "rawReply" FROM "RosterSurveyResponse" WHERE "surveyId" = $1 AND "userId" = $2`,
        [SURVEY, U.third],
      );
      expect(saved).toEqual({ response: "in", rawReply: body });

      const replies = await db.all<{ text: string }>(
        `SELECT text FROM "BotJob" WHERE kind = 'dm' AND phone = $1`,
        [PHONE.third.replace(/^\+/, "")],
      );
      expect(replies.map((r) => r.text)).toContain(
        buildRosterSurveyConfirmation({ category: "in", firstName: "Tom", lang }),
      );
    });
  }
});

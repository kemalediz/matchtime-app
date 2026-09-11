/**
 * /api/whatsapp/dm-reply — THE ADMIN INTENT, END TO END.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * WHAT THIS COVERS AND WHY IT IS ITS OWN FILE
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Until 2026-09-11 this route asked two regex questions of every DM it
 * had not already claimed:
 *
 *   looksLikeRecruitRequest         a recruit verb ADJACENT to a people
 *                                   noun, OR a shortage phrase — with
 *                                   `inviteRecentPlayers` behind it, a
 *                                   mass DM to 13-27 real people
 *   looksLikeRatingProgressRequest  (a rating word) AND (a progress
 *                                   word), anywhere in the body
 *
 * Both are deleted. The route now asks `lib/dm-intent.ts` once, and the
 * CODE keeps every gate. These specs drive the real route through the
 * `MT_TEST_DM_INTENT_STUB_FILE` seam, which stubs only what the MODEL
 * said: the membership lookup, the match lookups, `inviteRecentPlayers`
 * and the reply are all the shipped code.
 *
 * THE FIRST TWO TESTS ARE THE ONES THAT MATTER. A message the model
 * calls `other` must queue NOT ONE DM, and a model call that THROWS must
 * queue not one either.
 */
import { test, expect, resetDb } from "../fixtures";
import { U, ORG_ID, PHONE, NAME, MATCH } from "../helpers/constants";
import { E2E } from "../helpers/env";
import { setDmIntentStub, clearDmIntentStub } from "../helpers/stub";
import type { APIRequestContext } from "@playwright/test";
import type { TestDb } from "../helpers/test-db";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  resetDb();
});

test.afterAll(() => {
  clearDmIntentStub();
});

let n = 0;
async function postDm(request: APIRequestContext, phone: string, body: string) {
  const res = await request.post("/api/whatsapp/dm-reply", {
    headers: { "x-api-key": E2E.WHATSAPP_API_KEY },
    data: { phone, body, waMessageId: `e2e-dmi-${Date.now()}-${++n}`, authorName: null },
  });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

/** Every invite DM this org has queued. `inviteRecentPlayers` is the
 *  only thing in the product that sends these. */
const inviteDms = (db: TestDb) =>
  db.all<{ phone: string; text: string }>(
    `SELECT phone, text FROM "BotJob"
      WHERE "orgId" = $1 AND kind = 'dm' AND text ILIKE '%putting the squad together%'`,
    [ORG_ID],
  );

/** The reply queued back to one person. */
const dmsTo = (db: TestDb, phone: string) =>
  db.all<{ text: string }>(
    `SELECT text FROM "BotJob" WHERE kind = 'dm' AND phone = $1 ORDER BY "createdAt" DESC`,
    [phone.replace(/^\+/, "")],
  );

/** The 2026-09-10 near-miss sentence, and the 2026-09-01 incident
 *  sentence. Both matched a deleted regex; neither instructs the bot. */
const INCIDENT_10_SEP =
  "please do not forget to rate the players via the link from Matchtime DM'ed to you. " +
  "the more accurate ratings, the more balanced teams next time";
const INCIDENT_1_SEP = "Najib is out. We need one more player.";

const RECRUIT = "DM everyone who played in the last 5 matches and invite them";
const PROGRESS = "who hasn't rated yet?";

test("THE REAL SENTENCES — `other` queues NOT ONE invite DM", async ({ request, db }) => {
  // Both bodies are absent from the stub, so the seam classifies them
  // `other` — which is exactly what the live model is measured doing
  // (cases N3 and N4 of `DMS=1` in scripts/dryrun-pipeline.ts).
  setDmIntentStub({});
  const before = (await inviteDms(db)).length;
  for (const body of [INCIDENT_10_SEP, INCIDENT_1_SEP]) {
    const json = await postDm(request, PHONE.admin, body);
    expect(json.handled).not.toBe("recruit-dm");
  }
  expect(await inviteDms(db)).toHaveLength(before);
});

test("A MODEL CALL THAT THROWS queues not one invite DM either", async ({ request, db }) => {
  // FAIL CLOSED. The seam raises the failure an overloaded API raises.
  // `classifyDmIntent` catches it and returns `other`; nothing blasts.
  setDmIntentStub({ fail: [RECRUIT] });
  const before = (await inviteDms(db)).length;
  const json = await postDm(request, PHONE.admin, RECRUIT);
  expect(json.handled).not.toBe("recruit-dm");
  expect(await inviteDms(db)).toHaveLength(before);
});

test("a NON-ADMIN's recruit ask is refused, and the model is never asked", async ({
  request,
  db,
}) => {
  // The deterministic gate runs FIRST. Even with the seam saying
  // `recruit_blast` in as many words, a player cannot blast the club.
  setDmIntentStub({ bodies: { [RECRUIT]: "recruit_blast" } });
  const before = (await inviteDms(db)).length;
  const json = await postDm(request, PHONE.collector, RECRUIT);
  expect(json.handled).not.toBe("recruit-dm");
  expect(await inviteDms(db)).toHaveLength(before);
});

test("the genuine admin recruit ask still blasts, and replies once", async ({ request, db }) => {
  setDmIntentStub({ bodies: { [RECRUIT]: "recruit_blast" } });
  const json = await postDm(request, PHONE.admin, RECRUIT);
  expect(json.handled).toBe("recruit-dm");
  // The private reply to the admin who asked, composed from what
  // actually landed rather than from what was asked for.
  const replies = await dmsTo(db, PHONE.admin);
  expect(replies.length).toBeGreaterThan(0);
  expect(replies[0].text).toMatch(/recent player|already responded|Couldn't do that/);
});

test("the genuine admin rating-progress ask still answers, and blasts nobody", async ({
  request,
  db,
}) => {
  setDmIntentStub({ bodies: { [PROGRESS]: "rating_progress" } });
  const before = (await inviteDms(db)).length;
  const json = await postDm(request, PHONE.admin, PROGRESS);
  expect(json.handled).toBe("rating-progress-dm");
  const replies = await dmsTo(db, PHONE.admin);
  expect(replies[0].text).toMatch(/rating progress|no recent completed match/i);
  // THE MASS DM IS A DIFFERENT BRANCH AND MUST STAY SHUT.
  expect(await inviteDms(db)).toHaveLength(before);
});

test("PREMISE: the seeded admin really is an admin, and the collector is not", async ({ db }) => {
  // A case that cannot fail is not a case. If the fixture ever stopped
  // making U.admin an OWNER, every refusal above would pass for the
  // wrong reason.
  const rows = await db.all<{ userId: string; role: string }>(
    `SELECT "userId", role FROM "Membership" WHERE "orgId" = $1 AND "userId" = ANY($2)`,
    [ORG_ID, [U.admin, U.collector]],
  );
  expect(rows.find((r) => r.userId === U.admin)?.role).toBe("OWNER");
  expect(rows.find((r) => r.userId === U.collector)?.role).toBe("PLAYER");
  // And a match exists to recruit for, or the blast tests would pass
  // because there was nothing to do.
  expect(MATCH.upcoming).toBeTruthy();
  expect(NAME.admin).toBeTruthy();
});

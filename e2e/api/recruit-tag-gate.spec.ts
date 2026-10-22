/**
 * A recruit DMs players only with an explicit @ tag OR an attendance change
 * in the same message (Kemal, 2026-10-22), end to end through
 * /api/whatsapp/analyze. No model: the router and the extractor are stubbed.
 *
 * An admin's "we need players" carries the extractor's `recruit` side
 * request, which DMs players from up to five recent matches. Untagged and
 * changing nobody's attendance, it used to fire anyway: "otherwise it DMs
 * people unnecessarily and can create noise". Now:
 *
 *   1. untagged, no attendance change: no recruit DMs, nothing in the group;
 *   2. a swipe-reply to a MatchTime post, no @: the same, no recruit;
 *   3. untagged, but "Jake is out, we need one more": Jake is dropped AND
 *      the recruit fires;
 *   4. "@Match Time we need players" (the Pi's mention signal): fires.
 *
 * Each case runs on its own fresh club, so one case's invites cannot hide
 * another's.
 */
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import type { TestDb } from "../helpers/test-db";
import { facts, otherClaim } from "../helpers/stub";
import { createGroup, type SimGroup } from "../sim/group";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  resetDb();
});

const NEED = facts([], { sideRequests: ["recruit"] });

const freshGroup = async (request: APIRequestContext, db: TestDb): Promise<SimGroup> =>
  (
    await createGroup(request, db, {
      maxPlayers: 6,
      attendance: ["owner", "alice", "pete", "dan", "felix", "jake"].map((key) => ({ key, status: "CONFIRMED" as const })),
      // Last week's players who have not answered: who a recruit DMs.
      completedMatch: { daysAgo: 7, confirmedKeys: ["owner", "alice", "greg", "henry", "ivan"] },
    })
  ).attach(request);

const invites = (grp: SimGroup) =>
  grp.db.count(`SELECT COUNT(*) FROM "SentNotification" WHERE key LIKE $1`, [`${grp.matchId}:recruit-dm:%`]);

test("untagged 'we need players', nobody's attendance changed: no recruit DMs, the group hears nothing", async ({ request, db }) => {
  const grp = await freshGroup(request, db);
  const res = await grp.post("owner", "we need players", { route: "offer", facts: NEED });
  expect(await invites(grp)).toBe(0);
  expect(res.reply ?? null).toBeNull();
});

test("a swipe-reply to a MatchTime post is not the tag a mass DM needs: no recruit", async ({ request, db }) => {
  const grp = await freshGroup(request, db);
  const batch = await grp.postBatch([
    { player: "owner", body: "we need players", route: "offer", facts: NEED, quote: { id: "3EB0MTSQUADPOST", text: "Squad: 6/6", fromMatchTime: true } },
  ]);
  expect(await invites(grp)).toBe(0);
  expect(batch.results[0].reply ?? null).toBeNull();
});

test("untagged, with a drop in the same message: Jake is out AND the recruit fires", async ({ request, db }) => {
  const grp = await freshGroup(request, db);
  const res = await grp.post("owner", "Jake is out, we need one more", {
    route: "other_att",
    facts: facts([otherClaim("Jake Jolly", "out")], { sideRequests: ["recruit"] }),
  });
  expect((await grp.attendanceOf("jake"))?.status).toBe("DROPPED");
  expect(await invites(grp)).toBeGreaterThan(0);
  expect(res.reply).toContain("On it, DM'd");
});

test("an explicit @Match Time tag: the recruit fires with no attendance change", async ({ request, db }) => {
  const grp = await freshGroup(request, db);
  // A real squad gap, so there is somebody to recruit for.
  await grp.setAttendance("jake", "DROPPED");
  await grp.post("owner", "@Match Time we need players", { route: "offer", facts: NEED, botMentioned: true });
  expect(await invites(grp)).toBeGreaterThan(0);
});

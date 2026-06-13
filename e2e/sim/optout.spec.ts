/**
 * Group-simulator scenario matrix — RATING-DM OPT-OUT.
 *
 * "stop messaging me about ratings" must (a) flip the per-club
 * Membership.ratingDmOptOut flag, (b) only ACK after the write landed,
 * and (c) actually silence BOTH scheduler loops — the morning-after
 * rating DM and the evening rating reminder — while everyone else still
 * gets theirs. Re-opt-in restores delivery.
 */
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import { londonAt } from "../helpers/constants";
import type { TestDb } from "../helpers/test-db";
import { createGroup, SimGroup } from "./group";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  resetDb();
});

const KEYS = ["owner", "alice", "pete", "dan", "felix"];

let g: SimGroup;
const group = async (request: APIRequestContext, db: TestDb) =>
  (g ??= await createGroup(request, db, {
    maxPlayers: 10,
    upcomingMatch: false, // keep the scheduler output focused on the rate flow
    completedMatch: {
      daysAgo: 1, // yesterday 20:00 London — rating window open
      confirmedKeys: KEYS,
      redScore: 3,
      yellowScore: 2,
      teams: { owner: "RED", alice: "RED", pete: "RED", dan: "YELLOW", felix: "YELLOW" },
    },
  })).attach(request);

const flag = (grp: SimGroup, key: string) =>
  grp.db.one<{ ratingDmOptOut: boolean; ratingDmOptOutAt: Date | null }>(
    `SELECT "ratingDmOptOut", "ratingDmOptOutAt" FROM "Membership" WHERE "userId" = $1 AND "orgId" = $2`,
    [grp.player(key).userId, grp.orgId],
  );

test('"stop messaging me about ratings" → flag set, ack only after the write', async ({ request, db }) => {
  const grp = await group(request, db);
  const r = await grp.dm("pete", "stop messaging me about ratings please");
  expect(r.json.handled).toBe("rating-dm-opt-out");
  expect(r.json.optOut).toBe(true);

  const m = await flag(grp, "pete");
  expect(m?.ratingDmOptOut).toBe(true);
  expect(m?.ratingDmOptOutAt).not.toBeNull();

  const petePhone = grp.player("pete").phone!.replace(/^\+/, "");
  expect(r.dms.some((d) => d.phone === petePhone && /no more rating/i.test(d.text))).toBe(true);
});

test("morning-after rate DMs skip the opted-out player, everyone else gets theirs", async ({ request, db }) => {
  const grp = await group(request, db);
  const instructions = await grp.duePosts(londonAt(0, 8, 30));
  const keys = instructions.map((i) => i.key);
  for (const k of ["owner", "alice", "dan", "felix"]) {
    expect(keys).toContain(`${grp.completedMatchId}:rate-dm:${grp.player(k).userId}`);
  }
  expect(keys).not.toContain(`${grp.completedMatchId}:rate-dm:${grp.player("pete").userId}`);
});

test("evening rating REMINDERS skip the opted-out player AND anyone who already rated", async ({ request, db }) => {
  const grp = await group(request, db);
  // Simulate the bot having ACK'd everyone's morning DM.
  for (const k of KEYS) {
    const uid = grp.player(k).userId;
    await grp.db.run(
      `INSERT INTO "SentNotification" (id, key, kind, "matchId", "targetUser")
       VALUES ($1, $2, 'rate-dm', $3, $4) ON CONFLICT (key) DO NOTHING`,
      [`sim-sn-rate-${uid}`, `${grp.completedMatchId}:rate-dm:${uid}`, grp.completedMatchId, uid],
    );
  }
  // Dan already rated a teammate.
  await grp.db.run(
    `INSERT INTO "Rating" (id, "matchId", "raterId", "playerId", score) VALUES ($1, $2, $3, $4, 8)`,
    [`sim-rating-dan`, grp.completedMatchId, grp.player("dan").userId, grp.player("owner").userId],
  );

  const instructions = await grp.duePosts(londonAt(0, 18, 30));
  const reminderTargets = instructions
    .filter((i) => i.key?.includes(":rate-reminder:"))
    .map((i) => i.targetUser);
  expect(reminderTargets).toContain(grp.player("owner").userId);
  expect(reminderTargets).toContain(grp.player("felix").userId);
  expect(reminderTargets).not.toContain(grp.player("pete").userId); // opted out
  expect(reminderTargets).not.toContain(grp.player("dan").userId); // already rated
});

test('"start ratings" re-opt-in clears the flag', async ({ request, db }) => {
  const grp = await group(request, db);
  const r = await grp.dm("pete", "start ratings again please");
  expect(r.json.handled).toBe("rating-dm-opt-out");
  expect(r.json.optOut).toBe(false);
  const m = await flag(grp, "pete");
  expect(m?.ratingDmOptOut).toBe(false);
  expect(m?.ratingDmOptOutAt).toBeNull();
});

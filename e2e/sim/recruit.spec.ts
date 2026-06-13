/**
 * Group-simulator scenario matrix — RECRUIT.
 *
 * The "DM recent players" blast must fire ONLY on an explicit shortage /
 * recruit request from an ADMIN, and only when the upcoming match has
 * open slots. Roster questions ("list the players") must never trigger
 * it, a full squad must DM nobody, and the blast is idempotent per match.
 */
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import type { TestDb } from "../helpers/test-db";
import { createGroup, SimGroup } from "./group";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  resetDb();
});

let g: SimGroup;
const group = async (request: APIRequestContext, db: TestDb) =>
  (g ??= await createGroup(request, db, {
    maxPlayers: 8,
    // Upcoming: only the two admins have responded.
    attendance: [
      { key: "owner", status: "CONFIRMED" },
      { key: "alice", status: "CONFIRMED" },
    ],
    // Last week's match: pete/dan/felix played (have phones, no response
    // to the upcoming match yet) and gary played but has NO phone.
    completedMatch: {
      daysAgo: 7,
      confirmedKeys: ["owner", "alice", "pete", "dan", "felix", "gary"],
    },
  })).attach(request);

const recruitDms = (grp: SimGroup) =>
  grp.db.all<{ phone: string | null; text: string }>(
    `SELECT phone, text FROM "BotJob" WHERE "orgId" = $1 AND kind = 'dm' AND text LIKE '%grab a spot%'`,
    [grp.orgId],
  );

test("explicit shortage from an admin → invite DMs to recent non-responders with phones", async ({ request, db }) => {
  const grp = await group(request, db);
  const r = await grp.post("owner", "lads we need a few more players for tuesday");
  expect(r.handledBy).toBe("fast-path");
  expect(r.intent).toBe("recruit_recent");
  expect(r.react).toBe("✅");
  expect(r.reply).toContain("DM'd 3 recent players");

  const dms = await recruitDms(grp);
  expect(dms).toHaveLength(3);
  const phones = dms.map((d) => d.phone).sort();
  const expected = ["pete", "dan", "felix"].map((k) => grp.player(k).phone!.replace(/^\+/, "")).sort();
  expect(phones).toEqual(expected);
  for (const d of dms) {
    expect(d.text).toContain("putting the squad together");
    expect(d.text).toMatch(/https?:\/\//); // RSVP magic link
  }
  // Idempotency breadcrumbs, one per invited player.
  for (const k of ["pete", "dan", "felix"]) {
    const key = `${grp.matchId}:recruit-dm:${grp.player(k).userId}`;
    expect(
      await grp.db.count(`SELECT COUNT(*) FROM "SentNotification" WHERE key = $1`, [key]),
    ).toBe(1);
  }
});

test("repeating the request never re-DMs the same players for the same match", async ({ request, db }) => {
  const grp = await group(request, db);
  const before = (await recruitDms(grp)).length;
  const r = await grp.post("owner", "still need more players lads");
  expect(r.intent).toBe("recruit_recent");
  expect(r.reply).toContain("already responded"); // nobody NEW to invite
  expect((await recruitDms(grp)).length).toBe(before);
});

test('"list the players" is a roster question — NEVER a recruit blast', async ({ request, db }) => {
  const grp = await group(request, db);
  const before = (await recruitDms(grp)).length;
  const r = await grp.post("owner", "can you list the players for tuesday?", {
    verdict: {
      intent: "question",
      reply: "Here's the squad so far: 2/8 confirmed.",
      react: null,
      confidence: 0.95,
      reasoning: "stub: roster answer",
    },
  });
  expect(r.intent).not.toBe("recruit_recent");
  expect(r.handledBy).toBe("llm");
  expect((await recruitDms(grp)).length).toBe(before);
});

test("a non-admin asking to recruit is refused with 🔒 and DMs nobody", async ({ request, db }) => {
  const grp = await group(request, db);
  const before = (await recruitDms(grp)).length;
  const r = await grp.post("pete", "get more players in for tuesday");
  expect(r.intent).toBe("recruit_denied");
  expect(r.react).toBe("🔒");
  expect(r.reply).toBeNull();
  expect((await recruitDms(grp)).length).toBe(before);
});

test("full squad → recruit DMs nobody and says so", async ({ request, db }) => {
  const grp = await group(request, db);
  // Top the squad up to 8/8 directly (setup shortcut, not via the bot).
  for (const k of ["pete", "dan", "felix", "greg", "henry", "ivan"]) {
    await grp.setAttendance(k, "CONFIRMED");
  }
  expect((await grp.counts()).confirmed).toBe(8);

  const before = (await recruitDms(grp)).length;
  const r = await grp.post("alice", "anyone free? we need players");
  expect(r.intent).toBe("recruit_recent");
  expect(r.reply).toContain("already full");
  expect((await recruitDms(grp)).length).toBe(before);
});

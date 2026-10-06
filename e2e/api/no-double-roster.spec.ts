/**
 * The same squad is not posted twice (2026-10-06), end to end through
 * /api/whatsapp/analyze and /api/whatsapp/due-posts. No model: the router
 * and the extractor are stubbed, and with no API key the scheduler's
 * chases use their fixed text.
 *
 * THE INCIDENT (Sutton FC, Tue 6 Oct 2026, match day):
 *   07:28  an admin: "@David is out due to minor injury ... Can we have
 *          more players please". MatchTime replied with the squad
 *          (13/14, need 1 more) and "On it, DM'd 8 recent players".
 *   08:00  the match-day morning chase asked for the same 1 player and
 *          listed the same thirteen names.
 *
 * The scheduler only remembers what is in `SentNotification`, and the
 * analyze reply left nothing there. It now leaves two markers
 * (`src/lib/roster-shown.ts`), and this spec walks the real path:
 *
 *   1. the reply writes a `roster-shown` and a `recruit-ack` marker;
 *   2. the 08:00 poll that follows does not send the morning chase, and
 *      sends it once the need has changed;
 *   3. a scheduled post leaves out the roster the group has just seen,
 *      and carries it again once the squad is a different one;
 *   4. a scheduled post that does carry the roster leaves its own marker
 *      when it is handed out, and the Pi never sees the bookkeeping.
 *
 * The composed (model-written) chase is covered with the composer mocked
 * in `src/lib/__tests__/no-double-roster-scheduler.test.ts`.
 */
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import type { TestDb } from "../helpers/test-db";
import { londonAt } from "../helpers/constants";
import { facts, otherClaim } from "../helpers/stub";
import { createGroup, SimGroup } from "../sim/group";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  resetDb();
});

const MIN = 60 * 1000;
/** The fixture match is in two days, 20:00 London. */
const MATCH_DAY_0728 = londonAt(2, 7, 28);
const MATCH_DAY_0800 = londonAt(2, 8, 0);
const MATCH_DAY_0825 = londonAt(2, 8, 25);
const DAY_BEFORE_1630 = londonAt(1, 16, 30);
const DAY_BEFORE_1705 = londonAt(1, 17, 5);

const BODY = "@Jake is out due to minor injury from yesterday's match. Can we have more players please";

let g: SimGroup;
const group = async (request: APIRequestContext, db: TestDb) =>
  (g ??= await createGroup(request, db, {
    maxPlayers: 6,
    attendance: ["owner", "alice", "pete", "dan", "felix", "jake"].map((key) => ({ key, status: "CONFIRMED" as const })),
    // Last week's players who have not answered for this match: the
    // people the recruit DMs go to.
    completedMatch: { daysAgo: 7, confirmedKeys: ["owner", "alice", "greg", "henry", "ivan"] },
  })).attach(request);

interface Marker {
  key: string;
  kind: string;
}
const markers = (grp: SimGroup) =>
  grp.db.all<Marker>(
    `SELECT key, kind FROM "SentNotification"
     WHERE "matchId" = $1 AND kind IN ('roster-shown', 'recruit-ack') ORDER BY "createdAt"`,
    [grp.matchId],
  );

/** The analyze route has no test clock, so the markers it wrote carry the
 *  real time. Put them where the scenario says they happened. The column
 *  is a UTC timestamp without a zone, so the instant is passed as ISO
 *  text and converted in SQL: a JS Date parameter would be written in
 *  the machine's local time, an hour out during BST. */
const markersHappenedAt = (grp: SimGroup, at: Date) =>
  grp.db.run(
    `UPDATE "SentNotification" SET "createdAt" = ($1::timestamptz AT TIME ZONE 'UTC')
     WHERE "matchId" = $2 AND kind IN ('roster-shown', 'recruit-ack')`,
    [at.toISOString(), grp.matchId],
  );

const morningChase = (posts: Array<{ key?: string; text?: string }>) =>
  posts.find((p) => p.key?.includes(":chase-match-day-morning:"));
const eveningPost = (posts: Array<{ key?: string; text?: string }>) =>
  posts.find((p) => p.key?.includes(":evening-update:"));

test("the reply to 'X is out, can we have more players' posts the squad and the recruit ack, and remembers both", async ({
  request,
  db,
}) => {
  const grp = await group(request, db);
  const res = await grp.post("owner", BODY, {
    route: "other_att",
    facts: facts([otherClaim("Jake Jolly", "out")], { sideRequests: ["recruit"] }),
  });

  expect((await grp.attendanceOf("jake"))?.status).toBe("DROPPED");
  // One reply: the squad from the database, then the recruit line. No
  // em dash in either (Kemal's rule).
  expect(res.reply).toContain("here's the latest squad: *5/6*, need *1 more* 🙏");
  expect(res.reply).toContain("1. Oscar Owner");
  expect(res.reply).toContain("6. 🥁");
  expect(res.reply).toContain("📣 On it, DM'd 3 recent players who hadn't replied");
  expect(res.reply).not.toMatch(/[—–]/);

  const rows = await markers(grp);
  expect(rows.filter((r) => r.kind === "roster-shown")).toHaveLength(1);
  const acks = rows.filter((r) => r.kind === "recruit-ack");
  expect(acks).toHaveLength(1);
  // The need the group was told about: 1 open place.
  expect(acks[0].key.startsWith(`${grp.matchId}:recruit-ack:1:`)).toBe(true);
});

test("THE INCIDENT: 32 minutes later the 08:00 poll does not send the morning chase", async ({ request, db }) => {
  const grp = await group(request, db);
  await markersHappenedAt(grp, MATCH_DAY_0728);

  expect(morningChase(await grp.duePosts(MATCH_DAY_0800))).toBeUndefined();
  // Not claimed: the key is free for a later poll in the same window.
  expect(
    await grp.db.count(`SELECT COUNT(*) FROM "SentNotification" WHERE key LIKE $1`, [
      `${grp.matchId}:chase-match-day-morning:%`,
    ]),
  ).toBe(0);
});

test("it comes back later in the window once the need has changed", async ({ request, db }) => {
  const grp = await group(request, db);
  await markersHappenedAt(grp, MATCH_DAY_0728);
  // Another player drops at 08:20: two places open, the ack was for one.
  await grp.setAttendance("felix", "DROPPED");
  try {
    const chase = morningChase(await grp.duePosts(MATCH_DAY_0825));
    expect(chase, "need changed from 1 to 2").toBeDefined();
    expect(chase!.text).toContain("*2 short*");
  } finally {
    await grp.setAttendance("felix", "CONFIRMED");
  }
});

test("without the recruit ack the morning chase goes out as it always did", async ({ request, db }) => {
  const grp = await group(request, db);
  // More than three hours before 08:00: both markers are stale.
  await markersHappenedAt(grp, new Date(MATCH_DAY_0800.getTime() - 181 * MIN));
  expect(morningChase(await grp.duePosts(MATCH_DAY_0800))).toBeDefined();
});

test("a scheduled post leaves out the roster the group has just seen, and keeps its other lines", async ({
  request,
  db,
}) => {
  const grp = await group(request, db);
  await markersHappenedAt(grp, DAY_BEFORE_1630);

  const post = eveningPost(await grp.duePosts(DAY_BEFORE_1705));
  expect(post, "the 17:00 post still goes out").toBeDefined();
  expect(post!.text).toContain("need *1 more*");
  expect(post!.text).not.toContain("*Confirmed (");
  expect(post!.text).not.toMatch(/^\s*\d+\.\s/m);
});

test("a different squad is a different roster: it is listed, recorded when handed out, and the Pi sees no bookkeeping", async ({
  request,
  db,
}) => {
  const grp = await group(request, db);
  await markersHappenedAt(grp, DAY_BEFORE_1630);
  // Felix drops after the 16:30 roster: the group has not seen this squad.
  await grp.setAttendance("felix", "DROPPED");
  const before = (await markers(grp)).filter((r) => r.kind === "roster-shown").map((r) => r.key);

  const post = eveningPost(await grp.duePosts(DAY_BEFORE_1705, { claim: true })) as
    | { text?: string; rosterShown?: unknown }
    | undefined;
  expect(post).toBeDefined();
  expect(post!.text).toContain("need *2 more*");
  expect(post!.text).toContain("*Confirmed (4/6):*\n1. Oscar Owner");
  expect(post!.rosterShown, "server-side only").toBeUndefined();

  const after = (await markers(grp)).filter((r) => r.kind === "roster-shown").map((r) => r.key);
  expect(after).toHaveLength(before.length + 1);
  const added = after.find((k) => !before.includes(k))!;
  // A different squad, so a different fingerprint from the 16:30 one.
  expect(added.split(":").at(-2)).not.toBe(before[0].split(":").at(-2));
});

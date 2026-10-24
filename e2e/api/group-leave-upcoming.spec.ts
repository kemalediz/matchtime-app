/**
 * A PLAYER WHO LEAVES THE WHATSAPP GROUP IS TAKEN OFF THE UPCOMING MATCH
 * (2026-10-24).
 *
 * Same bug class as FNF's "Glazers" (removed on the players page with his
 * bench row left, printed as "a player"): `group-leave` set
 * `Membership.leftAt` and left his rows on matches still to come. Now it
 * takes him off them through `cancelAttendance` (cause "member-removed",
 * actor system). His past matches keep their rows. No model is called.
 */
import { test, expect, resetDb } from "../fixtures";
import { MATCH, ORG_ID, PHONE, U } from "../helpers/constants";
import { E2E } from "../helpers/env";

test.describe.configure({ mode: "serial" });

const KEY = { "x-api-key": E2E.WHATSAPP_API_KEY };

test.beforeAll(() => resetDb());
test.afterAll(() => resetDb());

test("Ben leaves the group: off the upcoming bench, past rows untouched", async ({ request, db }) => {
  const past = async () =>
    (await db.all<{ matchId: string; status: string }>(
      `SELECT a."matchId", a.status FROM "Attendance" a JOIN "Match" m ON m.id = a."matchId" WHERE a."userId" = $1 AND m.id <> $2 ORDER BY a."matchId"`,
      [U.bench, MATCH.upcoming],
    )) ?? [];
  const before = await past();
  expect((await db.one<{ status: string }>(`SELECT status FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`, [MATCH.upcoming, U.bench]))?.status).toBe("BENCH");

  const res = await request.post("/api/whatsapp/group-leave", { headers: KEY, data: { groupId: E2E.GROUP_ID, phones: [PHONE.bench] } });
  expect(res.status(), await res.text()).toBe(200);

  expect((await db.one<{ leftAt: Date | null }>(`SELECT "leftAt" FROM "Membership" WHERE "userId" = $1 AND "orgId" = $2`, [U.bench, ORG_ID]))?.leftAt).not.toBeNull();
  expect((await db.one<{ status: string }>(`SELECT status FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`, [MATCH.upcoming, U.bench]))?.status).toBe("DROPPED");
  const ev = await db.one<{ cause: string; actorKind: string; sourceRef: string }>(
    `SELECT cause, "actorKind", "sourceRef" FROM "AttendanceEvent" WHERE "matchId" = $1 AND "userId" = $2 ORDER BY at DESC LIMIT 1`,
    [MATCH.upcoming, U.bench],
  );
  expect(ev).toEqual({ cause: "member-removed", actorKind: "system", sourceRef: "whatsapp:group-leave" });
  expect(await past()).toEqual(before);
});

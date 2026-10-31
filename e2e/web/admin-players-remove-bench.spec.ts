/**
 * A PROVISIONAL PLAYER REMOVED ON THE PLAYERS PAGE IS TAKEN OFF THE
 * UPCOMING MATCH (FNF, 2026-10-24).
 *
 * Prod: an HQ "Glazers in" created a phoneless provisional "Glazers" and
 * put him on the bench of Fri 30 Oct. An admin then removed him on
 * /admin/players. The removal set `Membership.leftAt` and left his BENCH
 * row, so the next squad post read "Bench (1): 1. a player".
 *
 * Here, the same shapes: a phoneless provisional member on the seeded
 * upcoming match's bench. The admin clicks Remove (the real page and
 * server action); then a player asks "who's playing?" (router and question
 * extractor stubbed; the route, load-state and composer are the real
 * code). No model is called.
 *
 *   1. his row is DROPPED with a "member-removed" event by the admin;
 *   2. nothing is sent to anyone for the removal itself;
 *   3. the squad answer lists neither him nor "a player".
 */
import { test, expect, postAnalyze, resetDb, signInAs, U } from "../fixtures";
import { MATCH, ORG_ID } from "../helpers/constants";
import { clearPipelineStubs, engineOn } from "../helpers/stub";

test.describe.configure({ mode: "serial" });

const GLAZERS = "e2e-rm-glazers";
const WHO = "who's playing?";
type Result = { waMessageId: string; reply?: string | null };

const question = (topic: string) => ({
  topic,
  personRef: "",
  statedCount: -1,
  table: "none",
  listSize: -1,
  listEnd: "top",
  period: "none",
  periodCount: -1,
  periodUnit: "none",
  feature: "none",
});

test.beforeAll(async ({ db }) => {
  resetDb();
  await db.run(
    `INSERT INTO "User" (id,name,email,"phoneNumber",onboarded,"isActive","updatedAt") VALUES ($1,'Glazers',$2,NULL,false,true,now())`,
    [GLAZERS, `manual-${GLAZERS}@placeholder.matchtime`],
  );
  await db.run(
    `INSERT INTO "Membership" (id,"userId","orgId",role,"provisionallyAddedAt","createdAt") VALUES ('e2e-rm-m1',$1,$2,'PLAYER',now(),now())`,
    [GLAZERS, ORG_ID],
  );
  await db.run(`INSERT INTO "Attendance" (id,"matchId","userId",status,position,"updatedAt") VALUES ('e2e-rm-a1',$1,$2,'BENCH',90,now())`, [
    MATCH.upcoming,
    GLAZERS,
  ]);
});

test.afterAll(() => {
  clearPipelineStubs();
  resetDb();
});

test("removing a provisional player on the bench takes him off the match, quietly", async ({ page, db }) => {
  const jobsBefore = (await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM "BotJob"`))!.n;
  page.on("dialog", (d) => d.accept());
  await signInAs(page, U.admin, "/admin/players");
  const row = page.getByTestId(`player-row-${GLAZERS}`);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.getByRole("button", { name: "Remove" }).click();
  await expect(page.getByText("Player removed")).toBeVisible();

  await expect
    .poll(async () => (await db.one<{ status: string }>(`SELECT status FROM "Attendance" WHERE id = 'e2e-rm-a1'`))?.status)
    .toBe("DROPPED");
  const ev = await db.one<{ cause: string; actorKind: string; actorUserId: string; fromStatus: string; toStatus: string }>(
    `SELECT cause, "actorKind", "actorUserId", "fromStatus", "toStatus" FROM "AttendanceEvent" WHERE "matchId" = $1 AND "userId" = $2 ORDER BY at DESC LIMIT 1`,
    [MATCH.upcoming, GLAZERS],
  );
  expect(ev).toMatchObject({ cause: "member-removed", actorKind: "admin", actorUserId: U.admin, fromStatus: "BENCH", toStatus: "DROPPED" });
  const left = await db.one<{ leftAt: Date | null }>(`SELECT "leftAt" FROM "Membership" WHERE id = 'e2e-rm-m1'`);
  expect(left?.leftAt).not.toBeNull();
  // A bench place freed nothing: nobody is told anything for the removal.
  expect((await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM "BotJob"`))!.n).toBe(jobsBefore);
});

test("the next squad answer lists neither him nor 'a player'", async ({ request }) => {
  engineOn({ [WHO]: { route: "question", facts: question("squad") } });
  const id = `e2e-rm-${Date.now()}`;
  const res = await postAnalyze(request, [
    // Tagged: since #487 an untagged question is silent.
    { waMessageId: id, body: WHO, authorPhone: "447700900003", authorName: "Pat Player", quotedBody: "Who's in?", quotedFromMatchTime: true, botMentioned: true },
  ]);
  const r = (res.results as Result[]).find((x) => x.waMessageId === id)!;
  const reply = r.reply ?? "";
  expect(reply, JSON.stringify(res.results)).toContain("Ben Bench");
  expect(reply).not.toContain("Glazers");
  expect(reply).not.toContain("a player");
});

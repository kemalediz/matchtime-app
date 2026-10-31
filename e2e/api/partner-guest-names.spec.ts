/**
 * PARTNER GUESTS ON THE SQUAD ANSWER, END TO END (MT Test, 2026-10-22).
 *
 * Prod: two partner guests from Friday MT Community volunteered for MT
 * Test's Wed 28 Oct match. Asked for the squad, MatchTime listed them as
 * "6. C1" and "7. (unnamed)": C2's `User.name` is NULL and the answer never
 * said which club either came from. The cross-club plan (D7): a guest is
 * shown by name and club, never a phone number.
 *
 * Here the seeded club is the ASKING club. Two guests from a partner club,
 * in the prod shapes (a guest Membership with `guestFromOrgId`, one with an
 * EMPTY User.name), then "who's playing?". The router and the question
 * extractor are stubbed (what the model would say); the route, the
 * composer and the name lookup are the real code. No model is called.
 */
import { test, expect, postAnalyze, resetDb, signInAs } from "../fixtures";
import { MATCH, ORG_ID, U } from "../helpers/constants";
import { engineOn, clearPipelineStubs } from "../helpers/stub";

test.describe.configure({ mode: "serial" });

const PARTNER = "e2e-gn-partner";
const C1 = "e2e-gn-c1";
const C2 = "e2e-gn-c2";
const WHO = "who's playing?";
const CLUB = "Friday Partners";

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

let n = 0;
const msgId = () => `e2e-gn-${Date.now()}-${++n}`;
type Result = { waMessageId: string; reply?: string | null };

test.beforeAll(async ({ db }) => {
  resetDb();
  await db.run(
    `INSERT INTO "Organisation" (id,name,slug,"inviteCode","approvalStatus","createdAt","updatedAt")
     VALUES ($1,$2,$1,$3,'approved',now(),now())`,
    [PARTNER, CLUB, `${PARTNER}-invite`],
  );
  // C1 named, C2 with an EMPTY name: the prod rows.
  await db.run(
    `INSERT INTO "User" (id,name,email,"phoneNumber","isActive","updatedAt") VALUES
       ($1,'C1',$3,'+447700900771',true,now()),
       ($2,NULL,$4,'+447700900772',true,now())`,
    [C1, C2, `wa-sync+${C1}@matchtime.local`, `wa-sync+${C2}@matchtime.local`],
  );
  for (const u of [C1, C2]) {
    await db.run(`INSERT INTO "Membership" (id,"userId","orgId",role,"createdAt") VALUES ($1,$2,$3,'PLAYER',now())`, [`${u}-home`, u, PARTNER]);
    await db.run(
      `INSERT INTO "Membership" (id,"userId","orgId",role,"guestFromOrgId","guestMatchId","createdAt") VALUES ($1,$2,$3,'PLAYER',$4,$5,now())`,
      [`${u}-guest`, u, ORG_ID, PARTNER, MATCH.upcoming],
    );
  }
  // C1 takes the last place; C2 joins Ben on the bench.
  await db.run(
    `INSERT INTO "Attendance" (id,"matchId","userId",status,position,"updatedAt") VALUES
       ('e2e-gn-a1',$1,$2,'CONFIRMED',50,now()),
       ('e2e-gn-a2',$1,$3,'BENCH',60,now())`,
    [MATCH.upcoming, C1, C2],
  );
});

test.afterAll(() => {
  clearPipelineStubs();
  resetDb();
});

test("the squad answer names each guest with his club, the nameless one too, and never a phone number", async ({ request }) => {
  engineOn({ [WHO]: { route: "question", facts: question("squad") } });
  const id = msgId();
  const res = await postAnalyze(request, [
    { waMessageId: id, body: WHO, authorPhone: "447700900003", authorName: "Pat Player", botMentioned: true, quotedBody: "Who's in?", quotedFromMatchTime: true },
  ]);
  const r = (res.results as Result[]).find((x) => x.waMessageId === id)!;
  const reply = r.reply ?? "";
  expect(reply, JSON.stringify(res.results)).toContain(`C1 (${CLUB})`);
  expect(reply).toContain(`(unnamed) (${CLUB})`);
  // A member of the club is printed plainly.
  expect(reply).toContain("Ben Bench");
  expect(reply).not.toContain("Ben Bench (");
  expect(reply).not.toMatch(/4477009007\d\d/);
});

test("the admin match page reads the same names", async ({ page }) => {
  await signInAs(page, U.admin);
  const res = await page.request.get(`/api/matches/${MATCH.upcoming}`);
  expect(res.status(), await res.text()).toBe(200);
  const body = (await res.json()) as { attendances: Array<{ userId: string; user: { name: string | null } }> };
  const nameOf = (id: string) => body.attendances.find((a) => a.userId === id)?.user.name;
  expect(nameOf(C1)).toBe(`C1 (${CLUB})`);
  expect(nameOf(C2)).toBe(`(unnamed) (${CLUB})`);
  expect(JSON.stringify(body.attendances)).not.toMatch(/4477009007\d\d/);
});

test("once the home club names him, every surface shows the name", async ({ request, db }) => {
  await db.run(`UPDATE "User" SET name = 'Cem Two' WHERE id = $1`, [C2]);
  engineOn({ [WHO]: { route: "question", facts: question("squad") } });
  const id = msgId();
  const res = await postAnalyze(request, [
    { waMessageId: id, body: WHO, authorPhone: "447700900003", authorName: "Pat Player", botMentioned: true, quotedBody: "Who's in?", quotedFromMatchTime: true },
  ]);
  const reply = (res.results as Result[]).find((x) => x.waMessageId === id)!.reply ?? "";
  expect(reply).toContain(`Cem Two (${CLUB})`);
  expect(reply).not.toContain("(unnamed)");
});

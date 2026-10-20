/**
 * "IS THERE STILL SPACE?" IN A CLUB WHOSE ORGANISERS ANNOUNCE THE LIST,
 * END TO END (FNF players' group, 2026-10-20 12:47 UTC).
 *
 * MatchTime had posted the organiser-requested call-out "We need 3 more
 * players for Fri 20:30. Say IN if you can make it and the organisers will
 * confirm who gets the places." Clarence swipe-replied "Is there still
 * space?" and was told "The organisers will post the list.": the count
 * answer was composed, then the organisers-mode net replaced it because it
 * carried a squad count. The organisers keep the LIST, not whether there is
 * room, so:
 *
 *   1. a space question is answered with the number of open places and
 *      how to ask for one, never a name (EN, and TR);
 *   2. a full squad says so and how to go on the bench;
 *   3. "who's playing?" still gets "The organisers will post the list."
 *
 * The router and the question extractor are stubbed (what the model would
 * say); the ownership, the composer and both nets in the analyze route are
 * the real code. The seed's upcoming match is 4 of 5 with Ben on the bench.
 */
import { test, expect, postAnalyze, resetDb } from "../fixtures";
import { MATCH, ORG_ID, U } from "../helpers/constants";
import { engineOn, clearPipelineStubs } from "../helpers/stub";

test.describe.configure({ mode: "serial" });

const CALL_OUT =
  "We need 1 more player for Fri 20:30. Say *IN* if you can make it and the organisers will confirm who gets the place.";
const SPACE = "Is there still space?";
const SPACE_TR = "Hala yer var mı?";
const WHO = "who's playing?";

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
const msgId = () => `e2e-oa-space-${Date.now()}-${++n}`;

type Result = { waMessageId: string; reply?: string | null; react?: string | null; handledBy?: string; intent?: string | null };

async function ask(request: Parameters<typeof postAnalyze>[0], body: string): Promise<Result> {
  const id = msgId();
  const res = await postAnalyze(request, [
    // A swipe-reply to MatchTime's call-out: the reply itself is the address.
    { waMessageId: id, body, authorPhone: "447700900009", authorName: "Ian Innes", quotedBody: CALL_OUT, quotedFromMatchTime: true },
  ]);
  return (res.results as Result[]).find((x) => x.waMessageId === id)!;
}

test.beforeEach(async ({ db }) => {
  resetDb();
  // FNF's settings: the organisers announce the list and pick who plays.
  await db.run(`UPDATE "Organisation" SET "listAnnouncer" = 'organisers', "benchPickMode" = 'organiser' WHERE id = $1`, [ORG_ID]);
});

test.afterAll(() => {
  clearPipelineStubs();
  resetDb();
});

test("a space question is answered with the open places and how to ask for one, never names", async ({ request }) => {
  engineOn({ [SPACE]: { route: "question", facts: question("count") } });
  const r = await ask(request, SPACE);
  expect(r.handledBy).toBe("llm");
  expect(r.reply).toMatch(
    /^There's 1 place left for \S.*\. Say \*IN\* if you can make it and the organisers will confirm who gets the place\.$/,
  );
  expect(r.reply).not.toContain("The organisers will post the list.");
  expect(r.reply).not.toContain("Ben");
  expect(r.reply).not.toMatch(/[—–]/);
});

test("the same question in a Turkish club is answered in Turkish", async ({ request, db }) => {
  await db.run(`UPDATE "Organisation" SET language = 'tr' WHERE id = $1`, [ORG_ID]);
  engineOn({ [SPACE_TR]: { route: "question", facts: question("count") } });
  const r = await ask(request, SPACE_TR);
  expect(r.reply).toMatch(/^\S.* maçı için 1 yer boş\. Gelebiliyorsanız \*VARIM\* yazın, yeri kimin alacağını organizatörler onaylayacak\.$/);
  expect(r.reply).not.toContain("Listeyi organizatörler paylaşacak.");
});

test("a full squad says so and how to go on the bench, still without names", async ({ request, db }) => {
  await db.run(
    `INSERT INTO "Attendance" (id, "matchId", "userId", status, position, "updatedAt")
     VALUES ('e2e-oa-space-fill', $1, $2, 'CONFIRMED', 99, now())`,
    [MATCH.upcoming, U.extra],
  );
  engineOn({ [SPACE]: { route: "question", facts: question("count") } });
  const r = await ask(request, SPACE);
  expect(r.reply).toMatch(/^The squad is full for \S.*\. Say \*IN\* to go on the bench and the organisers will pick who plays\.$/);
  expect(r.reply).not.toContain("Ben");
});

test("who's playing still gets 'The organisers will post the list.'", async ({ request }) => {
  engineOn({ [WHO]: { route: "question", facts: question("squad") } });
  const r = await ask(request, WHO);
  expect(r.reply).toBe("The organisers will post the list.");
});

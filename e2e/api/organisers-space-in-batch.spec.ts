/**
 * "IS THERE STILL SPACE?" IN THE SAME BATCH AS AN IN, IN A CLUB WHOSE
 * ORGANISERS ANNOUNCE THE LIST (follow-up to #346, 2026-10-20).
 *
 * When a count question shares a batch with a squad change, the engine
 * folds the question into ONE batch-final squad post (S36). In organisers
 * mode the composer never posts that squad post, so the folded question
 * was answered by nothing at all. It must still get the space answer
 * (open places or "full, go on the bench"), never a name; the IN still
 * gets its reaction.
 *
 * The non-organisers mode keeps its one squad post that answers both.
 *
 * The router and the extractors are stubbed (what the model would say);
 * the engine, the composer and the analyze route are the real code. The
 * seed's upcoming match is 4 of 5 with Ben on the bench, and Ian Innes is
 * a member with no row yet.
 */
import { test, expect, postAnalyze, resetDb } from "../fixtures";
import { MATCH, ORG_ID, U } from "../helpers/constants";
import { engineOn, clearPipelineStubs, selfIn } from "../helpers/stub";

test.describe.configure({ mode: "serial" });

const CALL_OUT =
  "We need 1 more player for Fri 20:30. Say *IN* if you can make it and the organisers will confirm who gets the place.";
const IN = "IN";
const SPACE = "Is there still space?";
const SPACE_TR = "Hala yer var mı?";

const countQuestion = {
  topic: "count",
  personRef: "",
  statedCount: -1,
  table: "none",
  listSize: -1,
  listEnd: "top",
  period: "none",
  periodCount: -1,
  periodUnit: "none",
  feature: "none",
};

let n = 0;
const msgId = () => `e2e-oa-batch-${Date.now()}-${++n}`;

type Result = { waMessageId: string; reply?: string | null; react?: string | null; intent?: string | null };

const IAN = { authorPhone: "447700900009", authorName: "Ian Innes" };
const PAT = { authorPhone: "447700900003", authorName: "Pat Player" };

async function batch(
  request: Parameters<typeof postAnalyze>[0],
  inFrom: { authorPhone: string; authorName: string },
  askFrom: { authorPhone: string; authorName: string },
  spaceBody = SPACE,
) {
  const inId = msgId();
  const askId = msgId();
  const res = await postAnalyze(request, [
    { waMessageId: inId, body: IN, ...inFrom },
    // A tagged reply to MatchTime's call-out (an answer needs the real tag
    // since 2026-10-31; the reply alone is silent).
    { waMessageId: askId, body: spaceBody, ...askFrom, botMentioned: true, quotedBody: CALL_OUT, quotedFromMatchTime: true },
  ]);
  const results = res.results as Result[];
  return {
    results,
    inR: results.find((x) => x.waMessageId === inId)!,
    askR: results.find((x) => x.waMessageId === askId)!,
  };
}

async function statusOf(db: { all: <T>(q: string, p: unknown[]) => Promise<T[]> }, userId: string) {
  const rows = await db.all<{ status: string }>(
    `SELECT status FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`,
    [MATCH.upcoming, userId],
  );
  return rows[0]?.status ?? null;
}

const arm = (spaceBody = SPACE) =>
  engineOn({
    [IN]: { route: "self_att", facts: selfIn() },
    [spaceBody]: { route: "question", facts: countQuestion },
  });

const FULL_FIRST_COME = /^The squad is full for \S.*\. Say \*IN\* to go on the bench\.$/;
const ONE_LEFT_ORGANISER_PICK =
  /^There's 1 place left for \S.*\. Say \*IN\* if you can make it and the organisers will confirm who gets the place\.$/;

const noNamesNoRoster = (results: Result[]) => {
  for (const r of results) {
    const t = r.reply ?? "";
    for (const nm of ["Ben", "Ian", "Pat", "Alex", "Colin"]) expect(t).not.toContain(nm);
    expect(t).not.toContain("*Playing:*");
    expect(t).not.toContain("The organisers will post the list.");
    expect(t).not.toMatch(/[—–]/);
  }
};

test.afterAll(() => {
  clearPipelineStubs();
  resetDb();
});

test.describe("organisers announce the list, first come first served", () => {
  test.beforeEach(async ({ db }) => {
    resetDb();
    await db.run(`UPDATE "Organisation" SET "listAnnouncer" = 'organisers' WHERE id = $1`, [ORG_ID]);
  });

  test("player A says IN (fills the last place), player B asks for space: A gets the react, B the space answer", async ({ request, db }) => {
    arm();
    const { inR, askR, results } = await batch(request, IAN, PAT);
    expect(inR.react).toBe("✅");
    expect(inR.reply ?? null).toBeNull();
    expect(await statusOf(db, U.fresh)).toBe("CONFIRMED");
    // The answer is read AFTER Ian's write landed: 5 of 5, full.
    expect(askR.intent).toBe("organisers_space");
    expect(askR.reply).toMatch(FULL_FIRST_COME);
    expect(results.filter((r) => (r.reply ?? "").length > 0)).toHaveLength(1);
    noNamesNoRoster(results);
  });

  test("the same player sends both: the react and the space answer", async ({ request }) => {
    arm();
    const { inR, askR, results } = await batch(request, IAN, IAN);
    expect(inR.react).toBe("✅");
    expect(askR.reply).toMatch(FULL_FIRST_COME);
    noNamesNoRoster(results);
  });

  test("in Turkish", async ({ request, db }) => {
    await db.run(`UPDATE "Organisation" SET language = 'tr' WHERE id = $1`, [ORG_ID]);
    arm(SPACE_TR);
    const { inR, askR, results } = await batch(request, IAN, PAT, SPACE_TR);
    expect(inR.react).toBe("✅");
    expect(askR.reply).toMatch(/^\S.* maçı için kadro dolu\./);
    expect(askR.reply).not.toContain("Listeyi organizatörler paylaşacak.");
    noNamesNoRoster(results);
  });
});

test.describe("organisers announce the list and pick who plays (FNF)", () => {
  test.beforeEach(async ({ db }) => {
    resetDb();
    await db.run(`UPDATE "Organisation" SET "listAnnouncer" = 'organisers', "benchPickMode" = 'organiser' WHERE id = $1`, [ORG_ID]);
  });

  test("the IN goes on the bench for the organisers to pick, so one place is still open", async ({ request, db }) => {
    arm();
    const { inR, askR, results } = await batch(request, IAN, PAT);
    expect(inR.react).toBe("🪑");
    expect(await statusOf(db, U.fresh)).toBe("BENCH");
    expect(askR.reply).toMatch(ONE_LEFT_ORGANISER_PICK);
    noNamesNoRoster(results);
  });
});

test.describe("MatchTime announces the list (unchanged)", () => {
  test.beforeEach(() => resetDb());

  test("the IN gets its react and the question its own count answer", async ({ request }) => {
    arm();
    const { inR, askR, results } = await batch(request, IAN, PAT);
    expect(inR.react).toBe("✅");
    const spoke = results.map((r) => r.reply ?? "").filter((t) => t.length > 0);
    expect(spoke, JSON.stringify(spoke)).toHaveLength(1);
    expect(askR.reply).toContain("5/5");
  });
});

/**
 * A WHATSAPP REPLY TO MATCHTIME'S OWN MESSAGE, END TO END (2026-10-16, FNF;
 * the answer half changed 2026-10-31).
 *
 * MatchTime posted "Football 9-a-side is full at 18 of 18, but the bench is
 * open. Say IN to go on the bench..." and a player replied to THAT message
 * "Bench? We do bench now?".
 *
 *   1. Since 2026-10-31 (Kemal: in the players' group MatchTime answers only
 *      on a real tag, the rule HQ got in #482) the reply alone is SILENT: no
 *      answer, no "tag me" line, nothing written;
 *   2. the same reply WITH the tag is answered with the bench explainer for
 *      this club's settings (FNF's: the organisers pick), and nothing is
 *      written;
 *   3. the same words quoting ANOTHER PLAYER stay unanswered;
 *   4. "IN" quoting MatchTime's post is attendance, as an IN always was.
 *
 * The router and the question extractor are stubbed (what the model would
 * say); the tag, the ownership, the help copy and the organisers-mode net
 * are the real code.
 */
import { test, expect, postAnalyze, resetDb } from "../fixtures";
import { MATCH, ORG_ID, U } from "../helpers/constants";
import { engineOn, clearPipelineStubs, selfIn } from "../helpers/stub";
import type { TestDb } from "../helpers/test-db";

test.describe.configure({ mode: "serial" });

const BENCH_POST =
  "*Football 9-a-side* is full at 18 of 18, but the bench is open. Say *IN* to go on the bench, and the organisers will pick who plays. 🙏";
const ASK = "Bench? We do bench now?";

/** The question extractor's raw answer for a how-it-works question. */
const howItWorks = (feature: string) => ({
  topic: "how_it_works",
  personRef: "",
  statedCount: -1,
  table: "none",
  listSize: -1,
  listEnd: "top",
  period: "none",
  periodCount: -1,
  periodUnit: "none",
  feature,
});

let n = 0;
const msgId = () => `e2e-reply-mt-${Date.now()}-${++n}`;

type Result = { waMessageId: string; reply?: string | null; react?: string | null; handledBy?: string; intent?: string | null };

const statusOf = async (db: TestDb, userId: string) =>
  (await db.one<{ status: string }>(`SELECT status FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`, [MATCH.upcoming, userId]))?.status;

test.beforeAll(async ({ db }) => {
  resetDb();
  // FNF's settings: the organisers announce and pick who fills a place.
  await db.run(`UPDATE "Organisation" SET "listAnnouncer" = 'organisers', "benchPickMode" = 'organiser' WHERE id = $1`, [ORG_ID]);
});

test.afterAll(() => {
  clearPipelineStubs();
  resetDb();
});

test("a reply to MatchTime's bench post WITHOUT the tag is silent, and writes nothing", async ({ request, db }) => {
  engineOn({ [ASK]: { route: "question", facts: howItWorks("availability") } });
  const id = msgId();
  const res = await postAnalyze(request, [
    { waMessageId: id, body: ASK, authorPhone: "447700900009", authorName: "Ian Innes", quotedBody: BENCH_POST, quotedFromMatchTime: true },
  ]);
  const r = (res.results as Result[]).find((x) => x.waMessageId === id)!;
  expect(r.reply ?? null).toBeNull();
  expect(r.react ?? null).toBeNull();
  expect(await statusOf(db, U.fresh)).toBeUndefined();
});

test("a TAGGED reply to MatchTime's bench post is answered with how the bench works here, and writes nothing", async ({ request, db }) => {
  engineOn({ [ASK]: { route: "question", facts: howItWorks("availability") } });
  const id = msgId();
  const res = await postAnalyze(request, [
    { waMessageId: id, body: ASK, authorPhone: "447700900009", authorName: "Ian Innes", botMentioned: true, quotedBody: BENCH_POST, quotedFromMatchTime: true },
  ]);
  const r = (res.results as Result[]).find((x) => x.waMessageId === id)!;
  expect(r.handledBy).toBe("llm");
  expect(r.intent).toBe("help");
  expect(r.reply).toContain("⚽ *Squad & availability: how it works*");
  expect(r.reply).toContain("When the squad is full, say *In* to go on the bench. When a place opens, the organisers pick who plays.");
  // Not replaced by the organisers-mode net, and not turned into a roster.
  expect(r.reply).not.toContain("The organisers will post the list.");
  expect(r.reply).not.toMatch(/[—–]/);
  // A question about the bench is not a request to go on it.
  expect(await statusOf(db, U.fresh)).toBeUndefined();
});

test("the same words replying to ANOTHER PLAYER stay unanswered", async ({ request, db }) => {
  engineOn({ [ASK]: { route: "question", facts: howItWorks("availability") } });
  const id = msgId();
  const res = await postAnalyze(request, [
    { waMessageId: id, body: ASK, authorPhone: "447700900009", authorName: "Ian Innes", quotedBody: "lads are we doing bench this week?", quotedFromMatchTime: false },
  ]);
  const r = (res.results as Result[]).find((x) => x.waMessageId === id)!;
  expect(r.reply ?? null).toBeNull();
  expect(r.react ?? null).toBeNull();
  expect(await statusOf(db, U.fresh)).toBeUndefined();
});

test("'IN' replying to MatchTime's bench post is attendance, exactly as an IN always was", async ({ request, db }) => {
  engineOn({ IN: { route: "self_att", facts: selfIn() } });
  // The control: a plain IN, no reply, from another new player.
  const plainId = msgId();
  const plain = await postAnalyze(request, [{ waMessageId: plainId, body: "IN", authorPhone: "447700900010", authorName: "Zara Zest" }]);
  const p = (plain.results as Result[]).find((x) => x.waMessageId === plainId)!;
  const id = msgId();
  const res = await postAnalyze(request, [
    { waMessageId: id, body: "IN", authorPhone: "447700900009", authorName: "Ian Innes", quotedBody: BENCH_POST, quotedFromMatchTime: true },
  ]);
  const r = (res.results as Result[]).find((x) => x.waMessageId === id)!;
  // Organiser pick: an IN goes on the bench, with or without the reply.
  expect(await statusOf(db, U.extra)).toBe("BENCH");
  expect(await statusOf(db, U.fresh)).toBe("BENCH");
  expect({ handledBy: r.handledBy, intent: r.intent, react: r.react }).toEqual({ handledBy: p.handledBy, intent: p.intent, react: p.react });
  expect(r.reply ?? "").not.toContain("how it works");
});

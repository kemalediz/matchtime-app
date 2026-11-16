/**
 * A QUESTION IN THE SAME BATCH AS A SQUAD CHANGE: THE BATCH'S SQUAD POST IS
 * NEVER SWALLOWED (PR #604, 2026-11-15/16).
 *
 * Found by this spec (item 5 of the #595 review): with UNIFIED_ANSWERS on,
 * "Ian Innes is in" (from an admin) beside "@Match Time who's on the bench?"
 * lost the squad post. The route put the `[SQUAD]` marker on the LAST reply
 * that speaks, the unified answer; the squad composition skips that intent;
 * and the last-line strip removed the unrendered marker (traced with a
 * temporary log, 2026-11-15). The same happened beside any reply the
 * composition skips (the open answer, help, stats answers, ...).
 *
 * Fixed (`squad-post-carrier.ts`): the marker goes on the last speaking reply
 * the composition renders, else on the message that changed the squad. So
 * the batch sends ONE squad post on the IN and the question's own answer
 * beside it, never two squad posts.
 *
 * The router, the extractors and the answers are STUBBED by message body
 * (`engineOn`); the engine, the batch, the composer and the analyze route are
 * the real code against a real Postgres. No model call, $0. The seed's
 * upcoming match is 4 of 5 with Ben Bench on the bench; Ian Innes is a member
 * with no row yet. Made-up people.
 *
 * The batch that has a squad post is one whose change moves someone else's
 * row ("Ian Innes is in", from Alex Admin): a plain self IN posts no squad
 * (the roster post is demand driven, engine.ts 2026-09-09).
 */
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import { MATCH, U } from "../helpers/constants";
import { E2E } from "../helpers/env";
import { engineOn, clearPipelineStubs, helpFacts, otherFacts, selfIn } from "../helpers/stub";

test.describe.configure({ mode: "serial" });

const FLAG = "x-mt-test-unified-answers";
const IN = "IN";
const BENCH_Q = "@Match Time who's on the bench?";
const BENCH_ANSWER = "Ben Bench is on the bench.";
const ADD_IAN = "Ian Innes is in";
const ALEX = { authorPhone: "447700900001", authorName: "Alex Admin" };
const IAN = { authorPhone: "447700900009", authorName: "Ian Innes" };
const PAT = { authorPhone: "447700900003", authorName: "Pat Player" };
const OPEN_Q = "@Match Time is it cold tonight?";
const OPEN_ANSWER = "I can't see the weather from here.";
const HELP_Q = "@Match Time help";
const BENCH_POST = "*Bench (1):*\n1. Ben Bench";

type Result = { waMessageId: string; reply?: string | null; react?: string | null; intent?: string | null };

let n = 0;
const msgId = () => `e2e-unified-batch-${Date.now()}-${++n}`;

async function batch(
  request: APIRequestContext,
  unified: boolean,
  first: { body: string; authorPhone: string; authorName: string } = { body: IN, ...IAN },
  question = BENCH_Q,
) {
  const inId = msgId();
  const askId = msgId();
  const res = await request.post("/api/whatsapp/analyze", {
    headers: { "x-api-key": E2E.WHATSAPP_API_KEY, [FLAG]: unified ? "1" : "0" },
    data: {
      groupId: E2E.GROUP_ID,
      messages: [
        { waMessageId: inId, ...first, botMentioned: false, timestamp: new Date().toISOString() },
        { waMessageId: askId, body: question, ...PAT, botMentioned: true, timestamp: new Date().toISOString() },
      ],
    },
  });
  expect(res.status(), await res.text()).toBe(200);
  const results = (await res.json()).results as Result[];
  const spoke = results.filter((r) => (r.reply ?? "").length > 0);
  return { results, spoke, inR: results.find((r) => r.waMessageId === inId)!, askR: results.find((r) => r.waMessageId === askId)! };
}

const arm = () =>
  engineOn({
    [IN]: { route: "self_att", facts: selfIn() },
    [ADD_IAN]: { route: "other_att", facts: otherFacts("Ian Innes", "in") },
    // Both extractor shapes: the old one reads `topic`, the unified one `kind`.
    [BENCH_Q]: {
      route: "question",
      facts: { topic: "bench", kind: "other", personRef: "", statedCount: -1, table: "none", listSize: -1, listEnd: "top", period: "none", periodCount: -1, periodUnit: "none", feature: "none", badge: "none", answer: BENCH_ANSWER },
    },
    [OPEN_Q]: {
      route: "question",
      facts: { topic: "other", kind: "other", personRef: "", statedCount: -1, table: "none", listSize: -1, listEnd: "top", period: "none", periodCount: -1, periodUnit: "none", feature: "none", badge: "none", answer: OPEN_ANSWER },
    },
    [HELP_Q]: { route: "question", facts: helpFacts() },
  });

/** Every send that is a squad post. */
const squadPosts = (spoke: Result[]) => spoke.filter((r) => (r.reply ?? "").includes("*Playing:*"));

async function statusOf(db: { all: <T>(q: string, p: unknown[]) => Promise<T[]> }, userId: string) {
  const rows = await db.all<{ status: string }>(`SELECT status FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`, [MATCH.upcoming, userId]);
  return rows[0]?.status ?? null;
}

test.afterAll(() => {
  clearPipelineStubs();
  resetDb();
});

test.beforeEach(() => resetDb());

test("flag OFF: the bench question waits, and the batch's ONE squad post (naming the bench) answers it", async ({ request, db }) => {
  arm();
  const { spoke, askR, inR } = await batch(request, false, { body: ADD_IAN, ...ALEX });
  expect(await statusOf(db, U.fresh)).toBe("CONFIRMED");
  expect(spoke).toHaveLength(1);
  expect(askR.reply ?? null).toBeNull();
  expect(inR.reply).toContain(BENCH_POST);
});

test("flag ON: ONE squad post (on the IN, naming the bench) and the unified answer, never two posts", async ({ request, db }) => {
  arm();
  const { spoke, askR, inR } = await batch(request, true, { body: ADD_IAN, ...ALEX });
  expect(await statusOf(db, U.fresh)).toBe("CONFIRMED");
  expect(squadPosts(spoke)).toHaveLength(1);
  expect(inR.reply).toContain(BENCH_POST);
  expect(inR.reply).toContain("5/5");
  expect(askR.intent).toBe("unified_answer");
  expect(askR.reply).toBe(BENCH_ANSWER);
  // One reply per message, and the unified answer is not repeated.
  expect(spoke).toHaveLength(2);
  expect(spoke.filter((r) => (r.reply ?? "").includes(BENCH_ANSWER))).toHaveLength(1);
});

test("flag ON, a plain IN beside the question (no squad post in this batch either way): ONE send", async ({ request }) => {
  arm();
  const { spoke, askR, inR } = await batch(request, true);
  expect(inR.react).toBe("✅");
  expect(spoke).toHaveLength(1);
  expect(askR.reply).toBe(BENCH_ANSWER);
});

test("flag OFF, the open answer beside the squad change: ONE squad post on the IN, and the open answer", async ({ request }) => {
  arm();
  const { spoke, askR, inR } = await batch(request, false, { body: ADD_IAN, ...ALEX }, OPEN_Q);
  expect(squadPosts(spoke)).toHaveLength(1);
  expect(inR.reply).toContain(BENCH_POST);
  expect(askR.intent).toBe("open_answer");
  expect(askR.reply).toBe(OPEN_ANSWER);
});

test("help beside the squad change: ONE squad post on the IN, and the help untouched", async ({ request }) => {
  arm();
  const { spoke, askR, inR } = await batch(request, false, { body: ADD_IAN, ...ALEX }, HELP_Q);
  expect(squadPosts(spoke)).toHaveLength(1);
  expect(inR.reply).toContain(BENCH_POST);
  expect(askR.intent).toBe("help");
  expect(askR.reply ?? "").not.toContain("*Playing:*");
  expect(askR.reply ?? "").not.toContain("[SQUAD]");
});

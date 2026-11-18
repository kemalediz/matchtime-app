/**
 * A TAGGED QUESTION IN THE SAME BATCH AS A SQUAD CHANGE: THE BATCH'S SQUAD
 * POST IS NEVER LOST (review of #595, 2026-11-15; carried from #604 onto
 * main after #626, 2026-11-18).
 *
 * "Ian Innes is in" (from an admin, so someone else's row moves and the
 * batch has a squad post) beside "@Match Time who's on the bench?" lost the
 * squad post. The route put the `[SQUAD]` marker on the LAST reply that
 * speaks, the unified answer; the squad composition skips that intent; and
 * the last-line strip removed the unrendered marker. The same happened
 * beside help.
 *
 * Fixed (`squad-post-carrier.ts`): the marker goes on the last speaking
 * reply the composition renders, else on the message that changed the
 * squad. ONE squad post and the question's own answer beside it, never two
 * squad posts. A batch with a team post in it is left as it was.
 *
 * The router, the extractors and the answer are STUBBED by message body;
 * the engine, the batch, the composer and the analyze route are the real
 * code against a real Postgres. No model call, $0. The seed's upcoming
 * match is 4 of 5 with Ben Bench on the bench; Ian Innes is a member with
 * no row yet. Made-up people.
 */
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import { MATCH, U } from "../helpers/constants";
import { E2E } from "../helpers/env";
import { engineOn, clearPipelineStubs, helpFacts, otherFacts, selfIn } from "../helpers/stub";

test.describe.configure({ mode: "default" });

const IN = "IN";
const ADD_IAN = "Ian Innes is in";
const BENCH_Q = "@Match Time who's on the bench?";
const BENCH_ANSWER = "Ben Bench is on the bench.";
const HELP_Q = "@Match Time help";
const BENCH_POST = "*Bench (1):*\n1. Ben Bench";
const ALEX = { authorPhone: "447700900001", authorName: "Alex Admin" };
const IAN = { authorPhone: "447700900009", authorName: "Ian Innes" };
const PAT = { authorPhone: "447700900003", authorName: "Pat Player" };

type Result = { waMessageId: string; reply?: string | null; react?: string | null; intent?: string | null };

let n = 0;
const msgId = () => `e2e-ua-squad-${Date.now()}-${++n}`;

async function batch(
  request: APIRequestContext,
  first: { body: string; authorPhone: string; authorName: string },
  question: string,
) {
  const inId = msgId();
  const askId = msgId();
  const res = await request.post("/api/whatsapp/analyze", {
    headers: { "x-api-key": E2E.WHATSAPP_API_KEY },
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
  return { spoke, inR: results.find((r) => r.waMessageId === inId)!, askR: results.find((r) => r.waMessageId === askId)! };
}

const squadPosts = (spoke: Result[]) => spoke.reduce((k, r) => k + ((r.reply ?? "").split("*Playing:*").length - 1), 0);

async function statusOf(db: { all: <T>(q: string, p: unknown[]) => Promise<T[]> }, userId: string) {
  const rows = await db.all<{ status: string }>(`SELECT status FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`, [MATCH.upcoming, userId]);
  return rows[0]?.status ?? null;
}

test.beforeEach(() => {
  resetDb();
  engineOn({
    [IN]: { route: "self_att", facts: selfIn() },
    [ADD_IAN]: { route: "other_att", facts: otherFacts("Ian Innes", "in") },
    [BENCH_Q]: { route: "question", facts: { kind: "other", personRef: "", feature: "none", badge: "none", answer: BENCH_ANSWER } },
    [HELP_Q]: { route: "question", facts: helpFacts() },
  });
});

test.afterAll(() => {
  clearPipelineStubs();
  resetDb();
});

test("the unified answer beside a squad change: ONE squad post on the change, and the answer", async ({ request, db }) => {
  const { spoke, askR, inR } = await batch(request, { body: ADD_IAN, ...ALEX }, BENCH_Q);
  expect(await statusOf(db, U.fresh)).toBe("CONFIRMED");
  expect(inR.reply ?? "").toContain(BENCH_POST);
  expect(inR.reply ?? "").toContain("5/5");
  expect(askR.intent).toBe("unified_answer");
  expect(askR.reply).toBe(BENCH_ANSWER);
  expect(squadPosts(spoke)).toBe(1);
  expect(spoke).toHaveLength(2);
  expect(spoke.some((r) => (r.reply ?? "").includes("[SQUAD]"))).toBe(false);
});

test("help beside a squad change: ONE squad post on the change, and the help untouched", async ({ request }) => {
  const { spoke, askR, inR } = await batch(request, { body: ADD_IAN, ...ALEX }, HELP_Q);
  expect(inR.reply ?? "").toContain(BENCH_POST);
  expect(askR.intent).toBe("help");
  expect(askR.reply ?? "").not.toContain("*Playing:*");
  expect(squadPosts(spoke)).toBe(1);
  expect(spoke.some((r) => (r.reply ?? "").includes("[SQUAD]"))).toBe(false);
});

test("UNCHANGED: a plain self IN beside the question has no squad post: ONE send, the answer", async ({ request }) => {
  const { spoke, askR, inR } = await batch(request, { body: IN, ...IAN }, BENCH_Q);
  expect(inR.react).toBe("✅");
  expect(spoke).toHaveLength(1);
  expect(askR.reply).toBe(BENCH_ANSWER);
});

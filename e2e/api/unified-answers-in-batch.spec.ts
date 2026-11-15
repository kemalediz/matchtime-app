/**
 * "WHO'S ON THE BENCH?" IN THE SAME BATCH AS AN IN, UNDER UNIFIED_ANSWERS
 * (review of #595, 2026-11-15: item 5, PROVE FIRST, NOT FIXED HERE).
 *
 * The question: with the flag on, the question extractor reads "who's on the
 * bench?" as kind `other`, so `WAITS_FOR_THE_SQUAD_POST` (answer-batch.ts),
 * which holds a `bench` question back beside an IN for the batch's squad post
 * to answer, no longer covers it. Does the group then get the answer twice
 * (the unified answer AND the squad post)?
 *
 * The router, the extractors and the unified answer are STUBBED by message
 * body (`engineOn`); the engine, the batch, the composer and the analyze
 * route are the real code against a real Postgres. No model call, $0.
 * The seed's upcoming match is 4 of 5 with Ben Bench on the bench; Ian Innes
 * is a member with no row yet. Made-up people.
 *
 * The batch that has a squad post is one whose change moves someone else's
 * row ("Ian Innes is in", from Alex Admin): a plain self IN posts no squad
 * (the roster post is demand driven, engine.ts 2026-09-09).
 *
 * WHAT THIS PINS (the evidence, as the route behaves on main 51628491):
 *   flag OFF  the question is held back; the IN carries the batch's ONE squad
 *             post, which names the bench. One send.
 *   flag ON   the question is answered by the unified answer, and the batch's
 *             squad post is NOT sent at all: its `[SQUAD]` marker goes on the
 *             LAST reply that speaks (route.ts, "the marker goes on the LAST
 *             result that is already going to speak"), which is the unified
 *             answer; the squad composition skips that intent
 *             (`skipsSquadComposition`, UNIFIED_ANSWER_INTENT); and the
 *             last-line strip removes the unrendered marker. Traced with a
 *             temporary log on 2026-11-15: marker on the question's id,
 *             intent unified_answer, then "stripped unrendered".
 * So NO double reply; a different defect: the squad post is lost. A fix
 * changes the flag ON expectations below on purpose.
 */
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import { MATCH, U } from "../helpers/constants";
import { E2E } from "../helpers/env";
import { engineOn, clearPipelineStubs, otherFacts, selfIn } from "../helpers/stub";

test.describe.configure({ mode: "serial" });

const FLAG = "x-mt-test-unified-answers";
const IN = "IN";
const BENCH_Q = "@Match Time who's on the bench?";
const BENCH_ANSWER = "Ben Bench is on the bench.";
const ADD_IAN = "Ian Innes is in";
const ALEX = { authorPhone: "447700900001", authorName: "Alex Admin" };
const IAN = { authorPhone: "447700900009", authorName: "Ian Innes" };
const PAT = { authorPhone: "447700900003", authorName: "Pat Player" };

type Result = { waMessageId: string; reply?: string | null; react?: string | null; intent?: string | null };

let n = 0;
const msgId = () => `e2e-unified-batch-${Date.now()}-${++n}`;

async function batch(request: APIRequestContext, unified: boolean, first: { body: string; authorPhone: string; authorName: string } = { body: IN, ...IAN }) {
  const inId = msgId();
  const askId = msgId();
  const res = await request.post("/api/whatsapp/analyze", {
    headers: { "x-api-key": E2E.WHATSAPP_API_KEY, [FLAG]: unified ? "1" : "0" },
    data: {
      groupId: E2E.GROUP_ID,
      messages: [
        { waMessageId: inId, ...first, botMentioned: false, timestamp: new Date().toISOString() },
        { waMessageId: askId, body: BENCH_Q, ...PAT, botMentioned: true, timestamp: new Date().toISOString() },
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
  });

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
  expect(inR.reply).toContain("*Bench (1):*\n1. Ben Bench");
});

test("flag ON: ONE send, the unified answer (no double reply), and the batch's squad post is NOT sent", async ({ request, db }) => {
  arm();
  const { spoke, askR, inR } = await batch(request, true, { body: ADD_IAN, ...ALEX });
  expect(await statusOf(db, U.fresh)).toBe("CONFIRMED");
  expect(spoke).toHaveLength(1);
  expect(askR.intent).toBe("unified_answer");
  expect(askR.reply).toBe(BENCH_ANSWER);
  // The post the flag-off batch sends on the IN: its marker rode on the
  // unified answer, which the squad composition skips, and was stripped.
  expect(inR.reply ?? null).toBeNull();
  for (const r of spoke) expect(r.reply).not.toContain("*Playing:*");
});

test("flag ON, a plain IN beside the question (no squad post in this batch either way): ONE send", async ({ request }) => {
  arm();
  const { spoke, askR, inR } = await batch(request, true);
  expect(inR.react).toBe("✅");
  expect(spoke).toHaveLength(1);
  expect(askR.reply).toBe(BENCH_ANSWER);
});

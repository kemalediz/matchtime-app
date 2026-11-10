/**
 * UNIFIED_ANSWERS, END TO END (Kemal, 2026-11-10), switched on per request by
 * the test header (`x-mt-test-unified-answers: 1`, honoured only under
 * MT_TEST_MODE=1). The router, the extractor and the unified answer are
 * STUBBED by message body; everything else is the shipped code against a real
 * Postgres. No model call, $0.
 *
 *   - asking for the list still posts the real squad list, the same post as
 *     with the flag off;
 *   - anything else is ONE unified answer, and the players' group's context
 *     never carries payments while HQ's does;
 *   - with the flag off nothing changes: the open answer, not the unified one.
 */
import { readFileSync } from "node:fs";
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import { ORG_ID, PHONE } from "../helpers/constants";
import { E2E } from "../helpers/env";
import { engineOn, clearPipelineStubs } from "../helpers/stub";

test.describe.configure({ mode: "serial" });

const HQ = "120363777000000054@g.us";
const ADMIN = PHONE.admin.replace(/^\+/, "");
const PLAYER = PHONE.player.replace(/^\+/, "");
const FLAG = "x-mt-test-unified-answers";

const EMPTY = { personRef: "", statedCount: -1, table: "none", listSize: -1, listEnd: "top", period: "none", periodCount: -1, periodUnit: "none", feature: "none", badge: "none" };
const LIST = "@Match Time what's the list?";
const PAID = "@Match Time who hasn't paid?";
const PAID_ANSWER = "I don't share payments in the group.";
const HQ_PAID = "@Match Time who still owes?";
const HQ_PAID_ANSWER = "I can't see any payments recorded.";
const OPEN = "@Match Time is it cold tonight?";
const OPEN_ANSWER = "I can't see the weather from here.";

let n = 0;
type Result = { waMessageId: string; reply?: string | null; intent?: string | null };

async function ask(request: APIRequestContext, body: string, unified: boolean): Promise<Result> {
  const id = `e2e-unified-${Date.now()}-${++n}`;
  const res = await request.post("/api/whatsapp/analyze", {
    headers: { "x-api-key": E2E.WHATSAPP_API_KEY, [FLAG]: unified ? "1" : "0" },
    data: {
      groupId: E2E.GROUP_ID,
      messages: [{ waMessageId: id, body, authorPhone: PLAYER, authorName: "Pat Player", botMentioned: true, timestamp: new Date().toISOString() }],
    },
  });
  expect(res.status(), await res.text()).toBe(200);
  return ((await res.json()).results as Result[]).find((x) => x.waMessageId === id)!;
}

/** The stubbed model calls so far: label and the user turn it was shown. */
function calls(): Array<{ label: string; user: string }> {
  try {
    return readFileSync(`${E2E.EXTRACTOR_STUB_FILE}.calls`, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { label: string; user: string });
  } catch {
    return [];
  }
}

test.beforeAll(async ({ db }) => {
  resetDb();
  await db.run(`UPDATE "Organisation" SET "adminGroupId" = $2, "adminChannelMode" = 'admin-group' WHERE id = $1`, [ORG_ID, HQ]);
  engineOn({
    // Both shapes in one canned reply: the old extractor reads `topic`, the
    // small one `kind`, so the same message can be asked with the flag on and off.
    [LIST]: { route: "question", facts: { ...EMPTY, topic: "squad", kind: "list" } },
    [PAID]: { route: "question", facts: { ...EMPTY, topic: "other", kind: "other", answer: PAID_ANSWER } },
    [HQ_PAID]: { route: "question", facts: { ...EMPTY, topic: "other", kind: "other", answer: HQ_PAID_ANSWER } },
    [OPEN]: { route: "question", facts: { ...EMPTY, topic: "other", kind: "other", answer: OPEN_ANSWER } },
  });
});

test.afterAll(() => {
  clearPipelineStubs();
  resetDb();
});

test("the list is the real squad post, the same with the flag on as off", async ({ request }) => {
  const on = await ask(request, LIST, true);
  const off = await ask(request, LIST, false);
  expect(on.reply).toBeTruthy();
  expect(on.reply).toBe(off.reply);
  const labels = calls().map((c) => c.label);
  expect(labels).toContain("extractor:question-unified");
  expect(labels).not.toContain("unified-answer");
});

test("anything else is one unified answer, and nothing is written", async ({ request, db }) => {
  const before = await db.count(`SELECT count(*)::int AS c FROM "Attendance"`);
  const r = await ask(request, OPEN, true);
  expect(r.reply).toBe(OPEN_ANSWER);
  expect(r.intent).toBe("open_answer");
  expect(await db.count(`SELECT count(*)::int AS c FROM "Attendance"`)).toEqual(before);
  expect(calls().some((c) => c.label === "unified-answer" && c.user.trimEnd().endsWith(OPEN))).toBe(true);
});

test("the players' group: payments are never in the context", async ({ request }) => {
  const r = await ask(request, PAID, true);
  expect(r.reply).toBe(PAID_ANSWER);
  const user = calls().filter((c) => c.label === "unified-answer" && c.user.trimEnd().endsWith(PAID)).pop()!.user;
  expect(user).toMatch(/PAYMENTS: not shared in the players' group/);
  expect(user).not.toMatch(/PAYMENTS for the last match|does not track payments|no settled match/);
});

test("HQ: the organisers' context carries the payments", async ({ request }) => {
  const res = await request.post("/api/whatsapp/admin-group", {
    headers: { "x-api-key": E2E.WHATSAPP_API_KEY, [FLAG]: "1" },
    data: { channel: "admin-group", botMentioned: true, groupId: HQ, messageId: `e2e-unified-hq-${Date.now()}`, text: HQ_PAID, senderPhone: ADMIN, timestamp: String(Math.floor(Date.now() / 1000)) },
  });
  expect(res.status(), await res.text()).toBe(200);
  expect(await res.json()).toMatchObject({ handled: true, outcome: "hq-answered", replyText: HQ_PAID_ANSWER });
  const user = calls().filter((c) => c.label === "unified-answer" && c.user.trimEnd().endsWith(HQ_PAID)).pop()!.user;
  expect(user).toMatch(/organisers' own group \(HQ\)/);
  expect(user).toMatch(/^PAYMENTS/m);
  expect(user).not.toMatch(/not shared in the players' group/);
});

test("with the flag off, an open question still gets the open answer", async ({ request }) => {
  const before = calls().length;
  const r = await ask(request, OPEN, false);
  expect(r.reply).toBe(OPEN_ANSWER);
  const labels = calls().slice(before).map((c) => c.label);
  expect(labels).toContain("extractor:question");
  expect(labels).toContain("open-answer");
  expect(labels).not.toContain("unified-answer");
});

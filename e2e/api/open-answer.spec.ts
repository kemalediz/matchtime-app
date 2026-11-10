/**
 * THE OPEN ANSWER, END TO END (Kemal, 2026-11-10): a tagged question that
 * fits no set answer (question topic `other`) is answered by one grounded
 * model call (`src/lib/pipeline/open-answer.ts`), in the players' group and
 * in the admin group (HQ), through the one answering path.
 *
 * The router, the question extractor and the open answer are STUBBED: the
 * extractor stub answers by message body, so a body's canned JSON carries the
 * extractor's fields and the open answer's `answer` together. Everything else
 * is the shipped code against a real Postgres: ownership, the context built
 * from the real club, the grounding check, the composer and both nets in the
 * analyze route. No model call, $0.
 */
import { test, expect, postAnalyze, resetDb } from "../fixtures";
import { ORG_ID, PHONE } from "../helpers/constants";
import { E2E } from "../helpers/env";
import { engineOn, clearPipelineStubs } from "../helpers/stub";

test.describe.configure({ mode: "serial" });

const KEY = { "x-api-key": E2E.WHATSAPP_API_KEY };
const HQ = "120363777000000053@g.us";
const ADMIN = PHONE.admin.replace(/^\+/, "");
const PLAYER = PHONE.player.replace(/^\+/, "");

const other = (answer?: string) => ({
  route: "question",
  facts: {
    topic: "other",
    personRef: "",
    statedCount: -1,
    table: "none",
    listSize: -1,
    listEnd: "top",
    period: "none",
    periodCount: -1,
    periodUnit: "none",
    feature: "none",
    ...(answer !== undefined ? { answer } : {}),
  },
});

const COLD = "@Match Time is it going to be cold tonight?";
const COLD_ANSWER = "I can't see the weather from here.";
const FAILS = "@Match Time what's the meaning of life?";
const INVENTS = "@Match Time how many goals has Pat scored?";
const HQ_Q = "@Match Time who could come up from the bench?";
const HQ_ANSWER = "A suggestion: Ben Bench is the only one on the bench. It's your call.";

let n = 0;
const msgId = () => `e2e-open-${Date.now()}-${++n}`;
type Result = { waMessageId: string; reply?: string | null; handledBy?: string; intent?: string | null };

async function ask(request: Parameters<typeof postAnalyze>[0], body: string): Promise<Result> {
  const id = msgId();
  const res = await postAnalyze(request, [{ waMessageId: id, body, authorPhone: PLAYER, authorName: "Pat Player", botMentioned: true }]);
  return (res.results as Result[]).find((x) => x.waMessageId === id)!;
}

test.beforeAll(async ({ db }) => {
  resetDb();
  await db.run(`UPDATE "Organisation" SET "adminGroupId" = $2, "adminChannelMode" = 'admin-group' WHERE id = $1`, [ORG_ID, HQ]);
  engineOn({
    [COLD]: other(COLD_ANSWER),
    // No `answer`: the open answer is refused, as a failed call is.
    [FAILS]: other(),
    // A number the club's context does not hold: refused by the grounding check.
    [INVENTS]: other("Pat Player has scored 41 goals."),
    [HQ_Q]: other(HQ_ANSWER),
  });
});

test.afterAll(() => {
  clearPipelineStubs();
  resetDb();
});

test("players' group: an open question is answered, and nothing is written", async ({ request, db }) => {
  const before = await db.count(`SELECT count(*)::int AS c FROM "Attendance"`);
  const r = await ask(request, COLD);
  expect(r.reply).toBe(COLD_ANSWER);
  expect(r.intent).toBe("open_answer");
  const after = await db.count(`SELECT count(*)::int AS c FROM "Attendance"`);
  expect(after).toEqual(before);
});

test("players' group: an answer that cannot be used keeps today's not-understood line", async ({ request }) => {
  for (const body of [FAILS, INVENTS]) {
    const r = await ask(request, body);
    expect(r.reply, body).toBe("I didn't catch what you'd like me to do. Type *@Match Time help* to see what I can do.");
  }
});

test("players' group: untagged chatter is never answered", async ({ request }) => {
  const id = msgId();
  const res = await postAnalyze(request, [{ waMessageId: id, body: COLD, authorPhone: PLAYER, authorName: "Pat Player", botMentioned: false }]);
  const r = (res.results as Result[]).find((x) => x.waMessageId === id);
  expect(r?.reply ?? null).toBeNull();
});

test("HQ: the same open answer, for the organisers", async ({ request }) => {
  const res = await request.post("/api/whatsapp/admin-group", {
    headers: KEY,
    data: { channel: "admin-group", botMentioned: true, groupId: HQ, messageId: `e2e-open-hq-${Date.now()}`, text: HQ_Q, senderPhone: ADMIN, timestamp: String(Math.floor(Date.now() / 1000)) },
  });
  expect(res.status(), await res.text()).toBe(200);
  expect(await res.json()).toMatchObject({ handled: true, outcome: "hq-answered", replyText: HQ_ANSWER });
});

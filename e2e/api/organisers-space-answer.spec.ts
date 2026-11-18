/**
 * "IS THERE STILL SPACE?" IN A CLUB WHOSE ORGANISERS ANNOUNCE THE LIST,
 * END TO END (FNF players' group, 2026-10-20 12:47 UTC; the unified answer's
 * since 2026-11-18).
 *
 * Clarence swipe-replied "Is there still space?" to the organisers' call-out
 * and was told "The organisers will post the list.". The organisers keep the
 * LIST, not whether there is room. The composed space answer that fixed it
 * was deleted with the other question categories: the question is the
 * unified answer's, whose context in this group names nobody in the squad or
 * on the bench, and whose reply the organisers-mode net leaves alone. So:
 *
 *   1. a space question gets the unified answer, never the organisers' line,
 *      and its context holds the counts but no squad or bench names;
 *   2. "who's playing?" (the list) still gets "The organisers will post the
 *      list."
 *
 * The router, the question extractor and the unified answer are stubbed
 * (what the model would say); the ownership, the context, the composer and
 * both nets in the analyze route are the real code. The seed's upcoming
 * match is 4 of 5 with Ben on the bench.
 */
import { readFileSync } from "node:fs";
import { test, expect, postAnalyze, resetDb } from "../fixtures";
import { ORG_ID } from "../helpers/constants";
import { E2E } from "../helpers/env";
import { engineOn, clearPipelineStubs } from "../helpers/stub";

test.describe.configure({ mode: "serial" });

const CALL_OUT =
  "We need 1 more player for Fri 20:30. Say *IN* if you can make it and the organisers will confirm who gets the place.";
const SPACE = "Is there still space?";
const SPACE_ANSWER = "There is still a place open. Say *IN* and the organisers will confirm who gets it.";
const WHO = "who's playing?";

let n = 0;
const msgId = () => `e2e-oa-space-${Date.now()}-${++n}`;

type Result = { waMessageId: string; reply?: string | null; react?: string | null; handledBy?: string; intent?: string | null };

async function ask(request: Parameters<typeof postAnalyze>[0], body: string): Promise<Result> {
  const id = msgId();
  const res = await postAnalyze(request, [
    // A tagged reply to MatchTime's call-out (an answer needs the real tag
    // since 2026-10-31; the reply alone is silent).
    { waMessageId: id, body, authorPhone: "447700900009", authorName: "Ian Innes", botMentioned: true, quotedBody: CALL_OUT, quotedFromMatchTime: true },
  ]);
  return (res.results as Result[]).find((x) => x.waMessageId === id)!;
}

/** The unified answer's turn for this body, as the stub was shown it. */
function turnFor(body: string): string {
  return (
    readFileSync(`${E2E.EXTRACTOR_STUB_FILE}.calls`, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { label: string; user: string })
      .filter((c) => c.label === "unified-answer" && c.user.trimEnd().endsWith(body))
      .pop()?.user ?? ""
  );
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

test("a space question is the unified answer, never the organisers' line, and its context names nobody in the squad", async ({ request }) => {
  engineOn({ [SPACE]: { route: "question", facts: { kind: "other", personRef: "", feature: "none", badge: "none", answer: SPACE_ANSWER } } });
  const r = await ask(request, SPACE);
  expect(r.intent).toBe("unified_answer");
  expect(r.reply).toBe(SPACE_ANSWER);
  const turn = turnFor(SPACE);
  expect(turn).toMatch(/In the squad: 4 of 5\. Places left: 1\./);
  expect(turn).toMatch(/Who is in the squad and who is on the bench is not shared in this group/);
  expect(turn).not.toMatch(/^BENCH \(/m);
});

test("who's playing still gets 'The organisers will post the list.'", async ({ request }) => {
  engineOn({ [WHO]: { route: "question", facts: { kind: "list", personRef: "", feature: "none", badge: "none" } } });
  const r = await ask(request, WHO);
  expect(r.reply).toBe("The organisers will post the list.");
});

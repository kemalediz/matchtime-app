/**
 * IN THE PLAYERS' GROUP, MATCHTIME ANSWERS ONLY ON A REAL TAG (Kemal,
 * 2026-10-31), against a real Postgres and the real analyze route.
 *
 * The same rule HQ got in #482. A question, help or "show the teams" is
 * answered only when the Pi reports a real @-mention of MatchTime
 * (`botMentioned: true`). Each of these is silent, with no "tag me" line:
 *
 *   1. an untagged question, even one the router read as spoken to
 *      MatchTime (`to_bot`);
 *   2. "MatchTime" typed as text, with no mention;
 *   3. a WhatsApp reply to MatchTime's own post, without the tag.
 *
 * Attendance does not change: an untagged IN, an untagged OUT and an
 * untagged friend add are written exactly as before.
 *
 * The router and the extractors are STUBBED (what the model would say);
 * the tag, the ownership and the composer are the shipped code. The seed's
 * upcoming match is 4 of 5: Alex Admin, Colin Collector, Pat Player, Tom
 * Third; Ben Bench on the bench.
 */
import { test, expect, postAnalyze, resetDb } from "../fixtures";
import { MATCH, U } from "../helpers/constants";
import { engineOn, clearPipelineStubs, selfIn, selfOut, otherFacts, helpFacts, teamsFacts } from "../helpers/stub";
import type { TestDb } from "../helpers/test-db";
import type { APIRequestContext } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const COUNT = { topic: "count", personRef: "", statedCount: -1, table: "none", listSize: -1, listEnd: "top", period: "none", periodCount: -1, periodUnit: "none", feature: "none" };
const MT_POST = "Football 5-a-side: 4 of 5. Say *IN* to play. 🙏";

const PAT = { authorPhone: "447700900003", authorName: "Pat Player" };
const IAN = { authorPhone: "447700900009", authorName: "Ian Innes" };

type Result = { waMessageId: string; reply?: string | null; react?: string | null; intent?: string | null; handledBy?: string };

let n = 0;
async function send(request: APIRequestContext, body: string, extra: Record<string, unknown> = {}, who = PAT) {
  const waMessageId = `e2e-pgrt-${Date.now()}-${++n}`;
  const res = await postAnalyze(request, [{ waMessageId, body, ...who, ...extra }]);
  return (res.results as Result[]).find((x) => x.waMessageId === waMessageId)!;
}

const statusOf = async (db: TestDb, userId: string) =>
  (await db.one<{ status: string }>(`SELECT status FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`, [MATCH.upcoming, userId]))?.status ?? null;

const silent = (r: Result) => {
  expect(r.reply ?? null).toBeNull();
  expect(r.react ?? null).toBeNull();
};

test.beforeEach(() => resetDb());
test.afterAll(() => {
  clearPipelineStubs();
  resetDb();
});

test.describe("a question is silent without the real tag", () => {
  test("untagged, even when the router reads it as spoken to MatchTime", async ({ request }) => {
    const ASK = "how many are we?";
    engineOn({ [ASK]: { route: "question", facts: COUNT, toBot: true } });
    silent(await send(request, ASK));
  });

  test("'MatchTime' typed as text, no mention", async ({ request }) => {
    const ASK = "MatchTime how many are we?";
    engineOn({ [ASK]: { route: "question", facts: COUNT, toBot: true } });
    silent(await send(request, ASK));
  });

  test("a WhatsApp reply to MatchTime's post, without the tag", async ({ request }) => {
    const ASK = "how many now?";
    engineOn({ [ASK]: { route: "question", facts: COUNT, toBot: true } });
    silent(await send(request, ASK, { quotedBody: MT_POST, quotedFromMatchTime: true }));
  });

  test("help as a reply to MatchTime, without the tag", async ({ request }) => {
    const ASK = "Bench? We do bench now?";
    engineOn({ [ASK]: { route: "question", facts: helpFacts("availability"), toBot: true } });
    silent(await send(request, ASK, { quotedBody: MT_POST, quotedFromMatchTime: true }));
  });

  test("'teams?' as a reply to MatchTime, without the tag: the teams are not shown", async ({ request }) => {
    const ASK = "teams?";
    engineOn({ [ASK]: { route: "balancer", facts: teamsFacts("show"), toBot: true } });
    silent(await send(request, ASK, { quotedBody: MT_POST, quotedFromMatchTime: true }));
  });
});

test.describe("the real tag is answered", () => {
  test("@Match Time how many are we?", async ({ request }) => {
    const ASK = "@Match Time how many are we?";
    engineOn({ [ASK]: { route: "question", facts: COUNT } });
    const r = await send(request, ASK, { botMentioned: true });
    console.log(`RENDERED (tagged count): ${JSON.stringify(r.reply)}`);
    expect(r.reply).toBeTruthy();
    expect(r.reply).not.toMatch(/[—–]/);
  });

  test("a tagged reply to MatchTime's post is answered too", async ({ request }) => {
    const ASK = "@Match Time how many now?";
    engineOn({ [ASK]: { route: "question", facts: COUNT } });
    const r = await send(request, ASK, { botMentioned: true, quotedBody: MT_POST, quotedFromMatchTime: true });
    expect(r.reply).toBeTruthy();
  });
});

test.describe("attendance needs no tag, as before", () => {
  test("an untagged IN", async ({ request, db }) => {
    engineOn({ IN: { route: "self_att", facts: selfIn() } });
    await send(request, "IN", {}, IAN);
    expect(await statusOf(db, U.fresh)).toBe("CONFIRMED");
  });

  test("an untagged OUT", async ({ request, db }) => {
    engineOn({ "can't make it, out": { route: "self_att", facts: selfOut() } });
    await send(request, "can't make it, out");
    expect(await statusOf(db, U.player)).toBe("DROPPED");
  });

  test("an untagged friend add", async ({ request, db }) => {
    engineOn({ "zara is in as well": { route: "other_att", facts: otherFacts("Zara Zest", "in") } });
    await send(request, "zara is in as well");
    expect(await statusOf(db, U.extra)).not.toBeNull();
  });

  test("an untagged IN as a reply to MatchTime's post", async ({ request, db }) => {
    engineOn({ IN: { route: "self_att", facts: selfIn() } });
    await send(request, "IN", { quotedBody: MT_POST, quotedFromMatchTime: true }, IAN);
    expect(await statusOf(db, U.fresh)).toBe("CONFIRMED");
  });
});

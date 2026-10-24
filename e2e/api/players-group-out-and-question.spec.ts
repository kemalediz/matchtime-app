/**
 * A CHANGE THAT ALSO ASKS MATCHTIME SOMETHING, IN THE PLAYERS' GROUP
 * (#392 follow-up, Kemal 2026-10-24), against a real Postgres and the real
 * analyze route.
 *
 * "@Match Time I'm out, what's the list?": the attendance extractor reads
 * the sender's OUT and a "question" side request. In a club whose list
 * MatchTime announces, the change is made and the list (after it) is the
 * reply, in one message. In a club whose organisers announce the list
 * (FNF), the reply is EXACTLY what it was before #392, which is pinned by
 * sending the same message read with `sideRequests: []` (what the
 * extractor returned then) and comparing the two.
 *
 * The router and both extractors are STUBBED; one body answers both (each
 * reads its own fields). Everything after is the shipped code. The seed's
 * upcoming match is 4 of 5: Alex Admin, Colin Collector, Pat Player, Tom
 * Third; Ben Bench on the bench.
 */
import { test, expect, postAnalyze, resetDb } from "../fixtures";
import { MATCH, ORG_ID, U } from "../helpers/constants";
import { engineOn, clearPipelineStubs, selfOut } from "../helpers/stub";
import type { TestDb } from "../helpers/test-db";
import type { APIRequestContext } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const ASK = "@Match Time I'm out, what's the list?";
const ASK_TR = "@Match Time ben yokum, liste ne?";
const UNTAGGED = "I'm out, what's the list?";

const SQUAD_Q = { topic: "squad", personRef: "", statedCount: -1, table: "none", listSize: -1, listEnd: "top", period: "none", periodCount: -1, periodUnit: "none", feature: "none" };
const outAndAsks = { ...selfOut(), sideRequests: ["question"], ...SQUAD_Q };
/** The same message as the extractor read it before #392. */
const outOnly = { ...selfOut(), ...SQUAD_Q };

const PAT = { authorPhone: "447700900003", authorName: "Pat Player" };

type Result = { waMessageId: string; reply?: string | null; react?: string | null; intent?: string | null; handledBy?: string };

let n = 0;
async function send(request: APIRequestContext, body: string, tagged = true) {
  const waMessageId = `e2e-pgoq-${Date.now()}-${++n}`;
  const res = await postAnalyze(request, [{ waMessageId, body, ...PAT, botMentioned: tagged }]);
  const results = res.results as Result[];
  const r = results.find((x) => x.waMessageId === waMessageId)!;
  return { r, results, spoke: results.filter((x) => (x.reply ?? "").length > 0) };
}

const statusOf = async (db: TestDb, userId: string) =>
  (await db.one<{ status: string }>(`SELECT status FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`, [MATCH.upcoming, userId]))?.status ?? null;

/** What the group sees, without the per-message id. */
const seen = (r: Result) => ({ reply: r.reply ?? null, react: r.react ?? null, intent: r.intent ?? null, handledBy: r.handledBy ?? null });

test.afterAll(() => {
  clearPipelineStubs();
  resetDb();
});

test.describe("MatchTime announces the list", () => {
  test.beforeEach(() => resetDb());

  test("the change, then the list after it, in one reply", async ({ request, db }) => {
    engineOn({ [ASK]: { route: "self_att", facts: outAndAsks } });
    const { r, spoke } = await send(request, ASK);
    console.log(`RENDERED (en): ${JSON.stringify(r.reply)} react=${r.react}`);
    expect(await statusOf(db, U.player)).toBe("DROPPED");
    expect(spoke).toHaveLength(1);
    expect(r.react).toBe("👋");
    expect(r.reply).toMatch(/Alex Admin/);
    expect(r.reply).toMatch(/Tom Third/);
    // The list is the one after the change: Pat is not on it.
    expect(r.reply).not.toMatch(/\d+\. Pat Player/);
    expect(r.reply).not.toContain("[SQUAD]");
    expect(r.reply).not.toMatch(/[—–]/);
  });

  test("before #392's reading, the same OUT said no list (what changed is the answer)", async ({ request, db }) => {
    engineOn({ [ASK]: { route: "self_att", facts: outOnly } });
    const { r } = await send(request, ASK);
    expect(await statusOf(db, U.player)).toBe("DROPPED");
    expect(r.reply ?? "").not.toMatch(/Alex Admin/);
  });

  test("in Turkish", async ({ request, db }) => {
    await db.run(`UPDATE "Organisation" SET language = 'tr' WHERE id = $1`, [ORG_ID]);
    engineOn({ [ASK_TR]: { route: "self_att", facts: outAndAsks } });
    const { r, spoke } = await send(request, ASK_TR);
    console.log(`RENDERED (tr): ${JSON.stringify(r.reply)} react=${r.react}`);
    expect(await statusOf(db, U.player)).toBe("DROPPED");
    expect(spoke).toHaveLength(1);
    expect(r.reply).toMatch(/Alex Admin/);
    expect(r.reply).not.toMatch(/\d+\. Pat Player/);
  });

  test("untagged: the question is not asked of MatchTime, so exactly as before", async ({ request, db }) => {
    engineOn({ [UNTAGGED]: { route: "self_att", facts: outOnly } });
    const before = await send(request, UNTAGGED, false);
    resetDb();
    engineOn({ [UNTAGGED]: { route: "self_att", facts: outAndAsks } });
    const after = await send(request, UNTAGGED, false);
    expect(seen(after.r)).toEqual(seen(before.r));
    expect(await statusOf(db, U.player)).toBe("DROPPED");
  });
});

test.describe("the organisers announce the list (FNF): nothing new", () => {
  const organisers = (db: TestDb) => db.run(`UPDATE "Organisation" SET "listAnnouncer" = 'organisers' WHERE id = $1`, [ORG_ID]);

  test("byte for byte what the same message got before #392", async ({ request, db }) => {
    resetDb();
    await organisers(db);
    engineOn({ [ASK]: { route: "self_att", facts: outOnly } });
    const before = await send(request, ASK);
    const beforeStatus = await statusOf(db, U.player);

    resetDb();
    await organisers(db);
    engineOn({ [ASK]: { route: "self_att", facts: outAndAsks } });
    const after = await send(request, ASK);
    console.log(`RENDERED (organisers): ${JSON.stringify(after.r.reply)} react=${after.r.react}`);

    expect(seen(after.r)).toEqual(seen(before.r));
    expect(after.results.map(seen)).toEqual(before.results.map(seen));
    expect(await statusOf(db, U.player)).toBe(beforeStatus);
    expect(after.r.reply ?? "").not.toMatch(/Alex Admin/);
  });
});

/**
 * A GROUP REPLY CARRIES WHAT IT QUOTES: LIVE-LLM, THE REAL PATH (quoted-
 * reply context, slice S4, 2026-10-20).
 *
 * The real /api/whatsapp/analyze route, the real router and extractors on
 * the dev key, no stub anywhere. Each case once (the cheap plan): a reply
 * resolves to the message it quotes, whoever wrote it, and the write lands
 * on the right person.
 *
 *   - "same" replying to a member's "IN" in the same batch: both are in,
 *     nobody else moves;
 *   - an organiser's "@Match Time he's out" replying to a member's earlier
 *     message (found by its id among the club's analysed messages): that
 *     member is out;
 *   - "IN" replying to an old MatchTime squad post: the sender is in for
 *     the CURRENT match.
 *
 * Opt-in: MT_SIM_LIVE_LLM=1. Default suites skip it.
 *   MT_SIM_LIVE_LLM=1 npx tsx e2e/run.ts sim/group-reply-live.spec.ts
 */
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import type { TestDb } from "../helpers/test-db";
import { createGroup } from "./group";

const LIVE = process.env.MT_SIM_LIVE_LLM === "1";

(LIVE ? test.describe : test.describe.skip)("group replies LIVE (real Anthropic model)", () => {
  test.describe.configure({ mode: "serial" });
  test.beforeAll(resetDb);

  const mkGroup = (request: APIRequestContext, db: TestDb) =>
    createGroup(request, db, {
      maxPlayers: 14,
      attendance: [
        { key: "owner", status: "CONFIRMED" },
        { key: "alice", status: "CONFIRMED" },
        { key: "pete", status: "CONFIRMED" },
        { key: "felix", status: "CONFIRMED" },
      ],
    });

  test(`"same" replying to a member's IN: both are in, nobody else moves`, async ({ request, db }) => {
    test.setTimeout(180_000);
    const grp = (await mkGroup(request, db)).attach(request);
    const before = await grp.counts();
    const r = await grp.postBatch(
      [
        { player: "henry", body: "IN" },
        { player: "dan", body: "same", quote: { of: 0 } },
      ],
      { history: [{ authorName: "Henry Hill", body: "IN" }, { authorName: "Dan Drummer", body: "same" }] },
    );
    // eslint-disable-next-line no-console
    console.log(`[group-reply-live] same: ${JSON.stringify(r.results.map((x) => [x.intent, x.react]))}`);
    expect((await grp.attendanceOf("henry"))?.status).toBe("CONFIRMED");
    expect((await grp.attendanceOf("dan"))?.status, "the replier is in").toBe("CONFIRMED");
    const after = await grp.counts();
    expect(after.confirmed).toBe(before.confirmed + 2);
  });

  test(`an organiser's "@Match Time he's out" replying to a member's earlier message: that member is out`, async ({ request, db }) => {
    test.setTimeout(180_000);
    const grp = (await mkGroup(request, db)).attach(request);
    const first = await grp.postBatch([{ player: "pete", body: "stuck in traffic on the A3, nightmare" }]);
    const quotedId = first.results[0].waMessageId;
    const r = await grp.postBatch(
      [{ player: "owner", body: "@Match Time he's out", tag: true, quote: { id: quotedId, text: "stuck in traffic on the A3, nightmare", fromMatchTime: false } }],
      { history: [{ authorName: "Pete Power", body: "stuck in traffic on the A3, nightmare" }] },
    );
    // eslint-disable-next-line no-console
    console.log(`[group-reply-live] he's out: ${JSON.stringify(r.results.map((x) => [x.intent, x.react, x.reply]))}`);
    expect((await grp.attendanceOf("pete"))?.status, "the quoted member is out").toBe("DROPPED");
    expect((await grp.attendanceOf("owner"))?.status, "the sender keeps their place").toBe("CONFIRMED");
  });

  test(`"IN" replying to an old MatchTime squad post: in for the current match`, async ({ request, db }) => {
    test.setTimeout(180_000);
    const grp = (await mkGroup(request, db)).attach(request);
    const r = await grp.postBatch([
      {
        player: "ivan",
        body: "IN",
        quote: { id: "3EB0OLDSQUAD", text: "📋 *Squad for last Tuesday* (13/14)\n1. Oscar Owner\n2. Alice Admin\n\nNeed 1 more 🙏", fromMatchTime: true },
      },
    ]);
    // eslint-disable-next-line no-console
    console.log(`[group-reply-live] old post: ${JSON.stringify(r.results.map((x) => [x.intent, x.react]))}`);
    expect((await grp.attendanceOf("ivan"))?.status).toBe("CONFIRMED");
  });
});

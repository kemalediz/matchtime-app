/**
 * "IS THERE STILL SPACE?" WHERE THE ORGANISERS ANNOUNCE THE LIST: THE PAID
 * CHECK (FNF players' group, 2026-10-20).
 *
 * The incident, once each in English and Turkish, through the real
 * /api/whatsapp/analyze route and the REAL router and question extractor
 * (no stub): a swipe-reply to MatchTime's organiser call-out asking whether
 * there is still space gets the open places and how to ask for one, never
 * "The organisers will post the list." and never a name.
 *
 * Opt in: MT_SIM_LIVE_LLM=1 (spends ANTHROPIC_API_KEY_DEV). Skipped otherwise.
 *
 *   MT_SIM_LIVE_LLM=1 npx tsx e2e/run.ts sim/organisers-space-live.spec.ts
 *
 * Prints the model calls and cost the club was billed (OrgAiUsage). The
 * seed's upcoming match is 4 of 5 with Ben Bench on the bench.
 */
import { test, expect, postAnalyze, resetDb } from "../fixtures";
import { ORG_ID } from "../helpers/constants";
import type { TestDb } from "../helpers/test-db";

const LIVE = process.env.MT_SIM_LIVE_LLM === "1";

type Result = { waMessageId: string; reply?: string | null; react?: string | null; handledBy?: string; intent?: string | null };

const usage = (db: TestDb) =>
  db.one<{ calls: number; cost: number }>(
    `SELECT coalesce(sum(calls), 0)::int AS calls, coalesce(sum("costUsd"), 0)::float AS cost FROM "OrgAiUsage" WHERE "orgId" = $1`,
    [ORG_ID],
  );

(LIVE ? test.describe : test.describe.skip)("'Is there still space?' where the organisers announce, LIVE (real model)", () => {
  test.describe.configure({ mode: "serial" });
  test.beforeEach(async ({ db }) => {
    resetDb();
    await db.run(`UPDATE "Organisation" SET "listAnnouncer" = 'organisers', "benchPickMode" = 'organiser' WHERE id = $1`, [ORG_ID]);
  });
  test.afterAll(() => resetDb());

  const cases = [
    {
      lang: "en",
      callOut: "We need 1 more player for Fri 20:30. Say *IN* if you can make it and the organisers will confirm who gets the place.",
      body: "Is there still space?",
      expected: /^There's 1 place left for \S.*\. Say \*IN\* if you can make it and the organisers will confirm who gets the place\.$/,
    },
    {
      lang: "tr",
      callOut: "Fri 20:30 maçı için 1 oyuncu daha lazım. Gelebiliyorsanız *VARIM* yazın, yeri kimin alacağını organizatörler onaylayacak.",
      body: "Hala yer var mı?",
      expected: /^\S.* maçı için 1 yer boş\. Gelebiliyorsanız \*VARIM\* yazın, yeri kimin alacağını organizatörler onaylayacak\.$/,
    },
  ];

  for (const c of cases) {
    test(`${c.lang}: "${c.body}" replying to the call-out gets the open places, no names`, async ({ request, db }) => {
      test.setTimeout(180_000);
      await db.run(`UPDATE "Organisation" SET language = $2 WHERE id = $1`, [ORG_ID, c.lang]);
      const id = `e2e-live-oa-space-${c.lang}-${Date.now()}`;
      const before = await usage(db);
      const res = await postAnalyze(request, [
        { waMessageId: id, body: c.body, authorPhone: "447700900009", authorName: "Clarence Cole", quotedBody: c.callOut, quotedFromMatchTime: true },
      ]);
      const r = (res.results as Result[]).find((x) => x.waMessageId === id)!;
      const after = await usage(db);
      // eslint-disable-next-line no-console
      console.log(`[live] ${c.lang}: ${JSON.stringify({ intent: r.intent, react: r.react, reply: r.reply })}`);
      // eslint-disable-next-line no-console
      console.log(
        `[live] ${c.lang} model calls: ${(after?.calls ?? 0) - (before?.calls ?? 0)}, cost: $${((after?.cost ?? 0) - (before?.cost ?? 0)).toFixed(5)}`,
      );
      expect(r.intent).toBe("organisers_space");
      expect(r.reply).toMatch(c.expected);
      expect(r.reply).not.toContain("Ben");
    });
  }
});

// The same question in the SAME batch as an IN that fills the last place
// (2026-10-20 follow-up): the IN gets its tick and the question is answered
// from the squad AFTER the write, "full", still without names. First come,
// first served, so the IN really changes the squad.
(LIVE ? test.describe : test.describe.skip)("'Is there still space?' beside an IN, organisers announce, LIVE (real model)", () => {
  test.beforeEach(async ({ db }) => {
    resetDb();
    await db.run(`UPDATE "Organisation" SET "listAnnouncer" = 'organisers', language = 'en' WHERE id = $1`, [ORG_ID]);
  });
  test.afterAll(() => resetDb());

  test("en: IN from one player and the space question from another, one batch", async ({ request, db }) => {
    test.setTimeout(180_000);
    const callOut = "We need 1 more player for Fri 20:30. Say *IN* if you can make it.";
    const inId = `e2e-live-oa-batch-in-${Date.now()}`;
    const askId = `e2e-live-oa-batch-ask-${Date.now()}`;
    const before = await usage(db);
    const res = await postAnalyze(request, [
      { waMessageId: inId, body: "IN", authorPhone: "447700900009", authorName: "Ian Innes" },
      { waMessageId: askId, body: "Is there still space?", authorPhone: "447700900003", authorName: "Pat Player", quotedBody: callOut, quotedFromMatchTime: true },
    ]);
    const results = res.results as Result[];
    const inR = results.find((x) => x.waMessageId === inId)!;
    const askR = results.find((x) => x.waMessageId === askId)!;
    const after = await usage(db);
    // eslint-disable-next-line no-console
    console.log(`[live] batch: ${JSON.stringify(results.map((r) => ({ intent: r.intent, react: r.react, reply: r.reply })))}`);
    // eslint-disable-next-line no-console
    console.log(
      `[live] batch model calls: ${(after?.calls ?? 0) - (before?.calls ?? 0)}, cost: $${((after?.cost ?? 0) - (before?.cost ?? 0)).toFixed(5)}`,
    );
    expect(inR.react).toBe("✅");
    expect(askR.intent).toBe("organisers_space");
    expect(askR.reply).toMatch(/^The squad is full for \S.*\. Say \*IN\* to go on the bench\.$/);
    for (const r of results) expect(r.reply ?? "").not.toContain("Ben");
  });
});

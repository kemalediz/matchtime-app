/**
 * THE COMPOUND MESSAGE — a fast path claims its CLAUSE, not the message.
 *
 * ── THE BUG CLASS, SIX INCIDENTS ────────────────────────────────────
 *
 * `api/whatsapp/analyze/route.ts` is a per-message loop of fast paths,
 * and every one of them used to peel the WHOLE message off the pipeline
 * the moment it recognised PART of it. Six production defects, one
 * shape:
 *
 *   1. 2026-09-01  the recruit regex claimed "Najib is out. We need one
 *                  more player" and threw the drop away.
 *   2. PR #29      the guest-name ask discarded the sender's own IN.
 *   3. step 6      an engine short-circuit would have bypassed the
 *                  pasted-roster clamp.
 *   4. 2026-09-06  a pasted list swallowed the sender's own drop.
 *   5. 2026-09-08  a BENCH clause poisoned a clean "David is OUT".
 *   6. THIS FILE   "@Match Time swap Elvin with Raihan, and I'm out"
 *                  applied the swap and lost the sender's OUT.
 *
 * The headline test below is #6 verbatim, in the fixture world: Pat
 * Player is Elvin (dropped, still holding RED), Ian Innes is Raihan
 * (confirmed, no slot), and the ADMIN who asks for the swap is also
 * telling the group he is out.
 *
 * ── WHAT EACH TEST IS FOR ───────────────────────────────────────────
 *
 *   compound          BOTH halves land: the slot moves AND the sender
 *                     is dropped.
 *   single-purpose    the same message without the second clause is
 *                     byte-for-byte the behaviour that shipped.
 *   one reply         the invariant "MatchTime replies once or not at
 *                     all" survives two owners writing for one message.
 */
import { test, expect, postAnalyze, resetDb } from "../fixtures";
import { engineOn, selfOut } from "../helpers/stub";
import { U, PHONE, MATCH, NAME } from "../helpers/constants";
import type { TestDb } from "../helpers/test-db";

test.describe.configure({ mode: "serial" });

let n = 0;
const msgId = () => `e2e-clausepeel-${Date.now()}-${++n}`;

interface Row {
  name: string;
  v: string;
}

async function sheet(db: TestDb): Promise<string[]> {
  const rows = await db.all<Row>(
    `SELECT u.name AS name, t.team::text AS v
       FROM "TeamAssignment" t JOIN "User" u ON u.id = t."userId"
      WHERE t."matchId" = $1
      ORDER BY u.name`,
    [MATCH.upcoming],
  );
  return rows.map((r) => `${r.name}:${r.v}`);
}

async function statusOf(db: TestDb, userId: string): Promise<string | undefined> {
  const row = await db.one<{ v: string }>(
    `SELECT status::text AS v FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`,
    [MATCH.upcoming, userId],
  );
  return row?.v;
}

/** The world at 16:47 on 2026-09-08: a generated sheet, one player
 *  DROPPED but still on it, his replacement confirmed with nowhere to
 *  stand, and the admin who is about to ask for the swap CONFIRMED. */
async function seedTheIncident(db: TestDb): Promise<void> {
  await db.run(
    `UPDATE "Attendance" SET status = 'DROPPED' WHERE "matchId" = $1 AND "userId" = $2`,
    [MATCH.upcoming, U.player],
  );
  await db.run(
    `INSERT INTO "Attendance" (id, "matchId", "userId", status, position, "respondedAt", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, 'CONFIRMED', 6, now(), now(), now())
     ON CONFLICT ("matchId", "userId") DO UPDATE SET status = 'CONFIRMED'`,
    [`e2e-att-clausepeel-${U.fresh}`, MATCH.upcoming, U.fresh],
  );
  await db.run(
    `UPDATE "Attendance" SET status = 'CONFIRMED' WHERE "matchId" = $1 AND "userId" = $2`,
    [MATCH.upcoming, U.admin],
  );
  await db.run(`DELETE FROM "TeamAssignment" WHERE "matchId" = $1`, [MATCH.upcoming]);
  const rows: Array<[string, string]> = [
    [U.admin, "RED"],
    [U.player, "RED"], // ← the stale slot
    [U.collector, "YELLOW"],
    [U.third, "YELLOW"],
  ];
  for (const [userId, team] of rows) {
    await db.run(
      `INSERT INTO "TeamAssignment" (id, "matchId", "userId", team)
       VALUES ($1, $2, $3, $4::"Team")`,
      [`e2e-ta-clausepeel-${userId}`, MATCH.upcoming, userId, team],
    );
  }
}

const PAT = NAME.player.split(" ")[0];
const IAN = NAME.fresh.split(" ")[0];

test.describe("incident #6 — the swap peel used to swallow the sender's OUT", () => {
  test.beforeEach(async ({ db }) => {
    resetDb();
    await seedTheIncident(db);
  });

  test("the swap applies AND the sender is dropped", async ({ request, db }) => {
    // The residual — what is LEFT of the message once the swap clause is
    // peeled off — is what reaches the router and the extractor. Stubbing
    // it by body is how this spec asserts the split happened at all: if
    // the whole message were still being peeled, nothing would ever be
    // routed and this stub would go unread.
    engineOn({ "I'm out": { route: "self_att", facts: selfOut() } });

    await postAnalyze(request, [
      {
        waMessageId: msgId(),
        body: `@Match Time swap ${PAT} with ${IAN}, and I'm out`,
        authorPhone: PHONE.admin,
        authorName: NAME.admin,
        botMentioned: true,
      },
    ]);

    // HALF ONE — the slot moved. Ian holds the RED slot Pat left behind.
    expect(await sheet(db)).toContain(`${NAME.fresh}:RED`);
    expect(await sheet(db)).not.toContain(`${NAME.player}:RED`);

    // HALF TWO — the thing six incidents lost. The sender said he was
    // out in the same breath and he is out.
    expect(await statusOf(db, U.admin)).toBe("DROPPED");

    // A swap still never moves anybody else's attendance.
    expect(await statusOf(db, U.player)).toBe("DROPPED");
    expect(await statusOf(db, U.fresh)).toBe("CONFIRMED");
  });

  test("ONE reply, not two — the invariant survives two owners", async ({ request }) => {
    engineOn({ "I'm out": { route: "self_att", facts: selfOut() } });

    const id = msgId();
    const res = await postAnalyze(request, [
      {
        waMessageId: id,
        body: `@Match Time swap ${PAT} with ${IAN}, and I'm out`,
        authorPhone: PHONE.admin,
        authorName: NAME.admin,
        botMentioned: true,
      },
    ]);

    // Exactly one result for the message, and exactly one outbound
    // message inside it. Two owners WROTE; one SPOKE.
    const mine = res.results.filter((r: { waMessageId: string }) => r.waMessageId === id);
    expect(mine, JSON.stringify(res.results)).toHaveLength(1);
    const speaks = res.results.filter(
      (r: { reply: string | null }) => (r.reply ?? "").length > 0,
    );
    expect(speaks).toHaveLength(1);

    // And the one message that IS sent carries the team sheet the swap
    // clause asked for — the half that would otherwise be silently
    // replaced by the drop's ack.
    expect(speaks[0].reply).toContain(NAME.fresh);
  });

  test("the single-purpose swap is unchanged", async ({ request, db }) => {
    const res = await postAnalyze(request, [
      {
        waMessageId: msgId(),
        body: `@Match Time swap ${PAT} with ${IAN}`,
        authorPhone: PHONE.admin,
        authorName: NAME.admin,
        botMentioned: true,
      },
    ]);
    expect(await sheet(db)).toContain(`${NAME.fresh}:RED`);
    // Nobody's attendance moved, and the admin who asked is still in.
    expect(await statusOf(db, U.admin)).toBe("CONFIRMED");
    const owned = res.results.find((r: { intent: string }) => r.intent === "team_swap");
    expect(owned, JSON.stringify(res.results)).toBeTruthy();
    expect(owned.reply).toContain(NAME.fresh);
  });
});

// ── THE OTHER FOUR PEELS ────────────────────────────────────────────
//
// Same mechanism, two more sites. TWO OF THE ORIGINAL SIX ARE GONE, and
// both went with the regex that made them possible: the stats blast on
// 2026-09-10 (three ANDed keyword tests, 69 mass DMs) and the
// rating-progress answer on 2026-09-11 (a rating word AND a progress
// word, which this file used to call out as the widest of the six).
// What replaced each is a fact the model extracts on a WHOLE-message
// route, so the compound form loses its attendance half — the price
// stated in `lib/stats-blast.ts` and `lib/rating-progress-answer.ts`,
// and measured by the last two tests in this file.
//
// Each is asserted three ways: the compound message lands BOTH halves,
// the single-purpose message is unchanged, and exactly one outbound
// message is produced.

/** Every DM queued for a phone, newest first. */
async function dms(db: TestDb, phone: string): Promise<string[]> {
  const rows = await db.all<{ text: string }>(
    `SELECT text FROM "BotJob" WHERE kind = 'dm' AND phone = $1 ORDER BY "createdAt" DESC`,
    [phone.replace(/^\+/, "")],
  );
  return rows.map((r) => r.text);
}

function speaks(res: { results: Array<{ reply: string | null }> }) {
  return res.results.filter((r) => (r.reply ?? "").length > 0);
}

test.describe("the colour swap keeps the sender's OUT", () => {
  test.beforeEach(async ({ db }) => {
    resetDb();
    await seedTheIncident(db);
  });

  test("flips the sides AND drops the sender, in one reply", async ({ request, db }) => {
    engineOn({ "I'm out": { route: "self_att", facts: selfOut() } });
    const res = await postAnalyze(request, [
      {
        waMessageId: msgId(),
        body: "@Match Time swap the colours, and I'm out",
        authorPhone: PHONE.admin,
        authorName: NAME.admin,
        botMentioned: true,
      },
    ]);
    // Colin was YELLOW in the seed; the flip puts him on RED.
    expect(await sheet(db)).toContain(`${NAME.collector}:RED`);
    expect(await statusOf(db, U.admin)).toBe("DROPPED");
    expect(speaks(res)).toHaveLength(1);
  });

  test("the single-purpose colour swap is unchanged", async ({ request, db }) => {
    await postAnalyze(request, [
      {
        waMessageId: msgId(),
        body: "@Match Time swap the colours",
        authorPhone: PHONE.admin,
        authorName: NAME.admin,
        botMentioned: true,
      },
    ]);
    expect(await sheet(db)).toContain(`${NAME.collector}:RED`);
    expect(await statusOf(db, U.admin)).toBe("CONFIRMED");
  });
});

test.describe("the answer peels keep the sender's OUT", () => {
  test.beforeEach(async ({ db }) => {
    resetDb();
    await db.run(
      `UPDATE "Attendance" SET status = 'CONFIRMED' WHERE "matchId" = $1 AND "userId" = $2`,
      [MATCH.upcoming, U.admin],
    );
  });

  test("my stats — DMs the link AND drops the sender", async ({ request, db }) => {
    engineOn({ "I'm out": { route: "self_att", facts: selfOut() } });
    const res = await postAnalyze(request, [
      {
        waMessageId: msgId(),
        body: "@Match Time my stats. Also I'm out",
        authorPhone: PHONE.admin,
        authorName: NAME.admin,
        botMentioned: true,
      },
    ]);
    expect((await dms(db, PHONE.admin)).join("\n")).toContain("MatchTime stats");
    expect(await statusOf(db, U.admin)).toBe("DROPPED");
    expect(speaks(res).length).toBeLessThanOrEqual(1);
  });

  test("my stats — single-purpose is unchanged", async ({ request, db }) => {
    await postAnalyze(request, [
      {
        waMessageId: msgId(),
        body: "@Match Time my stats",
        authorPhone: PHONE.admin,
        authorName: NAME.admin,
        botMentioned: true,
      },
    ]);
    expect((await dms(db, PHONE.admin)).join("\n")).toContain("MatchTime stats");
    expect(await statusOf(db, U.admin)).toBe("CONFIRMED");
  });

  test("dm me — answers privately AND drops the sender", async ({ request, db }) => {
    engineOn({ "I'm out": { route: "self_att", facts: selfOut() } });
    const before = (await dms(db, PHONE.admin)).length;
    const res = await postAnalyze(request, [
      {
        waMessageId: msgId(),
        body: "@Match Time dm me the fixtures. Also I'm out",
        authorPhone: PHONE.admin,
        authorName: NAME.admin,
        botMentioned: true,
      },
    ]);
    expect((await dms(db, PHONE.admin)).length).toBeGreaterThan(before);
    expect(await statusOf(db, U.admin)).toBe("DROPPED");
    expect(speaks(res).length).toBeLessThanOrEqual(1);
  });

  // ── THE STATS BLAST IS NO LONGER A PEEL, AND THIS IS THE COST ──────
  //
  // WHAT STOOD HERE: "the stats blast — DMs everyone AND drops the
  // sender, in one reply", which passed because a regex
  // (`analyze/route.ts:737`) recognised the blast clause and the peel
  // handed the rest of the message to the pipeline.
  //
  // That regex was three keyword tests ANDed together, and on 2026-09-10
  // it read an owner's reminder to his players — "please do not forget
  // to rate the players via the link from Matchtime DM'ed to you. the
  // more accurate ratings, the more balanced teams next time" — as a
  // bulk-DM command and queued 69 DMs. It is deleted (`lib/stats-blast.ts`),
  // and the blast is now classified by the model on the `admin_ops`
  // route and gated by the engine.
  //
  // A peel needs a deterministic predicate over language. Deleting the
  // predicate deletes the peel, so a COMPOUND bulk-DM command now
  // behaves the way every other `admin_ops` command already does: the
  // whole message goes to one owner and the attendance half is lost.
  // That is incident 6's shape and it is stated rather than discovered,
  // here, in the file about incident 6.
  //
  // The trade, plainly: the alternative was keeping a keyword classifier
  // in front of the widest mass DM in the product so that a rare
  // compound phrasing keeps working. 69 DMs from an unofficial WhatsApp
  // client is the account; a lost OUT in a message that also commands a
  // blast is one re-typed line. The fix worth having is a `sideRequests`
  // entry on the ATTENDANCE extractor — which is how a recruit ask
  // survives beside a drop — and it is a separate change.
  test("the compound blast command: the blast fires, the OUT is LOST (stated cost)", async ({
    request,
    db,
  }) => {
    engineOn({
      "@Match Time send everyone their stats. Also I'm out": {
        route: "admin_ops",
        facts: {
          action: "stats_blast",
          payerRef: "",
          count: 0,
          coveredRefs: [],
          phrase: "",
          note: "",
          lookbackMatches: 0,
        },
      },
    });
    const res = await postAnalyze(request, [
      {
        waMessageId: msgId(),
        body: "@Match Time send everyone their stats. Also I'm out",
        authorPhone: PHONE.admin,
        authorName: NAME.admin,
        botMentioned: true,
      },
    ]);
    const queued = await db.count(
      `SELECT COUNT(*) FROM "BotJob" WHERE kind = 'dm' AND text ILIKE '%MatchTime stats%'`,
    );
    expect(queued).toBeGreaterThan(1);
    // THE COST. The sender said he was out in the same breath and he is
    // still CONFIRMED. Six incidents were this shape; this one is a
    // deliberate, argued instance of it rather than an accident.
    expect(await statusOf(db, U.admin)).toBe("CONFIRMED");
    expect(speaks(res)).toHaveLength(1);
    expect(speaks(res)[0].reply).toContain("personal stats link");
  });

  test("an untagged blast command DMs nobody, whatever the model said", async ({
    request,
    db,
  }) => {
    // The gate that makes the fix independent of the extractor. This body
    // mentions MatchTime by name, so `messageTagsBot` calls it tagged —
    // exactly as the incident sentence is — and it is still refused,
    // because nobody @-mentioned the bot.
    engineOn({
      "matchtime send everyone their stats": {
        route: "admin_ops",
        facts: {
          action: "stats_blast",
          payerRef: "",
          count: 0,
          coveredRefs: [],
          phrase: "",
          note: "",
          lookbackMatches: 0,
        },
      },
    });
    const before = await db.count(
      `SELECT COUNT(*) FROM "BotJob" WHERE kind = 'dm' AND text ILIKE '%MatchTime stats%'`,
    );
    await postAnalyze(request, [
      {
        waMessageId: msgId(),
        body: "matchtime send everyone their stats",
        authorPhone: PHONE.admin,
        authorName: NAME.admin,
      },
    ]);
    expect(
      await db.count(
        `SELECT COUNT(*) FROM "BotJob" WHERE kind = 'dm' AND text ILIKE '%MatchTime stats%'`,
      ),
    ).toBe(before);
  });

  // ── THE RATING-PROGRESS PEEL IS GONE (2026-09-11) ─────────────────
  //
  //   It was `looksLikeRatingProgressRequest` — (a rating word) AND (a
  //   progress word), anywhere in the body — and this file's own header
  //   used to single it out as the widest of the six. It is the
  //   conjunction shape behind 2026-09-01 and 2026-09-10, and it is
  //   deleted. The ask is now `QuestionFacts.topic = "rating_progress"`
  //   on the `question` route, which is a WHOLE-message route.
  //
  //   So these two tests pin the OPPOSITE of what they used to: the
  //   compound form now loses its attendance half, and that is stated
  //   in `lib/rating-progress-answer.ts` rather than discovered here.

  const RATING_Q = {
    route: "question",
    facts: { topic: "rating_progress", personRef: "", statedCount: -1 },
  };

  test("rating progress — the compound form now LOSES the sender's OUT", async ({
    request,
    db,
  }) => {
    // THE COST OF THE DELETION, measured. Before 2026-09-11 the peel
    // took the question and the residual "Also I'm out" dropped the
    // sender. A peel needs a deterministic predicate over language, and
    // a deterministic predicate over language is what caused both
    // incidents, so the peel went with it.
    engineOn({ "@Match Time who hasn't rated yet? Also I'm out": RATING_Q });
    const res = await postAnalyze(request, [
      {
        waMessageId: msgId(),
        body: "@Match Time who hasn't rated yet? Also I'm out",
        authorPhone: PHONE.admin,
        authorName: NAME.admin,
        botMentioned: true,
      },
    ]);
    expect(await statusOf(db, U.admin)).toBe("CONFIRMED");
    // It still answers, and it still speaks exactly once.
    expect(speaks(res)).toHaveLength(1);
  });

  test("rating progress — the single-purpose ask still answers", async ({ request, db }) => {
    // The feature is not deleted, only its recogniser.
    engineOn({ "@Match Time who hasn't rated yet?": RATING_Q });
    const res = await postAnalyze(request, [
      {
        waMessageId: msgId(),
        body: "@Match Time who hasn't rated yet?",
        authorPhone: PHONE.admin,
        authorName: NAME.admin,
        botMentioned: true,
      },
    ]);
    expect(await statusOf(db, U.admin)).toBe("CONFIRMED");
    // The intent label the deleted fast path wrote, kept on purpose so
    // the admin log's vocabulary is unchanged by the move to the model.
    expect(res.results.map((r: { intent: string | null }) => r.intent)).toContain(
      "rating_progress",
    );
    expect(speaks(res)).toHaveLength(1);
  });

  test("rating progress — a non-admin is refused, and silently", async ({ request, db }) => {
    // The answer NAMES the players who have not rated, which is why this
    // gate survived the conversion unchanged.
    engineOn({ "@Match Time who hasn't rated yet please": RATING_Q });
    const res = await postAnalyze(request, [
      {
        waMessageId: msgId(),
        body: "@Match Time who hasn't rated yet please",
        authorPhone: PHONE.collector,
        authorName: NAME.collector,
        botMentioned: true,
      },
    ]);
    expect(await statusOf(db, U.collector)).toBe("CONFIRMED");
    expect(speaks(res)).toHaveLength(0);
  });
});

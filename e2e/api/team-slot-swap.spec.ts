/**
 * THE 2026-09-08 ELVIN/RAIHAN INCIDENT, END TO END THROUGH THE REAL
 * ROUTE.
 *
 * `src/lib/__tests__/team-slot-swap.test.ts` pins the DECISION for all
 * 64 states. This file pins the only thing that spec cannot: that the
 * decision reaches Postgres, that it reaches ONLY `TeamAssignment`, and
 * that the reply carries the line-up the message asked for.
 *
 * Production, the afternoon of a match:
 *
 *   15:25  Elvin:  "please can someone replace me, not feeling well"
 *                  → DROPPED, still holding a RED slot.
 *   16:15  Wasim:  "I have a friend who will play instead of my dad.
 *                   His name is Raihan"       → CONFIRMED, no slot.
 *   16:47  Kemal:  "@Match Time do not regenerate the teams. Instead
 *                   swap Elvin with Raihan and share us the teams"
 *                  → NOTHING HAPPENED. The pre-peel matched the
 *                    sentence and declined on "both must be CONFIRMED";
 *                    the message reached `balancer`, which owns no
 *                    `swap`, and the owner got one operator note while
 *                    the team sheet still named a man who had gone home.
 *
 * Cast, in the fixture world: Pat Player is Elvin (drops out holding
 * RED), Ian Innes is Raihan (arrives, confirmed, no slot).
 *
 * The route is driven with NO stub for the incident message on purpose.
 * The swap peel runs before the router on the raw body, so if this test
 * needed a stubbed route it would be testing the wrong code.
 */
import { test, expect, postAnalyze, resetDb } from "../fixtures";
import { engineOn } from "../helpers/stub";
import { U, PHONE, MATCH, NAME } from "../helpers/constants";
import type { TestDb } from "../helpers/test-db";

test.describe.configure({ mode: "serial" });

let n = 0;
const msgId = () => `e2e-slotswap-${Date.now()}-${++n}`;

interface Row {
  name: string;
  v: string;
}

/** The team sheet as "Name:TEAM", ordered — the thing that was stale. */
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

/** Every attendance row as "Name:STATUS". A swap must never move one. */
async function squad(db: TestDb): Promise<string[]> {
  const rows = await db.all<Row>(
    `SELECT u.name AS name, a.status::text AS v
       FROM "Attendance" a JOIN "User" u ON u.id = a."userId"
      WHERE a."matchId" = $1
      ORDER BY u.name`,
    [MATCH.upcoming],
  );
  return rows.map((r) => `${r.name}:${r.v}`);
}

async function matchStatus(db: TestDb): Promise<string | undefined> {
  const row = await db.one<{ v: string }>(
    `SELECT status::text AS v FROM "Match" WHERE id = $1`,
    [MATCH.upcoming],
  );
  return row?.v;
}

/**
 * The world at 16:47: a generated sheet, one player DROPPED but still
 * on it, and his replacement confirmed with nowhere to stand.
 */
async function seedTheIncident(db: TestDb): Promise<void> {
  // Pat pulled out at 15:25 — DROPPED, but the sheet was built before
  // that and still has him on RED.
  await db.run(`UPDATE "Attendance" SET status = 'DROPPED' WHERE "matchId" = $1 AND "userId" = $2`, [
    MATCH.upcoming,
    U.player,
  ]);
  // Ian arrived at 16:15 as somebody's replacement — CONFIRMED, no slot.
  await db.run(
    `INSERT INTO "Attendance" (id, "matchId", "userId", status, position, "respondedAt", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, 'CONFIRMED', 6, now(), now(), now())
     ON CONFLICT ("matchId", "userId") DO UPDATE SET status = 'CONFIRMED'`,
    [`e2e-att-slotswap-${U.fresh}`, MATCH.upcoming, U.fresh],
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
      [`e2e-ta-slotswap-${userId}`, MATCH.upcoming, userId, team],
    );
  }
}

test.describe("the replacement transfer — 2026-09-08", () => {
  test.beforeEach(async ({ db }) => {
    resetDb();
    await seedTheIncident(db);
  });

  test("moves the dropped player's slot to his replacement, and nothing else", async ({
    request,
    db,
  }) => {
    const before = await squad(db);

    const res = await postAnalyze(request, [
      {
        waMessageId: msgId(),
        body: `@Match Time do not regenerate the teams. Instead swap ${NAME.player.split(" ")[0]} with ${NAME.fresh.split(" ")[0]} and share us the teams`,
        authorPhone: PHONE.admin,
        authorName: NAME.admin,
        botMentioned: true,
      },
    ]);

    // THE SHEET MOVED, and only by one row: Ian holds Pat's RED.
    expect((await sheet(db)).sort()).toEqual(
      [
        `${NAME.admin}:RED`,
        `${NAME.fresh}:RED`,
        `${NAME.collector}:YELLOW`,
        `${NAME.third}:YELLOW`,
      ].sort(),
    );

    // NOT ONE ATTENDANCE ROW MOVED. Pat is still DROPPED, Ian still
    // CONFIRMED, the bench untouched. A swap moves a slot; that is all.
    expect(await squad(db)).toEqual(before);

    // AND THE BALANCER NEVER RAN. `generate` moves the match to
    // TEAMS_GENERATED; the message said not to, and it did not.
    expect(await matchStatus(db)).toBe("UPCOMING");

    // "share us the teams" — the reply IS the line-up.
    const owned = res.results.find(
      (r: { intent: string }) => r.intent === "team_swap",
    );
    expect(owned, JSON.stringify(res.results)).toBeTruthy();
    const reply: string = owned.reply;
    expect(reply).toContain(NAME.fresh);
    expect(reply).toContain(NAME.player);
    expect(reply).toContain(NAME.admin);
    expect(reply).toContain(NAME.third);
  });

  test("reads the same the other way round — 'swap Ian with Pat'", async ({ request, db }) => {
    await postAnalyze(request, [
      {
        waMessageId: msgId(),
        body: `@Match Time swap ${NAME.fresh.split(" ")[0]} with ${NAME.player.split(" ")[0]}`,
        authorPhone: PHONE.admin,
        authorName: NAME.admin,
        botMentioned: true,
      },
    ]);
    expect(await sheet(db)).toContain(`${NAME.fresh}:RED`);
    expect(await sheet(db)).not.toContain(`${NAME.player}:RED`);
  });

  test("a NON-ADMIN may ask — a slot transfer changes nobody's squad standing", async ({
    request,
    db,
  }) => {
    // The person who knows a replacement has arrived is the player who
    // brought them. On 2026-09-08 that was Wasim, not an admin. The tag
    // is the deliberate act; see the contract note in team-slot-swap.ts.
    await postAnalyze(request, [
      {
        waMessageId: msgId(),
        body: `@Match Time swap ${NAME.player.split(" ")[0]} with ${NAME.fresh.split(" ")[0]}`,
        authorPhone: PHONE.rater, // Riley Rater — an ordinary member
        authorName: NAME.rater,
        botMentioned: true,
      },
    ]);
    expect(await sheet(db)).toContain(`${NAME.fresh}:RED`);
  });

  test("REFUSES rather than guesses when neither named player is playing", async ({
    request,
    db,
  }) => {
    // Ben is BENCH with no slot, Pat is DROPPED with one. Neither is in
    // the squad, so there is no correct occupant to move the slot TO:
    // `nobody-is-playing`.
    //
    // CHANGED 2026-09-17. This used to assert the peel did NOT own the
    // message, and so the owner heard nothing. A refusal is now answered
    // (the sheet is still untouched), and the WHOLE message still goes
    // down the pipeline: the router is stubbed to `none` here, so the
    // refusal is the only thing said.
    const body = `@Match Time swap ${NAME.bench.split(" ")[0]} with ${NAME.player.split(" ")[0]}`;
    engineOn({ [body]: { route: "none" } });
    const before = await sheet(db);
    const beforeSquad = await squad(db);

    const res = await postAnalyze(request, [
      {
        waMessageId: msgId(),
        body,
        authorPhone: PHONE.admin,
        authorName: NAME.admin,
        botMentioned: true,
      },
    ]);

    expect(await sheet(db)).toEqual(before);
    expect(await squad(db)).toEqual(beforeSquad);
    const speaking = res.results.filter((r: { reply: string | null }) => (r.reply ?? "").length > 0);
    expect(speaking, JSON.stringify(res.results)).toHaveLength(1);
    expect(speaking[0].reply).toBe(
      `I haven't swapped *${NAME.bench}* and *${NAME.player}*. Neither of them is in the squad. ` +
        `Nothing changed and nobody was dropped.`,
    );
  });
});

// ── A SWAP IT CANNOT APPLY IS NEVER A DROP (2026-09-17) ────────────────
//
// Dry-run cases TR26 / TR27, live, REPEAT=10, before the fix: a swap the
// peel refused went down the pipeline whole, and the extractor read
// "swap David and Sait" as David leaving. David was DROPPED 10 of 10
// (English) and 9 of 10 (Turkish).
//
// The extractor is stubbed below with THAT reading, the one the live
// model actually gives, so these tests prove the route and the engine
// refuse it rather than assuming the model will not produce it.
test.describe("a refused swap drops nobody and says so", () => {
  const PAT = NAME.player.split(" ")[0];
  const TOM = NAME.third.split(" ")[0];
  const patOut = {
    claims: [
      {
        subject: "other",
        personRef: PAT,
        personNamed: true,
        polarity: "out",
        contingent: false,
        conditionOn: "none",
        tense: "present",
        basis: "decision",
        reported: false,
        confidence: 0.7,
      },
    ],
    affirmation: "none",
    sideRequests: [],
  };

  test.beforeEach(async ({ db }) => {
    resetDb();
    await seedTheIncident(db);
    await db.run(
      `UPDATE "Attendance" SET status = 'CONFIRMED' WHERE "matchId" = $1 AND "userId" = $2`,
      [MATCH.upcoming, U.player],
    );
  });

  test("an unknown name: Pat stays in, the owner is told, one reply", async ({ request, db }) => {
    const body = `@Match Time swap ${PAT} and Zork`;
    engineOn({ [body]: { route: "other_att", facts: patOut } });
    const before = await squad(db);
    const beforeSheet = await sheet(db);

    const id = msgId();
    const res = await postAnalyze(request, [
      { waMessageId: id, body, authorPhone: PHONE.admin, authorName: NAME.admin, botMentioned: true },
    ]);

    expect(await squad(db)).toEqual(before);
    expect(await sheet(db)).toEqual(beforeSheet);
    const mine = res.results.filter((r: { waMessageId: string }) => r.waMessageId === id);
    expect(mine, JSON.stringify(res.results)).toHaveLength(1);
    expect(mine[0].intent).toBe("team_swap");
    expect(mine[0].reply).toBe(
      `I haven't swapped *${NAME.player}* and *Zork*. I can't find a player called *Zork* for this match. ` +
        `Use the name they're registered under. Nothing changed and nobody was dropped.`,
    );
  });

  test("the sender's own OUT in the same message still lands, with no comma", async ({ request, db }) => {
    // The swap clause cannot be split off without a comma, so the whole
    // body is what the pipeline sees. Pat is refused as a swap party; the
    // sender is not a party and is dropped.
    const body = `@Match Time swap ${PAT} and Zork and I'm out`;
    engineOn({
      [body]: {
        route: "other_att",
        facts: { ...patOut, claims: [...patOut.claims, { ...patOut.claims[0], subject: "sender", personRef: "", personNamed: false, confidence: 0.95 }] },
      },
    });

    await postAnalyze(request, [
      { waMessageId: msgId(), body, authorPhone: PHONE.admin, authorName: NAME.admin, botMentioned: true },
    ]);

    expect(await squadStatus(db, U.admin)).toBe("DROPPED");
    expect(await squadStatus(db, U.player)).toBe("CONFIRMED");
  });

  test("an UNTAGGED swap from an admin drops nobody", async ({ request, db }) => {
    // Never reaches the peel (no tag). An admin's third-party OUT needs
    // no tag, so before the engine guard this dropped Pat outright.
    const body = `swap ${PAT} with ${TOM}`;
    engineOn({ [body]: { route: "other_att", facts: patOut } });
    const before = await squad(db);

    await postAnalyze(request, [
      { waMessageId: msgId(), body, authorPhone: PHONE.admin, authorName: NAME.admin },
    ]);

    expect(await squad(db)).toEqual(before);
  });

  test("'swap me with Ben please, I can't make it' drops the sender and says no refusal", async ({ request, db }) => {
    // Review of PR #99: a substitution naming the sender is a DROP. The
    // fast path must stay silent and the engine must let the OUT apply.
    const body = `@Match Time swap me with ${NAME.bench.split(" ")[0]} please, I can't make it`;
    engineOn({
      [body]: {
        route: "self_att",
        facts: { ...patOut, claims: [{ ...patOut.claims[0], subject: "sender", personRef: "", personNamed: false, confidence: 0.95 }] },
      },
    });
    const res = await postAnalyze(request, [
      { waMessageId: msgId(), body, authorPhone: PHONE.admin, authorName: NAME.admin, botMentioned: true },
    ]);
    expect(await squadStatus(db, U.admin)).toBe("DROPPED");
    for (const r of res.results as Array<{ reply: string | null }>) {
      expect(r.reply ?? "").not.toContain("haven't swapped");
    }
  });

  test("'switch it to 7 a side' is not a player swap and gets no refusal", async ({ request }) => {
    const body = "@Match Time switch it to 7 a side";
    engineOn({ [body]: { route: "none" } });
    const res = await postAnalyze(request, [
      { waMessageId: msgId(), body, authorPhone: PHONE.admin, authorName: NAME.admin, botMentioned: true },
    ]);
    for (const r of res.results as Array<{ reply: string | null; intent: string }>) {
      expect(r.reply ?? "").not.toContain("haven't swapped");
      expect(r.intent).not.toBe("team_swap");
    }
  });
});

async function squadStatus(db: TestDb, userId: string): Promise<string | undefined> {
  const row = await db.one<{ v: string }>(
    `SELECT status::text AS v FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`,
    [MATCH.upcoming, userId],
  );
  return row?.v;
}

test.describe("the shipped both-CONFIRMED team swap still works", () => {
  test.beforeEach(async ({ db }) => {
    resetDb();
    await seedTheIncident(db);
    // Put Pat back in the squad: now it is the 2026-05-19 case again,
    // two confirmed players trading sides.
    await db.run(
      `UPDATE "Attendance" SET status = 'CONFIRMED' WHERE "matchId" = $1 AND "userId" = $2`,
      [MATCH.upcoming, U.player],
    );
  });

  test("exchanges two confirmed players' sides, drops nobody", async ({ request, db }) => {
    const before = await squad(db);
    await postAnalyze(request, [
      {
        waMessageId: msgId(),
        body: `@Match Time swap ${NAME.player.split(" ")[0]} with ${NAME.third.split(" ")[0]}`,
        authorPhone: PHONE.admin,
        authorName: NAME.admin,
        botMentioned: true,
      },
    ]);
    const after = await sheet(db);
    expect(after).toContain(`${NAME.player}:YELLOW`);
    expect(after).toContain(`${NAME.third}:RED`);
    expect(await squad(db)).toEqual(before);
  });
});

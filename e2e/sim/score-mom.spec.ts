/**
 * Group-simulator scenario matrix — SCORE CAPTURE + MoM votes.
 *
 * Score: the LLM extracts scoreRed/scoreYellow against the org's two
 * team labels (index 0 → RED, 1 → YELLOW — here custom "Bibs"/"Skins");
 * the server writes the score, completes the match and applies Elo —
 * but only for an admin or a confirmed participant. The dedicated
 * /api/whatsapp/score route enforces the same rule.
 *
 * MoM: poll votes upsert one MoMVote per voter, self-votes are refused,
 * un-voting clears.
 */
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import type { TestDb } from "../helpers/test-db";
import { E2E } from "../helpers/env";
import { createGroup, SimGroup } from "./group";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  resetDb();
});

let g: SimGroup;
const group = async (request: APIRequestContext, db: TestDb) =>
  (g ??= await createGroup(request, db, {
    maxPlayers: 8,
    sportTeamLabels: ["Bibs", "Skins"],
    upcomingMatch: false,
    completedMatch: {
      daysAgo: 1,
      status: "TEAMS_PUBLISHED", // ended but unscored
      redScore: null,
      yellowScore: null,
      confirmedKeys: ["owner", "alice", "pete", "dan"],
      teams: { owner: "RED", pete: "RED", alice: "YELLOW", dan: "YELLOW" },
    },
  })).attach(request);

const matchRow = (grp: SimGroup) =>
  grp.db.one<{ redScore: number | null; yellowScore: number | null; status: string }>(
    `SELECT "redScore", "yellowScore", status FROM "Match" WHERE id = $1`,
    [grp.completedMatchId],
  );

const ratingOf = async (grp: SimGroup, key: string) => {
  const row = await grp.db.one<{ matchRating: number }>(
    `SELECT "matchRating" FROM "User" WHERE id = $1`,
    [grp.player(key).userId],
  );
  return row!.matchRating;
};

test("score from a resolved NON-participant non-admin is refused silently", async ({ request, db }) => {
  const grp = await group(request, db);
  const r = await grp.post("felix", "we won 5-3!", {
    verdict: { intent: "score", scoreRed: 5, scoreYellow: 3, react: "👍", reply: null, confidence: 0.9, reasoning: "stub" },
  });
  expect(r.react).toBeNull();
  const m = await matchRow(grp);
  expect(m?.redScore).toBeNull();
  expect(m?.status).toBe("TEAMS_PUBLISHED");
});

test("score via chat (custom labels): Bibs 5–3 Skins → redScore/yellowScore, COMPLETED, Elo applied", async ({ request, db }) => {
  const grp = await group(request, db);
  const r = await grp.post("owner", "Final score: bibs 5, skins 3", {
    verdict: { intent: "score", scoreRed: 5, scoreYellow: 3, react: "👍", reply: null, confidence: 0.95, reasoning: "stub" },
  });
  expect(r.react).toBe("👍");
  const m = await matchRow(grp);
  expect(m?.redScore).toBe(5); // first label (Bibs) maps to the RED slot
  expect(m?.yellowScore).toBe(3);
  expect(m?.status).toBe("COMPLETED");
  // Elo: winners up, losers down.
  expect(await ratingOf(grp, "owner")).toBeGreaterThan(1000);
  expect(await ratingOf(grp, "pete")).toBeGreaterThan(1000);
  expect(await ratingOf(grp, "alice")).toBeLessThan(1000);
  expect(await ratingOf(grp, "dan")).toBeLessThan(1000);
});

test("the dedicated /score route records too (admin sender)", async ({ request, db }) => {
  const grp = await group(request, db);
  // Reset to "ended but unscored".
  await grp.db.run(
    `UPDATE "Match" SET "redScore" = NULL, "yellowScore" = NULL, status = 'TEAMS_PUBLISHED' WHERE id = $1`,
    [grp.completedMatchId],
  );
  const res = await request.post("/api/whatsapp/score", {
    headers: { "x-api-key": E2E.WHATSAPP_API_KEY },
    data: {
      groupId: grp.groupId,
      fromPhone: grp.player("alice").phone!.replace(/^\+/, ""),
      redScore: 2,
      yellowScore: 4,
    },
  });
  expect(res.status(), await res.text()).toBe(200);
  const json = await res.json();
  expect(json.ok).toBe(true);
  const m = await matchRow(grp);
  expect(m?.redScore).toBe(2);
  expect(m?.yellowScore).toBe(4);
  expect(m?.status).toBe("COMPLETED");
});

test("MoM poll votes: recorded, re-vote replaces, self-vote refused, un-vote clears", async ({ request, db }) => {
  const grp = await group(request, db);
  const pollMsgId = `sim-mom-poll-${Date.now()}`;
  await grp.db.run(
    `INSERT INTO "SentNotification" (id, key, kind, "matchId", "waMessageId")
     VALUES ($1, $2, 'mom-poll', $3, $4)`,
    [`sim-sn-mom-${grp.orgId}`, `${grp.completedMatchId}:mom-poll`, grp.completedMatchId, pollMsgId],
  );

  const vote = (voterKey: string, optionName: string | null) =>
    grp.pollVote({ waMessageId: pollMsgId, voterKey, optionName });

  const momVote = () =>
    grp.db.one<{ playerId: string }>(
      `SELECT "playerId" FROM "MoMVote" WHERE "matchId" = $1 AND "voterId" = $2`,
      [grp.completedMatchId, grp.player("pete").userId],
    );

  expect((await vote("pete", "Dan Drummer")).action).toBe("recorded");
  expect((await momVote())?.playerId).toBe(grp.player("dan").userId);

  // Re-vote replaces (one vote per voter).
  expect((await vote("pete", "Alice Admin")).action).toBe("recorded");
  expect((await momVote())?.playerId).toBe(grp.player("alice").userId);
  expect(
    await grp.db.count(`SELECT COUNT(*) FROM "MoMVote" WHERE "matchId" = $1 AND "voterId" = $2`, [
      grp.completedMatchId,
      grp.player("pete").userId,
    ]),
  ).toBe(1);

  // Self-vote refused.
  expect((await vote("pete", "Pete Power")).ignored).toBe("self-vote");
  expect((await momVote())?.playerId).toBe(grp.player("alice").userId);

  // Un-vote clears.
  expect((await vote("pete", null)).action).toBe("cleared");
  expect(await momVote()).toBeNull();
});

/**
 * Group-simulator scenario matrix — RECENT RESULTS (2026-09-29; the unified
 * answer's since 2026-11-18).
 *
 * Sutton FC, 2026-09-29 22:18 UTC: "@Match Time give us the scores of the
 * last 5 matches" was answered with the last match only. The composed
 * results answer that fixed it was deleted with the other question
 * categories: the question is the unified answer's, and what it is shown is
 * the club's own scored matches, newest first, read by `load-results.ts`
 * from the real test database.
 *
 * The router, the question extractor and the unified answer are STUBBED
 * (what the model would say); the read, the context, the engine and the
 * analyze route run for real. What is checked is what the answer is SHOWN:
 *
 *   the incident      the club's results, newest first, from the database
 *   club-scoped       another club's scored match never appears
 *   unscored skipped  an ended match with no score is not a result
 */
import { readFileSync } from "node:fs";
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import type { TestDb } from "../helpers/test-db";
import { londonAt } from "../helpers/constants";
import { E2E } from "../helpers/env";
import { createGroup, SimGroup } from "./group";

const ANSWER = "Here are the latest results.";
const scoreQ = () => ({
  route: "question",
  facts: { kind: "other", personRef: "", feature: "none", badge: "none", answer: ANSWER },
});

/** The unified answer's turn for this body, as the stub was shown it. */
function unifiedTurn(body: string): string {
  return (
    readFileSync(`${E2E.EXTRACTOR_STUB_FILE}.calls`, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { label: string; user: string })
      .filter((c) => c.label === "unified-answer" && c.user.trimEnd().endsWith(body))
      .pop()?.user ?? ""
  );
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  resetDb();
});

/** One more played match on this group's activity, `daysAgo` days back. */
async function addMatch(grp: SimGroup, id: string, daysAgo: number, red: number | null, yellow: number | null) {
  const date = londonAt(-daysAgo, 20, 0);
  await grp.db.run(
    `INSERT INTO "Match" (id, "activityId", date, "maxPlayers", status, "attendanceDeadline",
                          "redScore", "yellowScore", "postMatchEndFlow", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, now())`,
    [id, grp.activityId, date, grp.maxPlayers, "COMPLETED", new Date(date.getTime() - 5 * 3_600_000), red, yellow],
  );
}

let g: SimGroup;
const group = async (request: APIRequestContext, db: TestDb) => {
  if (!g) {
    g = await createGroup(request, db, {
      maxPlayers: 8,
      attendance: [{ key: "owner", status: "CONFIRMED" }],
      completedMatch: { daysAgo: 2, confirmedKeys: ["owner", "alice"], redScore: 5, yellowScore: 4 },
    });
    await addMatch(g, `${g.orgId}-m9`, 9, 2, 6);
    await addMatch(g, `${g.orgId}-m16`, 16, null, null); // ended, never scored (COMPLETED so it does not hold registration)
    await addMatch(g, `${g.orgId}-m23`, 23, 3, 3);
    await addMatch(g, `${g.orgId}-m30`, 30, 7, 1);
    await addMatch(g, `${g.orgId}-m37`, 37, 4, 5);
    await addMatch(g, `${g.orgId}-m44`, 44, 1, 0);
    // ANOTHER club, with a result that must never leak into this one's.
    await createGroup(request, db, {
      completedMatch: { daysAgo: 3, confirmedKeys: ["owner"], redScore: 9, yellowScore: 9 },
    });
  }
  return g.attach(request);
};

test("THE INCIDENT: the answer is shown this club's scored matches, newest first, and no other club's", async ({ request, db }) => {
  const grp = await group(request, db);
  const ASK = "@Match Time give us the scores of the last 5 matches";
  const r = await grp.post("owner", ASK, { ...scoreQ(), tag: true });
  expect(r.reply, JSON.stringify(r)).toBe(ANSWER);
  const turn = unifiedTurn(ASK);
  const block = turn.slice(turn.indexOf("RECENT RESULTS"), turn.indexOf("\n\n", turn.indexOf("RECENT RESULTS")));
  expect(block).toMatch(/^RECENT RESULTS, newest first \(6\):/);
  // Newest first, the unscored match left out.
  expect(block.split("\n").slice(1).map((l) => l.replace(/^ {2}[^:]+: /, ""))).toEqual([
    "Red 5, Yellow 4",
    "Red 2, Yellow 6",
    "Red 3, Yellow 3",
    "Red 7, Yellow 1",
    "Red 4, Yellow 5",
    "Red 1, Yellow 0",
  ]);
  // Club-scoped: the other club's 9 to 9 is nowhere.
  expect(block).not.toContain("Red 9, Yellow 9");
});

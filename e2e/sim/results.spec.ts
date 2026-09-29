/**
 * Group-simulator scenario matrix — RECENT RESULTS (2026-09-29).
 *
 * Sutton FC, 2026-09-29 22:18 UTC: "@Match Time give us the scores of the
 * last 5 matches" was answered with the last match only. The question
 * extractor now carries the count and the period on a `score` question
 * (`listSize`, `period`); the answer is read from the club's own scored
 * matches by `load-results.ts` and rendered in code.
 *
 * The extractor is STUBBED here with the raw JSON the live model returns,
 * so `parseFacts`, the engine, the targeted read against the real test
 * database, the composer and the analyze route all run for real.
 *
 *   the incident      five results, most recent first, from the database
 *   club-scoped       another club's scored match never appears
 *   unscored skipped  an ended match with no score is not a result
 *   no count          still the last match, byte for byte as before
 *   Turkish           the same answer in a Turkish group
 */
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import type { TestDb } from "../helpers/test-db";
import { londonAt } from "../helpers/constants";
import { createGroup, SimGroup } from "./group";

const scoreQ = (over: Record<string, unknown> = {}) => ({
  route: "question",
  facts: {
    topic: "score",
    personRef: "",
    statedCount: -1,
    table: "none",
    listSize: -1,
    listEnd: "top",
    period: "none",
    periodCount: -1,
    periodUnit: "none",
    ...over,
  },
});

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

test("THE INCIDENT: the last 5 matches, from this club's scored matches", async ({ request, db }) => {
  const grp = await group(request, db);
  const r = await grp.post("owner", "@Match Time give us the scores of the last 5 matches", { ...scoreQ({ listSize: 5 }), tag: true });
  const lines = (r.reply ?? "").split("\n");
  expect(lines[0], JSON.stringify(r)).toBe("⚽ Last 5 results:");
  expect(lines.slice(1).map((l) => l.replace(/^• [^:]+: /, ""))).toEqual([
    "Red 5 - 4 Yellow. Red won.",
    "Red 2 - 6 Yellow. Yellow won.",
    "Red 3 - 3 Yellow. A draw.",
    "Red 7 - 1 Yellow. Red won.",
    "Red 4 - 5 Yellow. Yellow won.",
  ]);
  // Club-scoped: the other club's 9 - 9 is nowhere.
  expect(r.reply).not.toContain("9 - 9");
});

test("asked for more than the record holds, it says so", async ({ request, db }) => {
  const grp = await group(request, db);
  const r = await grp.post("owner", "@Match Time last 10 results", { ...scoreQ({ listSize: 10 }), tag: true });
  expect(r.reply ?? "").toMatch(/^⚽ Last 6 results:/);
  expect(r.reply ?? "").toContain("That's every scored match I have on record.");
});

test("no count and no period is still the last match, as before", async ({ request, db }) => {
  const grp = await group(request, db);
  const r = await grp.post("owner", "@Match Time what was the score", { ...scoreQ(), tag: true });
  expect(r.reply ?? "").toMatch(/^⚽ \S+ \d\d:\d\d: Red 5 - 4 Yellow\. Red won\.$/);
});

test("a Turkish group hears it in Turkish", async ({ request, db }) => {
  const grp = await group(request, db);
  await grp.db.run(`UPDATE "Organisation" SET language = 'tr' WHERE id = $1`, [grp.orgId]);
  try {
    const r = await grp.post("owner", "@Match Time son 3 maçın skorları", { ...scoreQ({ listSize: 3 }), tag: true });
    const lines = (r.reply ?? "").split("\n");
    expect(lines[0], JSON.stringify(r)).toBe("⚽ Son 3 sonuç:");
    expect(lines[1]).toMatch(/^• \d+ \S+ \S+: Kırmızı 5 - 4 Sarı\. Kırmızı kazandı\.$/);
    expect(lines[3]).toMatch(/Berabere\.$/);
  } finally {
    await grp.db.run(`UPDATE "Organisation" SET language = 'en' WHERE id = $1`, [grp.orgId]);
  }
});

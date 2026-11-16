/**
 * Group simulator: AFTER "SWITCH TO 8SIDE" THE LIST NAMES 8-A-SIDE
 * (the Vets, 16 Nov 2026).
 *
 * "@Match Time switch to 8side" made the game 16 places, but the next list
 * was headed "Football 7-a-side": the title was the Activity's name, which
 * self-join wrote from the club's usual size. Posts now name the size the
 * game is played at (`match-format-title.ts`).
 *
 * The REAL routes: the organiser's switch goes through the admin-ops
 * engine and `format-resize.ts`, the last IN through the attendance engine,
 * and the squad-complete list is the shipped post. Router and extractor
 * stubbed, no model calls. Every person and number is made up.
 */
import { test, expect, resetDb } from "../fixtures";
import { createGroup, type SimGroup } from "./group";
import { selfIn } from "../helpers/stub";
import type { APIRequestContext } from "@playwright/test";
import type { TestDb } from "../helpers/test-db";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  resetDb();
});

const SWITCH = "@Match Time switch to 8side";
const switchFacts = {
  action: "switch_format",
  size: 8,
  aSide: true,
  payerRef: "",
  count: 0,
  coveredRefs: [],
  undo: false,
  matchDay: "",
  pastGame: false,
  phrase: "",
  note: "",
  lookbackMatches: 0,
  playersFrom: "",
  clubRef: "",
};

const FOURTEEN = ["owner", "alice", "brian", "pete", "dan", "felix", "greg", "henry", "ivan", "jake", "kyle", "liam", "mike", "noah"];

/** A weekly 7-a-side club named by self-join, 14 in and one on the bench,
 *  whose game may be played 6, 7 or 8 a side. */
async function sevenASide(request: APIRequestContext, db: TestDb, activityName: string, language: "en" | "tr"): Promise<SimGroup> {
  const g = (
    await createGroup(request, db, {
      maxPlayers: 14,
      attendance: [...FOURTEEN.map((key) => ({ key, status: "CONFIRMED" as const })), { key: "quinn", status: "BENCH" as const }],
    })
  ).attach(request);
  await db.run(`UPDATE "Activity" SET name = $2, "minPlayers" = 12, "maxPlayers" = 16 WHERE id = $1`, [g.activityId, activityName]);
  await db.run(`UPDATE "Organisation" SET language = $2 WHERE id = $1`, [g.orgId, language]);
  return g;
}

async function switchThenFill(g: SimGroup) {
  const sw = await g.post("alice", SWITCH, { route: "admin_ops", facts: switchFacts, tag: true });
  expect(sw.intent, JSON.stringify(sw.raw)).toBe("format-switched");
  expect((await g.db.one<{ maxPlayers: number }>(`SELECT "maxPlayers" FROM "Match" WHERE id = $1`, [g.matchId]))?.maxPlayers).toBe(16);
  expect((await g.attendanceOf("quinn"))?.status).toBe("CONFIRMED");
  // The sixteenth player fills the 8-a-side game.
  await g.post("ryan", "in", { route: "self_att", facts: selfIn() });
  expect((await g.counts()).confirmed).toBe(16);
  return g.botJobs("group");
}

test("the squad list after the switch is headed with 8-a-side, not the activity's 7-a-side", async ({ request, db }) => {
  const g = await sevenASide(request, db, "Football 7-a-side", "en");
  const posts = (await switchThenFill(g)).map((p) => p.text);
  const complete = posts.find((t) => t.includes("Squad complete"));
  expect(complete, posts.join("\n---\n")).toBeTruthy();
  expect(complete).toContain("*Football 8-a-side*");
  expect(posts.join("\n")).not.toContain("7-a-side");
});

test("in Turkish: \"7'ye 7 futbol\" becomes \"8'e 8 futbol\"", async ({ request, db }) => {
  const g = await sevenASide(request, db, "7'ye 7 futbol", "tr");
  const posts = (await switchThenFill(g)).map((p) => p.text);
  const titled = posts.filter((t) => t.includes("futbol"));
  expect(titled.length, posts.join("\n---\n")).toBeGreaterThan(0);
  for (const t of titled) expect(t).toContain("8'e 8 futbol");
  expect(posts.join("\n")).not.toContain("7'ye 7");
});

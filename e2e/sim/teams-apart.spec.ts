/**
 * Group-simulator scenario: WHO PLAYS WITH WHOM (stubbed LLM), 2026-11-16.
 *
 * THE INCIDENT (the Vets): "@Match Time generate the teams, put Dan and
 * Craig in separate teams please", twice. The teams extractor could say
 * "together" (pairings) but not "apart", so it returned a plain generate
 * and the two came out on one side. A player's "swap Dan and Kemal" then
 * worked, and the group joked that MatchTime listens to him.
 *
 * Here, with the sim roster's made-up people (Dan Drummer, Felix Fox):
 *
 *   (a) control: seeded so a PLAIN build puts Dan and Felix on one side;
 *   (b) "generate the teams, keep Dan and Felix apart": different sides,
 *       and the reply says so;
 *   (c) "regenerate, put Dan and Felix in separate teams": the same on a
 *       rebuild;
 *   (d) "keep Dan and Felix apart" on teams already out: the fewest swaps
 *       (one: two players change side), sides stay four and four;
 *   (e) together still works: the two strongest, whom a plain build splits,
 *       end up on one side;
 *   (f) "keep Dan and Felix apart" before any teams exist: nothing stored,
 *       and it says to ask with the build.
 *
 * The router and the teams extractor are stubbed (their facts below); the
 * balancer, the apply and the replies are real. The model's reading of
 * the words is the live check's job (scripts/live-check-teams-apart-2026-11-16.ts).
 */
import { test, expect, resetDb } from "../fixtures";
import { createGroup, SimGroup } from "./group";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  resetDb();
});

const teamsFacts = (over: Record<string, unknown>) => ({
  route: "balancer",
  facts: { action: "generate", includeRefs: [], teamNames: [], swaps: [], moves: [], pairings: [], apart: [], swapSides: false, toMatchTime: true, form: [], ...over },
});

// maxPlayers 8: four a side, eight confirmed.
const EIGHT = ["owner", "alice", "pete", "dan", "felix", "greg", "henry", "ivan"].map((key) => ({ key, status: "CONFIRMED" as const }));

async function world(request: Parameters<typeof createGroup>[0], db: Parameters<typeof createGroup>[1], seeds: Record<string, number>) {
  const grp = (await createGroup(request, db, { maxPlayers: 8, attendance: EIGHT, upcomingMatch: { daysFromNow: 0 } })).attach(request);
  // Everyone 5 unless named: the balancer reads the club seed.
  for (const key of EIGHT.map((x) => x.key)) {
    await grp.db.run(`UPDATE "Membership" SET "seedRating" = $1 WHERE "userId" = $2 AND "orgId" = $3`, [seeds[key] ?? 5, grp.player(key).userId, grp.orgId]);
  }
  return grp;
}

async function sides(grp: SimGroup): Promise<Map<string, string>> {
  const rows = await grp.db.all<{ userId: string; team: string }>(`SELECT "userId", team FROM "TeamAssignment" WHERE "matchId" = $1`, [grp.matchId!]);
  return new Map(rows.map((r) => [grp.keyOf(r.userId), r.team]));
}

// Dan 9 and Felix 1 with everyone else on 5: a plain draft puts them on ONE side.
const APART_SEEDS = { dan: 9, felix: 1 };

test("(a) control: a plain build puts Dan and Felix on one side", async ({ request, db }) => {
  const grp = await world(request, db, APART_SEEDS);
  await grp.post("alice", "@Match Time generate the teams", { tag: true, ...teamsFacts({}) });
  const s = await sides(grp);
  expect(s.get("dan")).toBe(s.get("felix"));
});

test("(b) 'generate the teams, keep Dan and Felix apart': different sides, and the reply says so", async ({ request, db }) => {
  const grp = await world(request, db, APART_SEEDS);
  const r = await grp.post("alice", "@Match Time generate the teams, keep Dan and Felix apart", {
    tag: true,
    ...teamsFacts({ apart: [["Dan", "Felix"]] }),
  });
  const s = await sides(grp);
  expect(s.get("dan")).not.toBe(s.get("felix"));
  expect([...s.values()].filter((t) => t === "RED")).toHaveLength(4);
  expect(r.reply ?? "").toContain("Dan Drummer and Felix Fox are on different teams.");
});

test("(c) 'regenerate, put Dan and Felix in separate teams': split on the rebuild", async ({ request, db }) => {
  const grp = await world(request, db, APART_SEEDS);
  await grp.post("alice", "@Match Time generate the teams", { tag: true, ...teamsFacts({}) });
  expect((await sides(grp)).get("dan")).toBe((await sides(grp)).get("felix"));
  const r = await grp.post("alice", "@Match Time regenerate the teams, put Dan and Felix in separate teams please", {
    tag: true,
    ...teamsFacts({ apart: [["Dan", "Felix"]] }),
  });
  const s = await sides(grp);
  expect(s.get("dan")).not.toBe(s.get("felix"));
  expect(r.reply ?? "").toContain("Dan Drummer and Felix Fox are on different teams.");
});

test("(d) 'keep Dan and Felix apart' on teams already out: one swap, nothing rebuilt", async ({ request, db }) => {
  const grp = await world(request, db, APART_SEEDS);
  await grp.post("alice", "@Match Time generate the teams", { tag: true, ...teamsFacts({}) });
  const before = await sides(grp);
  expect(before.get("dan")).toBe(before.get("felix"));

  const r = await grp.post("pete", "@Match Time keep Dan and Felix apart", {
    tag: true,
    ...teamsFacts({ action: "swap", apart: [["Dan", "Felix"]] }),
  });
  const after = await sides(grp);
  expect(after.get("dan")).not.toBe(after.get("felix"));
  const changed = [...after].filter(([k, t]) => before.get(k) !== t).map(([k]) => k);
  // The fewest swaps: one, so exactly two players changed side.
  expect(changed).toHaveLength(2);
  expect([...after.values()].filter((t) => t === "RED")).toHaveLength(4);
  const reply = r.reply ?? "";
  expect(reply).toMatch(/^🔁 Swapped \*.+\* and \*.+\*, nobody dropped\.\nDan Drummer and Felix Fox are on different teams\.\n\nUpdated teams:/);
});

test("(e) together still works: the two strongest, whom a plain build splits, share a side", async ({ request, db }) => {
  const grp = await world(request, db, { dan: 9, felix: 8.9 });
  await grp.post("alice", "@Match Time generate the teams", { tag: true, ...teamsFacts({}) });
  const plain = await sides(grp);
  expect(plain.get("dan")).not.toBe(plain.get("felix"));

  const r = await grp.post("alice", "@Match Time regenerate the teams, put Dan and Felix on the same team", {
    tag: true,
    ...teamsFacts({ pairings: [["Dan", "Felix"]] }),
  });
  const s = await sides(grp);
  expect(s.get("dan")).toBe(s.get("felix"));
  expect(r.reply ?? "").toContain("Dan Drummer and Felix Fox are on the same team.");
});

test("(f) 'keep Dan and Felix apart' before the teams exist: nothing stored, and it says how to ask", async ({ request, db }) => {
  const grp = await world(request, db, APART_SEEDS);
  const r = await grp.post("pete", "@Match Time keep Dan and Felix apart", {
    tag: true,
    ...teamsFacts({ action: "swap", apart: [["Dan", "Felix"]] }),
  });
  expect((await sides(grp)).size).toBe(0);
  expect(r.reply ?? "").toContain("The teams aren't made yet.");
});

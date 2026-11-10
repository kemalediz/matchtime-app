/**
 * Group-simulator scenario: A FORM NOTE SAYS ITS AMOUNT, AND CAN BE CHANGED
 * (Kemal, 2026-11-10, stubbed LLM).
 *
 *   "it would be nice if it tells explicitly how much rating adjustment it
 *    made (not giving the final rating) so if i don't like it, i can get it
 *    amended further"
 *
 * Through the real analyze route and Postgres, with the router and the
 * teams extractor stubbed (who-is-who is the stub picker): a player's note
 * is stored with its amount and said; a reply to MatchTime changes it; a
 * tagged cancel stores no adjustment; an organiser sets another player's;
 * a player talking about another player is acknowledged and nothing is
 * stored; Turkish; and when the teams are made the stored amount is the
 * one the RatingAdjustment row records. No model is called.
 */
import { test, expect, resetDb } from "../fixtures";
import { createGroup, type SimGroup } from "./group";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  resetDb();
});

const form = (entries: Array<{ personRef: string; delta: number; reason: string }>) => ({
  route: "balancer",
  facts: {
    action: "form",
    includeRefs: [],
    teamNames: [],
    swaps: [],
    moves: [],
    pairings: [],
    swapSides: false,
    toMatchTime: true,
    form: entries,
  },
});

async function noteOf(g: SimGroup, key: string) {
  return g.db.one<{ delta: number; reason: string; setByUserId: string | null }>(
    `SELECT delta, reason, "setByUserId" FROM "FormNote" WHERE "matchId" = $1 AND "userId" = $2`,
    [g.matchId!, g.player(key).userId],
  );
}

async function noteCount(g: SimGroup): Promise<number> {
  return g.db.count(`SELECT COUNT(*) FROM "FormNote" WHERE "matchId" = $1`, [g.matchId!]);
}

const DAY = /(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)/.source;

test("a player's note: the amount stored and said, changed in a reply, cancelled with a tag", async ({ request, db }) => {
  const g = (await createGroup(request, db, { maxPlayers: 8 })).attach(request);

  const tired = "@Match Time reduce my strength for this match, I'm quite tired";
  const r1 = await g.post("pete", tired, { ...form([{ personRef: "me", delta: -0.5, reason: "tired" }]), tag: true });
  expect(r1.intent).toBe("form_note");
  expect(r1.reply).toMatch(new RegExp(`^Noted: -0\\.5 for Pete Power \\(tired\\) in ${DAY}'s game\\. Want a different amount\\? Tag me, e\\.g\\. make it -1\\.$`));
  expect(r1.reply).not.toMatch(/rating of|\b\d+\.\d\/10\b/);
  expect(await noteOf(g, "pete")).toEqual({ delta: -0.5, reason: "tired", setByUserId: g.player("pete").userId });

  // A WhatsApp reply to MatchTime's line, untagged: addresses MatchTime.
  const amend = await g.postBatch([
    {
      player: "pete",
      body: "make it -1",
      ...form([{ personRef: "Pete", delta: -1, reason: "" }]),
      quote: { id: "mt-line-1", text: r1.reply!, fromMatchTime: true },
    },
  ]);
  expect(amend.results[0].reply).toMatch(new RegExp(`^Changed: -1 for Pete Power \\(tired\\) in ${DAY}'s game\\.$`));
  expect(await noteOf(g, "pete")).toMatchObject({ delta: -1, reason: "tired" });

  const cancel = await g.post("pete", "@Match Time cancel my adjustment", { ...form([{ personRef: "me", delta: 0, reason: "" }]), tag: true });
  expect(cancel.reply).toMatch(new RegExp(`^Changed: no adjustment for Pete Power in ${DAY}'s game\\.$`));
  expect(await noteOf(g, "pete")).toMatchObject({ delta: 0 });
  expect(await noteCount(g)).toBe(1);
});

test("an organiser sets another player's; a player about another player is only acknowledged", async ({ request, db }) => {
  const g = (await createGroup(request, db, { maxPlayers: 8 })).attach(request);

  const knee = "@Match Time Dan has a bad knee, -1 for him";
  const byAdmin = await g.post("alice", knee, { ...form([{ personRef: "Dan", delta: -1, reason: "bad knee" }]), tag: true });
  expect(byAdmin.reply).toMatch(new RegExp(`^Noted: -1 for Dan Drummer \\(bad knee\\) in ${DAY}'s game\\.`));
  expect(await noteOf(g, "dan")).toEqual({ delta: -1, reason: "bad knee", setByUserId: g.player("alice").userId });

  const hamstring = "@Match Time Felix pulled his hamstring, bear it in mind";
  const byPlayer = await g.post("pete", hamstring, { ...form([{ personRef: "Felix", delta: -1, reason: "hamstring" }]), tag: true });
  expect(byPlayer.reply).toBe("Noted: I'll take it into account when the teams are made, for this match only.");
  expect(await noteOf(g, "felix")).toBeNull();

  // A player cannot change somebody else's amount either.
  await g.post("pete", "@Match Time make Dan's +1", { ...form([{ personRef: "Dan", delta: 1, reason: "" }]), tag: true });
  expect(await noteOf(g, "dan")).toMatchObject({ delta: -1 });
});

test("in Turkish, with the teams already made: the amount, and that it counts if they are made again", async ({ request, db }) => {
  const g = (await createGroup(request, db, { maxPlayers: 8, teams: { pete: "RED", dan: "YELLOW" } })).attach(request);
  await db.run(`UPDATE "Organisation" SET language = 'tr' WHERE id = $1`, [g.orgId]);

  const r = await g.post("pete", "@Match Time bugün çok yorgunum, bu maç için puanımı düşür", {
    ...form([{ personRef: "me", delta: -0.5, reason: "yorgun" }]),
    tag: true,
  });
  expect(r.reply).toMatch(
    /^Not aldım: \S+ maçında Pete Power için -0,5 \(yorgun\)\. Takımlar zaten kuruldu; yeniden kurulursa geçerli olur\. Farklı bir miktar mı istersiniz\? Beni etiketleyip yazın, örneğin "-1 yap"\.$/,
  );
  expect(await noteOf(g, "pete")).toMatchObject({ delta: -0.5 });
});

test("when the teams are made, the stored amount is the one used and recorded", async ({ request, db }) => {
  const keys = ["owner", "alice", "pete", "dan", "felix", "greg", "henry", "ivan"];
  const g = (
    await createGroup(request, db, {
      maxPlayers: 8,
      attendance: keys.map((key) => ({ key, status: "CONFIRMED" as const })),
      // Teams are built only on match day (2026-09-29).
      upcomingMatch: { daysFromNow: 0 },
    })
  ).attach(request);

  await g.post("pete", "@Match Time I'm ill, go easy on me", { ...form([{ personRef: "me", delta: -1, reason: "ill" }]), tag: true });
  const gen = await g.post("alice", "@Match Time generate the teams", {
    route: "balancer",
    facts: { action: "generate", includeRefs: [], teamNames: null, swaps: [], pairings: [] },
    tag: true,
  });
  expect(gen.intent).toBe("generate_teams_request");
  const adj = await db.one<{ delta: number; reason: string; confidence: number }>(
    `SELECT delta, reason, confidence FROM "RatingAdjustment" WHERE "matchId" = $1 AND "userId" = $2`,
    [g.matchId!, g.player("pete").userId],
  );
  expect(adj).toEqual({ delta: -1, reason: "Form note in the chat: ill", confidence: 1 });
});

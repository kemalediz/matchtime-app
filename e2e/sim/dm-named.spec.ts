/**
 * Group-simulator scenario: "@Match Time DM these people" (Vets MNF,
 * 2026-11-09).
 *
 * A member tags a few people ("@BH @+44 7747 410069 @Matt ... Any of you
 * boys fancy it?"); the owner answers, quoting it, "@Match Time DM these
 * people", or says "@Match Time DM the people above". MatchTime DMs each
 * tagged person it already knows the club's usual invite for the next game,
 * and says in the group who it could not message.
 *
 * Stubbed: the router says admin_ops and the admin extractor says recruit
 * from `playersFrom: ["named"]`, which IS the classification under test;
 * whether the real model says so is `scripts/live-check-dm-named.ts`.
 * Everything after is the shipped code: the mentions remembered from the
 * Pi's structured data (`group-mentions.ts`), the engine's admin and tag
 * gates, the batch-final pass, `dmNamedPeople` and `inviteNamedPeople`,
 * the BotJob queue and the one reply. Nothing reads a name out of words.
 */
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import type { TestDb } from "../helpers/test-db";
import { createGroup, type SimGroup, type SimPlayer } from "./group";

const DM_NAMED_FACTS = {
  action: "recruit",
  payerRef: "",
  count: 0,
  coveredRefs: [],
  undo: false,
  matchDay: "",
  phrase: "",
  note: "",
  lookbackMatches: 0,
  playersFrom: ["named"],
  clubRef: "",
  toMatchTime: true,
};
const ask = (body: string) => ({ route: "admin_ops", facts: DM_NAMED_FACTS, tag: true, body });

/** A stranger's number: no User has it. */
const UNKNOWN_PHONE = "447000000999";
let lidSeq = 0;
/** How the Pi forwards a tag of a club member under Baileys: a LID, with
 *  the phone WhatsApp gave it and the person's own WhatsApp name. */
const lidTag = (p: SimPlayer) => ({ jid: `${90000000000000 + ++lidSeq}@lid`, name: p.name.split(" ")[0], phone: p.phone!.replace(/^\+/, "") });
/** A tag of a phone-addressed member: the JID is the number. */
const phoneTag = (p: SimPlayer) => ({ jid: `${p.phone!.replace(/^\+/, "")}@s.whatsapp.net`, name: p.name });
const strangerTag = { jid: `${UNKNOWN_PHONE}@s.whatsapp.net` };

test.describe.configure({ mode: "serial" });
test.beforeAll(() => resetDb());
test.afterAll(() => resetDb());

/** A fresh club each test: 8 players a game, Oscar and Alice in, 6 places open. */
const club = (request: APIRequestContext, db: TestDb) =>
  createGroup(request, db, {
    maxPlayers: 8,
    attendance: [
      { key: "owner", status: "CONFIRMED" },
      { key: "alice", status: "CONFIRMED" },
    ],
  });

const phoneOf = (g: SimGroup, key: string) => g.player(key).phone!.replace(/^\+/, "");
const invites = (g: SimGroup) =>
  g.db.all<{ phone: string | null; text: string }>(`SELECT phone, text FROM "BotJob" WHERE "orgId" = $1 AND kind = 'dm' ORDER BY "createdAt"`, [g.orgId]);

test("a reply quoting the tagged message: the known people get the club's invite, the stranger is named, not messaged", async ({ request, db }) => {
  const g = await club(request, db);
  const SHANE = "@Dan @Felix @+44 7000 000999 Any of you boys fancy it?";
  await g.postBatch([{ player: "pete", body: SHANE, route: "none", waMessageId: "sim-shane-quoted", mentions: [lidTag(g.player("dan")), phoneTag(g.player("felix")), strangerTag] }]);

  const r = await g.postBatch([{ player: "owner", ...ask("@Match Time DM these people"), quote: { id: "sim-shane-quoted", text: SHANE } }]);
  const reply = r.results[0].reply ?? "";
  expect(reply).toContain("✅ Done. I've sent the invite for");
  // Named as the DMs greet them: the WhatsApp name each tag carried (Kemal,
  // 2026-11-09), "Dan" from the LID tag, "Felix Fox" from the phone tag.
  expect(reply).toContain("Dan and Felix Fox");
  expect(reply).toContain(`I can't message numbers I don't know yet, so I didn't message +${UNKNOWN_PHONE}.`);
  expect(r.results[0].react).toBe("✅");

  const dms = await invites(g);
  expect(dms.map((d) => d.phone).sort()).toEqual([phoneOf(g, "dan"), phoneOf(g, "felix")].sort());
  expect(dms.map((d) => d.phone)).not.toContain(UNKNOWN_PHONE);
  for (const d of dms) {
    // The club's usual invite, the same one the recruit blast sends.
    expect(d.text).toContain("putting the squad together");
    expect(d.text).toContain("6 spots left");
    expect(d.text).toContain("reply *IN*");
    // 2026-11-09: who is asking (the club); no stop line for now.
    expect(d.text).toMatch(/^👋 (Dan|Felix), it's \*[^*]+\* here/);
    expect(d.text).not.toContain("STOP");
  }

  // Asked again: nobody gets the same game's invite twice.
  const again = await g.postBatch([{ player: "owner", ...ask("@Match Time DM them"), quote: { id: "sim-shane-quoted", text: SHANE } }]);
  expect(again.dms).toEqual([]);
  expect(again.results[0].reply).toContain("Dan and Felix Fox already had the invite.");
});

test("\"DM the people above\", the tagged message in an earlier flush", async ({ request, db }) => {
  const g = await club(request, db);
  await g.postBatch([{ player: "pete", body: "@Greg @Henry fancy a game tonight?", route: "none", mentions: [lidTag(g.player("greg")), lidTag(g.player("henry"))] }]);
  // A message in between that tags nobody does not hide it.
  await g.postBatch([{ player: "ivan", body: "lovely weather for it", route: "none" }]);
  const r = await g.postBatch([{ player: "owner", ...ask("@Match Time DM the people above") }]);
  expect(r.dms.map((d) => d.phone).sort()).toEqual([phoneOf(g, "greg"), phoneOf(g, "henry")].sort());
  expect(r.results[0].reply).toContain("Greg and Henry");
});

test("\"DM the people above\" in the same flush as the tagged message", async ({ request, db }) => {
  const g = await club(request, db);
  const r = await g.postBatch([
    { player: "pete", body: "@Ivan you free?", route: "none", mentions: [lidTag(g.player("ivan"))] },
    { player: "owner", ...ask("@Match Time DM the people above") },
  ]);
  expect(r.dms.map((d) => d.phone)).toEqual([phoneOf(g, "ivan")]);
  expect(r.results[1].reply).toContain("to Ivan.");
});

test("the request tags someone the Pi could not name: never the people above, and the group is told (review #1)", async ({ request, db }) => {
  const g = await club(request, db);
  await g.postBatch([{ player: "pete", body: "@Greg happy birthday mate", route: "none", mentions: [lidTag(g.player("greg"))] }]);
  const r = await g.postBatch([{ player: "owner", ...ask("@Match Time DM @88877766655544"), mentions: [{ jid: "88877766655544@lid" }] }]);
  expect(r.dms).toEqual([]);
  expect(r.results[0].reply).toBe("I couldn't tell who 1 of the people tagged is, so I didn't message them.");
});

test("a member who turned invites off in another club is left out too; the reply says whose message it was (review #2, #5)", async ({ request, db }) => {
  const g = await club(request, db);
  const other = await createGroup(request, db, { name: "Another club", upcomingMatch: false, players: [{ key: "x", name: "X Owner", role: "OWNER" }] });
  await db.run(
    `INSERT INTO "Membership" (id, "userId", "orgId", role, "subMatchInviteDm") VALUES ($1, $2, $3, 'PLAYER', false)`,
    [`sim-mem-${Date.now()}`, g.player("liam").userId, other.orgId],
  );
  await g.postBatch([{ player: "pete", body: "@Liam @Mike can you play?", route: "none", mentions: [lidTag(g.player("liam")), lidTag(g.player("mike"))] }]);
  const r = await g.postBatch([{ player: "owner", ...ask("@Match Time DM the people above") }]);
  expect(r.dms.map((d) => d.phone)).toEqual([phoneOf(g, "mike")]);
  expect(r.results[0].reply?.split("\n")[0]).toBe("📨 From Pete Power's message:");
  expect(r.results[0].reply).toContain("Liam doesn't get invites by message");
});

test("a member who turned invites off is left out and named", async ({ request, db }) => {
  const g = await club(request, db);
  await db.run(`UPDATE "Membership" SET "subMatchInviteDm" = false WHERE "orgId" = $1 AND "userId" = $2`, [g.orgId, g.player("jake").userId]);
  await g.postBatch([{ player: "pete", body: "@Jake @Kyle can you play?", route: "none", mentions: [lidTag(g.player("jake")), lidTag(g.player("kyle"))] }]);
  const r = await g.postBatch([{ player: "owner", ...ask("@Match Time DM the people above") }]);
  expect(r.dms.map((d) => d.phone)).toEqual([phoneOf(g, "kyle")]);
  expect(r.results[0].reply).toContain("Jake doesn't get invites by message, so I left them out.");
});

test("at most ten DMs in one request; the rest are named", async ({ request, db }) => {
  const g = await club(request, db);
  const keys = ["brian", "pete", "dan", "felix", "greg", "henry", "ivan", "jake", "kyle", "liam", "mike", "noah"];
  await g.postBatch([{ player: "quinn", body: "everyone fancy it?", route: "none", mentions: keys.map((k) => lidTag(g.player(k))) }]);
  const r = await g.postBatch([{ player: "owner", ...ask("@Match Time DM the people above") }]);
  expect(r.dms).toHaveLength(10);
  expect(r.results[0].reply).toContain("I message at most 10 people at a time, so I left out Mike and Noah.");
});

test("nobody tagged in the quoted message: says so, DMs nobody", async ({ request, db }) => {
  const g = await club(request, db);
  await g.postBatch([{ player: "pete", body: "anyone know a good physio?", route: "none", waMessageId: "sim-no-tags" }]);
  const r = await g.postBatch([{ player: "owner", ...ask("@Match Time DM them"), quote: { id: "sim-no-tags", text: "anyone know a good physio?" } }]);
  expect(r.dms).toEqual([]);
  expect(r.results[0].reply).toBe("I couldn't see anyone tagged in that message, so I haven't messaged anyone.");
});

test("a player who is not an admin: nobody DM'd", async ({ request, db }) => {
  const g = await club(request, db);
  await g.postBatch([{ player: "liam", body: "@Mike you in?", route: "none", mentions: [lidTag(g.player("mike"))] }]);
  const r = await g.postBatch([{ player: "pete", ...ask("@Match Time DM the people above") }]);
  expect(r.dms).toEqual([]);
  expect(r.results[0].reply ?? "").not.toContain("sent the invite");
});

test("the owner, untagged: nobody DM'd", async ({ request, db }) => {
  const g = await club(request, db);
  await g.postBatch([{ player: "liam", body: "@Noah you in?", route: "none", mentions: [lidTag(g.player("noah"))] }]);
  const r = await g.postBatch([{ player: "owner", route: "admin_ops", facts: DM_NAMED_FACTS, tag: false, body: "DM the people above" }]);
  expect(r.dms).toEqual([]);
});

/**
 * Group-simulator scenario: a player in a PARTNER club's group volunteers
 * for the ask by REPLYING "IN" to MatchTime's ask post (Kemal, 2026-11-16).
 *
 * Four real asks drew nobody through the tap-to-DM link alone, while
 * players do answer a short ask in the group. The new post says "Reply IN
 * to this message, or tap the link". A reply is routed to the ask by the
 * post it QUOTES, a fact WhatsApp gives us (`quotedPartnerAsk`,
 * pipeline/engine.ts), never by its words: the router and the attendance
 * extractor read "IN" exactly as they always do (stubbed here with what the
 * model says, $0). From there it is the link's path: the one volunteer
 * writer (`handlePartnerVolunteer`), the same rules, the same private DM,
 * and nothing more in the partner's group.
 *
 *   1. a reply IN to the ask: on the asking club's game, told by DM, the
 *      group hears nothing, nothing on his own club's game;
 *   2. the same IN NOT replying to the ask: his own club's game, as ever;
 *   3. a reply IN to an ask that has closed: the link path's "place has
 *      gone" DM, nothing written, the group hears nothing;
 *   4. a reply from somebody MatchTime cannot identify: what the link path
 *      does with an unknown sender, nothing written and nothing said;
 *   5. a newcomer to the group (a number not on the roster) is the club's
 *      member by the group's own rule, so he volunteers like anyone else.
 *
 * Made-up people, 07700 900xxx numbers only, no live model.
 */
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import type { TestDb } from "../helpers/test-db";
import { selfIn } from "../helpers/stub";
import { createGroup, type SimGroup } from "./group";

test.describe.configure({ mode: "serial" });

test.beforeAll(() => {
  resetDb();
});
test.afterAll(() => {
  resetDb();
});

let seq = 0;

interface World {
  asker: SimGroup;
  partner: SimGroup;
  askId: string;
  /** The ask post's bare WhatsApp id, as a reply quotes it. */
  postId: string;
  postText: string;
}

/** The asking club (first come, no HQ) and its partner, with one ask posted
 *  in the partner's group two hours ago. The partner's own game is two
 *  days after the asking club's, so nobody's own game overlaps. */
async function world(request: APIRequestContext, db: TestDb, opts: { status?: "posted" | "filled" } = {}): Promise<World> {
  const n = ++seq;
  const asker = await createGroup(request, db, {
    name: "Friday Night Football",
    maxPlayers: 8,
    attendance: [
      { key: "owner", status: "CONFIRMED" },
      { key: "alice", status: "CONFIRMED" },
    ],
  });
  const partner = await createGroup(request, db, {
    name: "Monday Vets",
    upcomingMatch: { daysFromNow: 4 },
    players: [
      { key: "owner", name: "Fiona Founder", role: "OWNER" },
      { key: "ali", name: "Ali Kaya" },
      { key: "ben", name: "Ben Ortega" },
      { key: "cem", name: "Cem Yilmaz" },
      { key: "dan", name: "Dan Price" },
    ],
  });
  await db.run(`UPDATE "Organisation" SET "quietHoursEnabled" = false WHERE id = ANY($1)`, [[asker.orgId, partner.orgId]]);
  const pairId = `sim-xr-pair-${n}`;
  const askId = `sim-xr-ask-${n}`;
  const postId = `3EB0XREPLY${n}`;
  await db.run(
    `INSERT INTO "ClubPartnership" (id,"askerOrgId","partnerOrgId",status,"askerAcceptedAt","partnerAcceptedAt","createdByUserId","createdAt","updatedAt")
     VALUES ($1,$2,$3,'active',now(),now(),$4,now(),now())`,
    [pairId, asker.orgId, partner.orgId, asker.player("owner").userId],
  );
  const kickoff = (await db.one<{ date: Date }>(`SELECT date FROM "Match" WHERE id = $1`, [asker.matchId]))!.date;
  const status = opts.status ?? "posted";
  await db.run(
    `INSERT INTO "PartnerAsk" (id,"partnershipId","askerOrgId","partnerOrgId","matchId",places,status,"requestedVia","postedAt","postWaMessageId","postBy","closesAt","closedAt","createdAt","updatedAt")
     VALUES ($1,$2,$3,$4,$5,2,$9,'button',now() - interval '2 hours',$6,$7,$8,$10,now(),now())`,
    [
      askId,
      pairId,
      asker.orgId,
      partner.orgId,
      asker.matchId,
      // MatchTime's own post is acknowledged with the serialised key.
      `true_${partner.groupId}_${postId}`,
      new Date(kickoff.getTime() - 4 * 3600_000),
      kickoff,
      status,
      status === "posted" ? null : new Date(),
    ],
  );
  await asker.drainOutbound();
  await partner.drainOutbound();
  const postText = [
    "⚽ *Friday Night Football* are *2 short* for Tuesday!",
    "🗓 Tue 17 Nov, 20:00",
    "📍 Sim Venue, 7-a-side",
    "🙋 Fancy it? Reply *IN* to this message, or tap 👉 https://wa.me/447700900555?text=IN",
    "🔒 MatchTime confirms with you by DM. Your number stays private.",
  ].join("\n");
  return { asker: asker.attach(request), partner: partner.attach(request), askId, postId, postText };
}

const rowOf = async (db: TestDb, matchId: string | null, userId: string) =>
  (await db.one<{ status: string }>(`SELECT status FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`, [matchId, userId]))?.status ?? null;
const volunteersOf = async (db: TestDb, askId: string) =>
  (await db.one<{ v: string[] }>(`SELECT "volunteerUserIds" AS v FROM "PartnerAsk" WHERE id = $1`, [askId]))?.v ?? [];
const digits = (phone: string | null) => (phone ?? "").replace(/^\+/, "");

test("a partner-group player REPLIES IN to the ask: on the asking club's game, told by DM, the group hears nothing", async ({ request, db }) => {
  const w = await world(request, db);
  const ali = w.partner.player("ali");
  const r = await w.partner.postBatch([
    { player: "ali", body: "IN", route: "self_att", facts: selfIn(), quote: { id: w.postId, text: w.postText, fromMatchTime: true } },
  ]);

  // The link path's write: the asking club's game, the volunteer on the ask.
  expect(await rowOf(db, w.asker.matchId, ali.userId)).toBe("CONFIRMED");
  expect(await volunteersOf(db, w.askId)).toEqual([ali.userId]);
  // Nothing on his own club's game.
  expect(await rowOf(db, w.partner.matchId, ali.userId)).toBeNull();
  // The link path's answer: ONE private DM to the number he wrote from.
  expect(r.dms).toEqual([{ phone: digits(ali.phone), text: expect.stringMatching(/^✅ Thanks Ali, you're in for \*Friday Night Football\*: /) }]);
  // And no noise in his group: no reply, no post, no reaction (the DM went).
  expect(r.results[0]).toMatchObject({ intent: "partner_volunteer", reply: null, react: null });
  expect(r.groupPosts).toEqual([]);
  // The asking club hears about its guest, as for a volunteer by link.
  const told = await w.asker.drainOutbound();
  expect(told.groupPosts).toEqual([expect.stringMatching(/^🙋 Ali K from Monday Vets has joined the squad for /)]);
});

test("the same IN NOT replying to the ask is for his own club's game, exactly as before", async ({ request, db }) => {
  const w = await world(request, db);
  const ben = w.partner.player("ben");
  const r = await w.partner.postBatch([{ player: "ben", body: "IN", route: "self_att", facts: selfIn() }]);
  expect(await rowOf(db, w.partner.matchId, ben.userId)).toBe("CONFIRMED");
  expect(await rowOf(db, w.asker.matchId, ben.userId)).toBeNull();
  expect(await volunteersOf(db, w.askId)).toEqual([]);
  expect(r.results[0].intent).not.toBe("partner_volunteer");
  // No volunteer DM: nothing names the asking club.
  expect(r.dms.filter((d) => d.text.includes("Friday Night Football"))).toEqual([]);
});

test("a reply IN to an ask that has closed: the link path's 'place has gone' DM, nothing written, the group hears nothing", async ({ request, db }) => {
  const w = await world(request, db, { status: "filled" });
  const cem = w.partner.player("cem");
  const r = await w.partner.postBatch([
    { player: "cem", body: "IN", route: "self_att", facts: selfIn(), quote: { id: w.postId, text: w.postText, fromMatchTime: true } },
  ]);
  expect(r.dms).toEqual([{ phone: digits(cem.phone), text: "*Friday Night Football*'s place has gone now, thanks for offering." }]);
  expect(await rowOf(db, w.asker.matchId, cem.userId)).toBeNull();
  expect(await rowOf(db, w.partner.matchId, cem.userId)).toBeNull();
  expect(await volunteersOf(db, w.askId)).toEqual([]);
  expect(r.results[0]).toMatchObject({ reply: null, react: null });
  expect(r.groupPosts).toEqual([]);
});

test("a reply from somebody MatchTime cannot identify: as the link path's unknown sender, nothing written and nothing said", async ({ request, db }) => {
  const w = await world(request, db);
  // No number (a privacy-hidden sender) and no WhatsApp name: nobody to
  // place and nobody to provision (`resolve-sender.ts`). The link path
  // ignores a sender it cannot identify in the same way.
  const r = await w.partner.postBatch([
    { author: { name: null, phone: "" }, body: "IN", route: "self_att", facts: selfIn(), quote: { id: w.postId, text: w.postText, fromMatchTime: true } },
  ]);
  expect(await volunteersOf(db, w.askId)).toEqual([]);
  expect(Number((await db.one<{ n: string }>(`SELECT count(*)::text AS n FROM "Attendance" WHERE "matchId" = $1`, [w.asker.matchId]))?.n)).toBe(2);
  expect(r.dms).toEqual([]);
  expect(r.groupPosts).toEqual([]);
  expect(r.results[0]).toMatchObject({ reply: null });
  expect((await w.asker.drainOutbound()).groupPosts).toEqual([]);
});

test("a newcomer to the group (a number not on the roster) is the club's member by the group's own rule, and volunteers like anyone else", async ({ request, db }) => {
  const w = await world(request, db);
  const r = await w.partner.postBatch([
    { author: { name: "Nina Newcomer", phone: "447700900951" }, body: "IN", route: "self_att", facts: selfIn(), quote: { id: w.postId, text: w.postText, fromMatchTime: true } },
  ]);
  const nina = await db.one<{ id: string }>(`SELECT id FROM "User" WHERE "phoneNumber" = '+447700900951'`);
  expect(nina).toBeTruthy();
  expect(await volunteersOf(db, w.askId)).toEqual([nina!.id]);
  expect(await rowOf(db, w.asker.matchId, nina!.id)).toBe("CONFIRMED");
  expect(await rowOf(db, w.partner.matchId, nina!.id)).toBeNull();
  expect(r.dms).toEqual([{ phone: "447700900951", text: expect.stringMatching(/^✅ Thanks Nina, you're in for \*Friday Night Football\*: /) }]);
  expect(r.groupPosts).toEqual([]);
});

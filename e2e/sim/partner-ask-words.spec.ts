/**
 * Group-simulator scenario: an organiser asks the PARTNER CLUBS for a
 * player in their own words, tagged in the players' group (cross-club
 * ask, slice S6, 2026-10-21).
 *
 *   "@Match Time ask Sutton if anyone can play"   one partner, by name
 *   "@Match Time search for players from our partner groups"
 *                                                 EVERY active partner
 *
 * Stubbed: the router says admin_ops and the admin extractor says
 * `recruit` with `partnerClubs` (and `clubRef` when a club is named), which
 * IS the classification under test; whether the real model reports it is
 * `scripts/live-check-partner-ask-words.ts`. Everything after is the
 * shipped code: the engine's admin and tag gates, the batch-final pass,
 * `askPartnersFromWords`, `requestPartnerAsk` with its rules, the partner
 * organisers' approval notice and the one reply in the group.
 */
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import type { TestDb } from "../helpers/test-db";
import { createGroup, SimGroup } from "./group";

const ASK_SUTTON = "@Match Time ask Sutton if anyone can play";
const ASK_ALL = "@Match Time search for players from our partner groups";
const UNTAGGED = "ask Sutton if anyone can play";

const recruitFromPartners = (clubRef: string) => ({
  route: "admin_ops",
  facts: {
    action: "recruit",
    payerRef: "",
    count: 0,
    coveredRefs: [],
    undo: false,
    matchDay: "",
    phrase: "",
    note: "",
    lookbackMatches: 0,
    partnerClubs: true,
    clubRef,
  },
});

test.describe.configure({ mode: "serial" });

test.beforeAll(() => {
  resetDb();
});
test.afterAll(() => {
  resetDb();
});

let asker: SimGroup;
let sutton: SimGroup;
let vets: SimGroup;

async function world(request: APIRequestContext, db: TestDb) {
  if (!asker) {
    asker = await createGroup(request, db, {
      name: "Friday Night Football",
      maxPlayers: 8,
      attendance: [
        { key: "owner", status: "CONFIRMED" },
        { key: "alice", status: "CONFIRMED" },
      ],
    });
    sutton = await createGroup(request, db, { name: "Sutton FC", upcomingMatch: false });
    vets = await createGroup(request, db, { name: "MT Vets", upcomingMatch: false });
  }
  return asker.attach(request);
}

async function pair(db: TestDb, partner: SimGroup, id: string) {
  await db.run(
    `INSERT INTO "ClubPartnership" (id,"askerOrgId","partnerOrgId",status,"askerAcceptedAt","partnerAcceptedAt","createdByUserId","createdAt","updatedAt")
     VALUES ($1,$2,$3,'active',now(),now(),$4,now(),now())`,
    [id, asker.orgId, partner.orgId, asker.player("owner").userId],
  );
}

const asks = (db: TestDb) =>
  db.all<{ partnerOrgId: string; status: string; requestedVia: string; requestedByUserId: string | null }>(
    `SELECT "partnerOrgId", status, "requestedVia", "requestedByUserId" FROM "PartnerAsk" WHERE "askerOrgId" = $1 ORDER BY "createdAt"`,
    [asker.orgId],
  );

test("no partner club yet: one plain reply, nothing asked, nobody DM'd", async ({ request, db }) => {
  const g = await world(request, db);
  await db.run(`UPDATE "Organisation" SET "partnerAskWhen" = 'on-request' WHERE id = $1`, [g.orgId]);
  const r = await g.post("owner", ASK_SUTTON, { ...recruitFromPartners("Sutton"), tag: true });
  expect(r.reply).toBe(
    "You have no partner clubs yet, so I can't ask another club. When MatchTime pairs you with one, both clubs accept it in Settings, under Partner clubs.",
  );
  expect(await asks(db)).toHaveLength(0);
  expect(await g.botJobs("dm")).toHaveLength(0);
});

test("a named partner: that partner only, its organisers asked, one reply in the group", async ({ request, db }) => {
  const g = await world(request, db);
  await pair(db, sutton, "sim-xw-sutton");
  await pair(db, vets, "sim-xw-vets");
  const r = await g.post("owner", ASK_SUTTON, { ...recruitFromPartners("Sutton"), tag: true });
  expect(r.reply).toBe(
    // P4 (2026-10-22): a words ask asks for every open place, and says how many.
    "I've asked *Sutton FC*'s organisers. Once they say yes, I'll post in their group, and anyone who replies IN goes on your bench.\nI asked for 6 players.",
  );
  const rows = await asks(db);
  expect(rows).toEqual([
    { partnerOrgId: sutton.orgId, status: "awaiting-approval", requestedVia: "group", requestedByUserId: g.player("owner").userId },
  ]);
  // Never the club's own recruit blast.
  expect((await g.botJobs("dm")).filter((j) => /reply \*IN\*/.test(j.text))).toHaveLength(0);
  // Sutton's organisers were asked to approve (their own channel).
  const notice = await db.all<{ text: string }>(`SELECT text FROM "BotJob" WHERE "orgId" = $1 AND kind = 'dm'`, [sutton.orgId]);
  expect(notice.some((n) => /Friday Night Football/.test(n.text))).toBe(true);
});

test("untagged, the same words do nothing: the tag rules are unchanged", async ({ request, db }) => {
  const g = await world(request, db);
  const r = await g.post("owner", UNTAGGED, recruitFromPartners("Sutton"));
  expect(r.reply ?? "").toBe("");
  expect(await asks(db)).toHaveLength(1);
});

test("a player who is not an admin: nothing asked", async ({ request, db }) => {
  const g = await world(request, db);
  const r = await g.post("pete", ASK_ALL, { ...recruitFromPartners(""), tag: true });
  expect(r.reply ?? "").toBe("");
  expect(await asks(db)).toHaveLength(1);
});

test("no club named: EVERY active partner is asked, and one reply says what happened with each", async ({ request, db }) => {
  const g = await world(request, db);
  const r = await g.post("owner", ASK_ALL, { ...recruitFromPartners(""), tag: true });
  expect(r.reply).toBe(
    [
      "I've asked your partner clubs:",
      "• *Sutton FC*: an ask to them is already open for this game.",
      "• *MT Vets*: waiting for their organisers to say yes.",
      "Anyone who replies IN goes on your bench.",
      "I asked for 6 players.",
    ].join("\n"),
  );
  const rows = await asks(db);
  expect(rows.map((x) => [x.partnerOrgId, x.requestedVia])).toEqual([
    [sutton.orgId, "group"],
    [vets.orgId, "group"],
  ]);
});

test("asking switched off: one plain reply, nothing more asked", async ({ request, db }) => {
  const g = await world(request, db);
  await db.run(`UPDATE "Organisation" SET "partnerAskWhen" = 'off' WHERE id = $1`, [g.orgId]);
  const r = await g.post("owner", ASK_ALL, { ...recruitFromPartners(""), tag: true });
  expect(r.reply).toBe("Asking partner clubs for players is off. An owner or admin can turn it on in Settings, under Partner clubs.");
  expect(await asks(db)).toHaveLength(2);
});

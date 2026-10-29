/**
 * Group-simulator scenario: a PARTNER club's guest joining or leaving the
 * asking club's game is shown where the whole club can see it (Kemal,
 * 2026-10-29: "a guest from a partner club joining or leaving a game is an
 * attendance change the whole club should see, the same as pool guests").
 * The rule of #458 (`clubNoticeRoute`), through the shared guest notice:
 *
 *   - a club with no admin group: the guest takes a place, ONE post in its
 *     players' group naming his club, and ZERO admin DMs; he drops out, ONE
 *     more post;
 *   - an organiser-pick club with no admin group: the bench post says how an
 *     organiser puts him in;
 *   - a club with HQ: the HQ notice as before (his standing kept), nothing in
 *     the players' group.
 *
 * He volunteers by the ask's coded DM ("IN (ref K7Q2)"), the DM resolver's
 * free fast path: real routes, real database, no model call ($0). What the
 * PARTNER club's own group hears is not part of this and is not asserted.
 */
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import type { TestDb } from "../helpers/test-db";
import { askRefCode } from "../../src/lib/partner-ask-ref";
import { createGroup, type SimGroup } from "./group";

test.describe.configure({ mode: "serial" });

test.beforeAll(() => {
  resetDb();
});
test.afterAll(() => {
  resetDb();
});

let seq = 0;

/** The asking club (a players' group, optionally HQ), its partner with Ali
 *  in it, and one posted ask for the asking club's game. */
async function world(request: APIRequestContext, db: TestDb, opts: { hq?: boolean; benchPickMode?: "organiser" } = {}) {
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
    name: "Friday MT Community",
    upcomingMatch: false,
    players: [
      { key: "owner", name: "Fiona Founder", role: "OWNER" },
      { key: "ali", name: "Ali Kaya" },
    ],
  });
  // Quiet hours off, so the players' group post is not held.
  await db.run(`UPDATE "Organisation" SET "quietHoursEnabled" = false${opts.benchPickMode ? `, "benchPickMode" = '${opts.benchPickMode}'` : ""} WHERE id = $1`, [asker.orgId]);
  if (opts.hq) {
    await db.run(`UPDATE "Organisation" SET "adminGroupId" = $2, "adminChannelMode" = 'admin-group' WHERE id = $1`, [asker.orgId, `sim-hq-xg-${n}@g.us`]);
  }
  const pairId = `sim-xg-pair-${n}`;
  const askId = `sim-xg-ask-${n}`;
  await db.run(
    `INSERT INTO "ClubPartnership" (id,"askerOrgId","partnerOrgId",status,"askerAcceptedAt","partnerAcceptedAt","createdByUserId","createdAt","updatedAt")
     VALUES ($1,$2,$3,'active',now(),now(),$4,now(),now())`,
    [pairId, asker.orgId, partner.orgId, asker.player("owner").userId],
  );
  const kickoff = (await db.one<{ date: Date }>(`SELECT date FROM "Match" WHERE id = $1`, [asker.matchId]))!.date;
  await db.run(
    `INSERT INTO "PartnerAsk" (id,"partnershipId","askerOrgId","partnerOrgId","matchId",places,status,"requestedVia","postedAt","postWaMessageId","postBy","closesAt","createdAt","updatedAt")
     VALUES ($1,$2,$3,$4,$5,2,'posted','button',now(),$6,$7,$8,now(),now())`,
    [askId, pairId, asker.orgId, partner.orgId, asker.matchId, `true_${partner.groupId}_3EB0XG${n}`, new Date(kickoff.getTime() - 4 * 3600_000), kickoff],
  );
  await askerJobs(db, asker);
  return { asker: asker.attach(request), partner: partner.attach(request), ref: askRefCode(askId) };
}

const seen = new Set<string>();
/** Every job the asking club's own channels (players' group, HQ, admin DMs)
 *  got since the last look. */
async function askerJobs(db: TestDb, g: SimGroup) {
  const rows = await db.all<{ id: string; kind: string; text: string }>(`SELECT id, kind, text FROM "BotJob" WHERE "orgId" = $1 ORDER BY "createdAt"`, [g.orgId]);
  const fresh = rows.filter((r) => !seen.has(r.id));
  for (const r of fresh) seen.add(r.id);
  return fresh.map(({ kind, text }) => ({ kind, text }));
}

const DAY = String.raw`\w{3} \d+ \w{3}, 20:00`;

test("a club with no admin group: ONE players' group post when the partner guest takes a place, zero admin DMs; ONE more when he drops", async ({ request, db }) => {
  const { asker, partner, ref } = await world(request, db);
  const r = await partner.dm("ali", `IN (ref ${ref})`);
  expect(r.json).toMatchObject({ handled: "xask-dm-volunteer", outcome: "registered-in" });
  const joined = await askerJobs(db, asker);
  expect(joined).toEqual([{ kind: "group", text: expect.stringMatching(new RegExp(`^🙋 Ali K from Friday MT Community has joined the squad for ${DAY}\\.$`)) }]);
  // Never his standing at his own club, never the organisers' words.
  expect(joined[0].text).not.toMatch(/third|rated|answered your ask|for you to pick/);
  // His own answer is still one DM, from his club.
  expect(r.dms).toEqual([{ phone: partner.player("ali").phone!.replace(/^\+/, ""), text: expect.stringContaining("Friday Night Football") }]);

  const out = await partner.dm("ali", `OUT (ref ${ref})`);
  expect(out.json).toMatchObject({ handled: "xask-dm-volunteer", outcome: "withdrawn" });
  expect(await askerJobs(db, asker)).toEqual([
    { kind: "group", text: expect.stringMatching(new RegExp(`^Ali K from Friday MT Community can no longer play on ${DAY}, so I've taken them off\\.$`)) },
  ]);
});

test("an organiser-pick club with no admin group: the bench post says how an organiser puts him in, still no admin DM", async ({ request, db }) => {
  const { asker, partner, ref } = await world(request, db, { benchPickMode: "organiser" });
  const r = await partner.dm("ali", `IN (ref ${ref})`);
  expect(r.json).toMatchObject({ handled: "xask-dm-volunteer", outcome: "registered-bench" });
  expect(await askerJobs(db, asker)).toEqual([
    {
      kind: "group",
      text: expect.stringMatching(
        new RegExp(
          `^🙋 Ali K from Friday MT Community is on the bench for ${DAY}\\. The organisers pick who plays from the bench\\. Organisers, to put Ali K in, tag me and say so, for example \\*@Match Time put Ali K in\\*$`,
        ),
      ),
    },
  ]);
});

test("a club with HQ: the HQ notice as before, nothing in the players' group", async ({ request, db }) => {
  const { asker, partner, ref } = await world(request, db, { hq: true });
  const r = await partner.dm("ali", `IN (ref ${ref})`);
  expect(r.json).toMatchObject({ handled: "xask-dm-volunteer", outcome: "registered-in" });
  expect(await askerJobs(db, asker)).toEqual([
    { kind: "admin-group", text: expect.stringMatching(new RegExp(`^🤝 Ali Kaya \\(Friday MT Community.*\\) answered your ask for ${DAY}: in the squad\\.$`)) },
  ]);

  await partner.dm("ali", `OUT (ref ${ref})`);
  expect(await askerJobs(db, asker)).toEqual([
    { kind: "admin-group", text: expect.stringMatching(new RegExp(`^Ali Kaya \\(Friday MT Community\\) can't play ${DAY} after all, so I've taken them off\\.$`)) },
  ]);
});

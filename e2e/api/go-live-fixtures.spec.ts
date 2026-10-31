/**
 * GOING LIVE MAKES THE GAME AT ONCE; A LIST WITH NO GAME GETS AN ANSWER;
 * A GAME MADE AFTER ITS DEADLINE GETS NO DEADLINE SUMMARY (2026-10-15).
 *
 * The incident, club FNF: GO at 22:12 London on a Thursday. Its games were
 * made only by the nightly cron (00:00 UTC), so the 18-name squad its
 * organiser pasted in the admin group at 22:13 and 22:14 got no reply.
 * When the game was made (22:17, by hand), the organisers got "Drop-out
 * deadline passed ... Squad 0/18" for a Thursday 20:30 deadline that had
 * passed before the game existed.
 *
 * Against a real Postgres and the real routes: dm-reply (GO), admin-group
 * (the paste), the generate-matches cron and due-posts. No model is
 * called: the paste goes to the shared router and then the HQ squad reader
 * (since #471), and both are STUBBED to what the live models do with a
 * pasted squad list (`scripts/live-check-hq-paste-route.ts`, 2026-10-30:
 * the router sends every pasted list to other_att, the reader reads it as
 * the squad). GO and the summary are deterministic.
 */
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import { E2E } from "../helpers/env";
import type { TestDb } from "../helpers/test-db";
import { clearHqSquadReaderStub, clearPipelineStubs, engineOn, setHqSquadReaderStub, squadReading, addDmIntentBodies, GO_READS } from "../helpers/stub";
import { formatLondon, nextLondonKickoff } from "@/lib/london-time";
import { nextNightlyFixtureRun } from "@/lib/nightly-fixture-run";

test.describe.configure({ mode: "serial" });

const KEY = { "x-api-key": E2E.WHATSAPP_API_KEY };
const bare = (phone: string) => phone.replace(/^\+/, "");
let seq = 0;
const msgId = (tag: string) => `e2e-glf-${tag}-${Date.now()}-${++seq}`;

const SQUAD = [
  "Friday squad",
  "1. Hamzah Ali",
  "2. Raihan Ahmed",
  "3. Wasim Khan",
  "4. Bilal Shah",
  "5. Naim Patel",
  "6. Tariq Aziz",
  "7. Omar Farooq",
  "8. Yusuf Malik",
  "9. Zain Iqbal",
  "10. Imran Butt",
].join("\n");
// What the HQ squad reader (a model, stubbed, 2026-10-29) reads it as.
const SQUAD_READ = squadReading(["Hamzah Ali", "Raihan Ahmed", "Wasim Khan", "Bilal Shah", "Naim Patel", "Tariq Aziz", "Omar Farooq", "Yusuf Malik", "Zain Iqbal", "Imran Butt"]);

async function dm(request: APIRequestContext, phone: string, body: string, waMessageId = msgId("dm")) {
  addDmIntentBodies(GO_READS);
  const res = await request.post("/api/whatsapp/dm-reply", {
    headers: KEY,
    data: { phone: bare(phone), body, waMessageId, authorName: null },
  });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

async function hq(request: APIRequestContext, groupId: string, text: string, senderPhone: string, messageId = msgId("hq")) {
  const res = await request.post("/api/whatsapp/admin-group", {
    headers: KEY,
    data: { channel: "admin-group", botMentioned: true, groupId, messageId, text, senderPhone: bare(senderPhone), timestamp: String(Math.floor(Date.now() / 1000)) },
  });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

async function cron(request: APIRequestContext) {
  const res = await request.get("/api/cron/generate-matches", { headers: { authorization: `Bearer ${E2E.CRON_SECRET}` } });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

/** A club with an owner, a Friday 20:30 9-a-side game and a linked admin group. */
async function clubWithGame(
  db: TestDb,
  c: { id: string; group: string; hq: string; ownerId: string; ownerPhone: string; held: boolean },
) {
  await db.run(
    `INSERT INTO "Organisation" ("id","name","slug","inviteCode","approvalStatus","approvedAt","whatsappGroupId",
       "whatsappBotEnabled","setupStage","language","adminChannelMode","adminGroupId","createdAt","updatedAt")
     VALUES ($1,$2,$1,$3,'approved',now() - interval '3 hours',$4,$5,$6,'en','admin-group',$7,now(),now())`,
    [c.id, `Club ${c.id}`, `${c.id}-invite`, c.group, !c.held, c.held ? "setting-up" : "live", c.hq],
  );
  await db.run(`INSERT INTO "User" (id, name, email, "phoneNumber", onboarded, "isActive", "updatedAt") VALUES ($1,'Olly Owner',$2,$3,true,true,now())`, [
    c.ownerId,
    `${c.ownerId}@e2e-test.invalid`,
    c.ownerPhone,
  ]);
  await db.run(`INSERT INTO "Membership" (id, "userId", "orgId", role) VALUES ($1,$2,$3,'OWNER')`, [`${c.ownerId}-mem`, c.ownerId, c.id]);
  if (c.held) {
    await db.run(
      `INSERT INTO "ClubConnect" ("id","orgId","userId","phone","code","status","expiresAt","groupId","groupSubject","linkedAt","updatedAt")
       VALUES ($1,$2,$3,$4,$5,'closed',now() + interval '1 hour',$6,'FNF Fridays',now() - interval '4 hours',now())`,
      [`${c.id}-cc`, c.id, c.ownerId, bare(c.ownerPhone), c.id.slice(-4).toUpperCase(), c.group],
    );
  }
  await db.run(
    `INSERT INTO "Sport" ("id","orgId","name","playersPerTeam","positions","teamLabels","createdAt","updatedAt")
     VALUES ($1,$2,'Football 9-a-side',9,ARRAY['GK','DEF','MID','FWD'],ARRAY['Red','Yellow'],now(),now())`,
    [`${c.id}-sport`, c.id],
  );
  await db.run(
    `INSERT INTO "Activity" ("id","orgId","sportId","name","dayOfWeek","time","venue","isActive","deadlineHours","feePerPlayer","createdAt","updatedAt")
     VALUES ($1,$2,$3,'Football 9-a-side',5,'20:30','Powerleague',true,5,5,now(),now())`,
    [`${c.id}-act`, c.id, `${c.id}-sport`],
  );
}

const matchesOf = (db: TestDb, activityId: string) =>
  // `date` is a plain timestamp holding UTC: read it as text, so the
  // driver does not reinterpret it in the machine's time zone.
  db.all<{ id: string; date: string; maxPlayers: number; feePerPlayer: number | null }>(
    `SELECT id, to_char(date, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS date, "maxPlayers", "feePerPlayer" FROM "Match" WHERE "activityId" = $1`,
    [activityId],
  );

test.beforeAll(() => {
  resetDb();
  // The router sends a pasted list to the squad (as the live router does),
  // then the reader reads it as the squad.
  engineOn({ [SQUAD]: { route: "other_att" } });
  setHqSquadReaderStub({ bodies: { [SQUAD]: SQUAD_READ } });
});
test.afterAll(() => {
  clearPipelineStubs();
  clearHqSquadReaderStub();
  resetDb();
});

test.describe("GO makes the club's game at once, and a pasted squad then has it", () => {
  const FNF = { id: "e2e-glf-fnf", group: "120363900000000301@g.us", hq: "120363900000000302@g.us", ownerId: "e2e-glf-olly", ownerPhone: "+447700951001", held: true };

  test.beforeAll(async ({ db }) => {
    await clubWithGame(db, FNF);
  });

  test("setting up: no game yet (the cron has not run since it was made)", async ({ db }) => {
    expect(await matchesOf(db, `${FNF.id}-act`)).toEqual([]);
  });

  test("GO: the club is live AND its next game exists, at the cron's slot, places and no fee", async ({ request, db }) => {
    const before = new Date();
    const res = await dm(request, FNF.ownerPhone, "GO");
    expect(res).toMatchObject({ handled: "setup-go", outcome: "went-live", orgId: FNF.id });
    const matches = await matchesOf(db, `${FNF.id}-act`);
    expect(matches).toHaveLength(1);
    // The next Friday 20:30 London, as the cron would have made it.
    const expected = nextLondonKickoff(before, 5, "20:30");
    expect(new Date(matches[0].date).getTime()).toBe(expected.getTime());
    expect(matches[0].maxPlayers).toBe(18);
    // The fee stays the collector's to confirm per game (payment-flow.ts).
    expect(matches[0].feePerPlayer).toBeNull();
  });

  test("the squad pasted in the admin group a minute later is proposed, with the YES question", async ({ request }) => {
    const out = await hq(request, FNF.hq, SQUAD, FNF.ownerPhone);
    expect(out).toMatchObject({ handled: true, outcome: "paste-proposed" });
    expect(out.replyText).toMatch(/Say \*@Match Time YES\* to apply\.$/);
  });

  test("the nightly cron afterwards makes no second game (its own dedupe)", async ({ request, db }) => {
    await cron(request);
    expect(await matchesOf(db, `${FNF.id}-act`)).toHaveLength(1);
  });
});

test.describe("a squad pasted when there is no game to put it on", () => {
  const LIVE = { id: "e2e-glf-live", group: "120363900000000311@g.us", hq: "120363900000000312@g.us", ownerId: "e2e-glf-lia", ownerPhone: "+447700951011", held: false };
  const PLAYER = { id: "e2e-glf-pip", phone: "+447700951012" };

  test.beforeAll(async ({ db }) => {
    await clubWithGame(db, LIVE);
    await db.run(`INSERT INTO "User" (id, name, email, "phoneNumber", onboarded, "isActive", "updatedAt") VALUES ($1,'Pip Player',$2,$3,true,true,now())`, [
      PLAYER.id,
      `${PLAYER.id}@e2e-test.invalid`,
      PLAYER.phone,
    ]);
    await db.run(`INSERT INTO "Membership" (id, "userId", "orgId", role) VALUES ($1,$2,$3,'PLAYER')`, [`${PLAYER.id}-mem`, PLAYER.id, LIVE.id]);
  });

  test("an owner's paste: one line saying there is no game yet and when the next one is made; nothing stored", async ({ request, db }) => {
    const id = msgId("nomatch");
    const out = await hq(request, LIVE.hq, SQUAD, LIVE.ownerPhone, id);
    const time = formatLondon(nextNightlyFixtureRun(new Date()), "HH:mm");
    expect(out).toMatchObject({
      handled: true,
      outcome: "paste-no-match",
      replyText: `There's no upcoming game to put this list on yet. MatchTime adds the next game every night at ${time} (London time). Paste the list again after that.`,
    });
    expect(await db.count(`SELECT COUNT(*) FROM "AdminSquadProposal" WHERE "orgId" = $1`, [LIVE.id])).toBe(0);
    // A Pi retry of the same message: answered once.
    expect(await hq(request, LIVE.hq, SQUAD, LIVE.ownerPhone, id)).toMatchObject({ ignored: "duplicate", replyText: null });
  });

  test("a plain player's paste: the same line, as an owner's (any member may paste a list since 2026-10-20); nothing stored", async ({ request, db }) => {
    expect(await hq(request, LIVE.hq, SQUAD, PLAYER.phone)).toMatchObject({ handled: true, outcome: "paste-no-match" });
    expect(await db.count(`SELECT COUNT(*) FROM "AdminSquadProposal" WHERE "orgId" = $1`, [LIVE.id])).toBe(0);
  });

  test("a Turkish club gets Turkish", async ({ request, db }) => {
    await db.run(`UPDATE "Organisation" SET language = 'tr' WHERE id = $1`, [LIVE.id]);
    const out = await hq(request, LIVE.hq, SQUAD, LIVE.ownerPhone);
    const time = formatLondon(nextNightlyFixtureRun(new Date()), "HH:mm");
    expect(out.replyText).toBe(
      `Bu listeyi koyacağım yaklaşan bir maç henüz yok. MatchTime bir sonraki maçı her gece ekler (Londra saatiyle ${time}). Ondan sonra listeyi yeniden yapıştırın.`,
    );
    await db.run(`UPDATE "Organisation" SET language = 'en' WHERE id = $1`, [LIVE.id]);
  });

  test("no active weekly game at all: says to add one under Activities", async ({ request, db }) => {
    await db.run(`UPDATE "Activity" SET "isActive" = false WHERE "orgId" = $1`, [LIVE.id]);
    const out = await hq(request, LIVE.hq, SQUAD, LIVE.ownerPhone);
    expect(out).toMatchObject({
      outcome: "paste-no-match",
      replyText:
        "This club has no weekly game set up yet, so there's nothing to put this list on. Add the game under Activities on the website, then paste the list again.",
    });
    await db.run(`UPDATE "Activity" SET "isActive" = true WHERE "orgId" = $1`, [LIVE.id]);
  });
});

test.describe("a game made after its own drop-out deadline gets no deadline summary", () => {
  const G = "e2e-glf-dl@g.us";
  const H = "120363900000000321@g.us";
  // Friday 15 January 2027, 20:30 GMT; deadline Thursday 14 Jan 20:30.
  const KICKOFF = new Date("2027-01-15T20:30:00.000Z");
  const THU_2205 = "2027-01-14T22:05:00.000Z";

  async function poll(request: APIRequestContext) {
    const res = await request.get(`/api/whatsapp/due-posts?groupId=${encodeURIComponent(G)}`, {
      headers: { ...KEY, "x-test-now": THU_2205, "x-mt-pi-caps": "admin-group" },
    });
    expect(res.status(), await res.text()).toBe(200);
    return ((await res.json()).instructions ?? []) as Array<{ kind: string; text?: string }>;
  }

  test.beforeAll(async ({ db }) => {
    await db.run(
      `INSERT INTO "Organisation" (id, name, slug, "inviteCode", "whatsappGroupId", "whatsappBotEnabled",
         "dropOutDeadlineDay", "dropOutDeadlineTime", "adminChannelMode", "adminGroupId", "updatedAt")
       VALUES ('e2e-glf-dl-org', 'Late FNF', 'e2e-glf-dl', 'e2e-glf-dl-invite', $1, true, 4, '20:30', 'admin-group', $2, now())`,
      [G, H],
    );
    await db.run(
      `INSERT INTO "Sport" (id, "orgId", name, "playersPerTeam", positions, "teamLabels", "updatedAt")
       VALUES ('e2e-glf-dl-sport', 'e2e-glf-dl-org', 'Football 9-a-side', 9, ARRAY['GK'], ARRAY['Red','Yellow'], now())`,
    );
    await db.run(
      `INSERT INTO "Activity" (id, "orgId", "sportId", name, "dayOfWeek", time, venue, "deadlineHours", "updatedAt")
       VALUES ('e2e-glf-dl-act', 'e2e-glf-dl-org', 'e2e-glf-dl-sport', 'Football 9-a-side', 5, '20:30', 'Powerleague', 5, now())`,
    );
    await db.run(`INSERT INTO "User" (id, email, name, "phoneNumber", "updatedAt") VALUES ('e2e-glf-dl-own', 'e2e-glf-dl-own@e2e.test', 'Dee Owner', '+447700951021', now())`);
    await db.run(`INSERT INTO "Membership" (id, "userId", "orgId", role) VALUES ('e2e-glf-dl-mem', 'e2e-glf-dl-own', 'e2e-glf-dl-org', 'OWNER')`);
    // Made Thursday 22:00, after the Thursday 20:30 deadline (a UTC
    // instant, as Prisma stores it).
    await db.run(
      `INSERT INTO "Match" (id, "activityId", date, "maxPlayers", status, "attendanceDeadline", "createdAt", "updatedAt")
       VALUES ('e2e-glf-dl-match', 'e2e-glf-dl-act', $1, 18, 'UPCOMING', $2, $3, now())`,
      [KICKOFF.toISOString(), new Date(KICKOFF.getTime() - 5 * 3600_000).toISOString(), "2027-01-14T22:00:00.000Z"],
    );
  });

  test("the poll after the deadline sends no summary, and claims none", async ({ request, db }) => {
    const instructions = await poll(request);
    expect(instructions.filter((i) => (i.text ?? "").startsWith("Drop-out deadline"))).toEqual([]);
    expect(await db.count(`SELECT COUNT(*) FROM "SentNotification" WHERE key = 'e2e-glf-dl-match:deadline-summary'`)).toBe(0);
    expect(await db.count(`SELECT COUNT(*) FROM "BotJob" WHERE "orgId" = 'e2e-glf-dl-org' AND text LIKE 'Drop-out deadline%'`)).toBe(0);
  });

  test("the same game made BEFORE the deadline does get it, naming the deadline and the kick-off", async ({ request, db }) => {
    await db.run(`UPDATE "Match" SET "createdAt" = $2 WHERE id = $1`, ["e2e-glf-dl-match", "2027-01-09T00:00:00.000Z"]);
    const instructions = await poll(request);
    const summary = instructions.filter((i) => (i.text ?? "").startsWith("Drop-out deadline"));
    expect(summary).toHaveLength(1);
    expect(summary[0].text!.split("\n")[0]).toBe(
      "Drop-out deadline (Thu 14 Jan at 20:30) passed for *Football 9-a-side*, kick-off Fri 15 Jan at 20:30. Squad 0/18.",
    );
  });
});

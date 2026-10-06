/**
 * MONTHLY SQUAD: "PAID" BY DM IN A MONTH THE ORGANISER STARTED PART-WAY.
 *
 * MDs/monthly-squad-plan-2026-10-05.md, 4.5 and 4.3 (D3). A month started
 * part-way with a share per game has amounts (`amountDuePence`) but, by
 * design, no `pricedAt`: pricing happened outside MatchTime. The join DM
 * for such a month says: pay the collector, then DM me "paid". That DM
 * has to be read, as the "I've paid" button and a "(paid)" mark on a
 * pasted list already are.
 *
 *   1. a regular who owes for a part-way month DMs "paid": it is recorded
 *      as "says paid", NEVER as paid, and answered once;
 *   2. nothing else that keys off `pricedAt` moves: the month is still
 *      unpriced, and no priced list, group count or reminder DM goes out
 *      for it. The collector's daily list does carry the claim (it never
 *      depended on `pricedAt`);
 *   3. a part-way month with NO share has no amount: "paid" is not a
 *      month claim there, as before.
 *
 * The rows are written the way `planMonthSeed` writes them
 * (`squad-month-rules.ts`): status "running", `startedMidMonthAt` set,
 * `pricedAt`, `payByAt` and `listOpenedAt` empty.
 *
 * No model is called anywhere in this file.
 */
import { formatInTimeZone } from "date-fns-tz";
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import { engineOn } from "../helpers/stub";
import { E2E } from "../helpers/env";
import { testDb, type TestDb } from "../helpers/test-db";
import { londonDateTimeToUtc } from "@/lib/london-time";
import { monthKickoffs, nextMonthStart } from "@/lib/month-signup-rules";
import { londonMonthStart } from "@/lib/squad-month-rules";

test.describe.configure({ mode: "serial" });

const LONDON = "Europe/London";
const NEXT = nextMonthStart(londonMonthStart(new Date()));
const G = monthKickoffs(NEXT, 1, "20:00");
const N = G.length;
const SHARE = 750;

const A = { org: "e2e-pp-org", group: "e2e-partway@g.us", act: "e2e-pp-act", sport: "e2e-pp-sport", month: "e2e-pp-month" };
const B = { org: "e2e-pp2-org", group: "e2e-partway2@g.us", act: "e2e-pp2-act", sport: "e2e-pp2-sport", month: "e2e-pp2-month" };

const P = {
  rob: { id: "e2e-pp-rob", name: "Rob Hale", phone: "+447700951001" },
  carl: { id: "e2e-pp-carl", name: "Carl Young", phone: "+447700951002" },
  dev: { id: "e2e-pp-dev", name: "Dev Patel", phone: "+447700951003" },
  wes: { id: "e2e-pp-wes", name: "Wes Lane", phone: "+447700951004" },
  finn: { id: "e2e-pp-finn", name: "Finn Moss", phone: "+447700951005" },
} as const;
type Person = (typeof P)[keyof typeof P];
const digits = (phone: string) => phone.replace(/^\+/, "");
const KEY = { "x-api-key": E2E.WHATSAPP_API_KEY };
let seq = 0;
const msgId = () => `e2e-pp-${Date.now()}-${++seq}`;

async function person(db: TestDb, p: Person, org: string, role = "PLAYER") {
  await db.run(`INSERT INTO "User" (id, email, name, "phoneNumber", "updatedAt") VALUES ($1, $2, $3, $4, now())`, [p.id, `${p.id}@e2e.test`, p.name, p.phone]);
  await db.run(`INSERT INTO "Membership" (id, "userId", "orgId", role) VALUES ($1, $2, $3, $4::"MemberRole")`, [`mem-${org}-${p.id}`, p.id, org, role]);
}

async function club(db: TestDb, o: typeof A, owner: Person, share: number | null) {
  await db.run(
    `INSERT INTO "Organisation" (id, name, slug, "inviteCode", "whatsappGroupId", "whatsappBotEnabled", "squadMode", "paygPricePence",
                                 "adminChannelMode", language, "updatedAt")
     VALUES ($1, 'Vets MNF', $1, $2, $3, true, 'monthly', 800, 'each-admin', 'en', now())`,
    [o.org, `${o.org}-invite`, o.group],
  );
  await db.run(
    `INSERT INTO "Sport" (id, "orgId", name, "playersPerTeam", positions, "teamLabels", "updatedAt")
     VALUES ($1, $2, 'Basketball', 3, ARRAY['G','F'], ARRAY['Red','Yellow'], now())`,
    [o.sport, o.org],
  );
  await db.run(
    `INSERT INTO "Activity" (id, "orgId", "sportId", name, "dayOfWeek", time, venue, "deadlineHours", "updatedAt")
     VALUES ($1, $2, $3, 'Monday 7-a-side', 1, '20:00', 'Goals', 5, now())`,
    [o.act, o.org, o.sport],
  );
  await person(db, owner, o.org, "OWNER");
  await db.run(`UPDATE "Organisation" SET "paymentHolderId" = $2 WHERE id = $1`, [o.org, owner.id]);
  // As `planMonthSeed` leaves it: running, started part-way, never priced.
  await db.run(
    `INSERT INTO "SquadMonth" (id, "orgId", "activityId", "monthStart", status, "gamesScheduled", "gamesPlayedBeforeStart", "sharePerGamePence",
                               "startedMidMonthAt", "startedByUserId", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4::date, 'running', $5, 0, $6, $7, $8, $7, now())`,
    [o.month, o.org, o.act, NEXT, N, share, new Date(Date.now() - 60 * 60 * 1000).toISOString(), owner.id],
  );
}

async function regular(db: TestDb, o: typeof A, p: Person, slot: number, amountDuePence: number | null) {
  await db.run(
    `INSERT INTO "SquadMonthMember" (id, "monthId", "userId", kind, slot, "gamesCovered", "amountDuePence", source, "joinedAt", "updatedAt")
     VALUES ($1, $2, $3, 'regular', $4, $5, $6, 'seed-tick', now() - interval '1 hour', now())`,
    [`${o.month}-${p.id}`, o.month, p.id, slot, N, amountDuePence],
  );
}

const member = (db: TestDb, o: typeof A, who: Person) =>
  db.one<{ paidAt: Date | null; paidClaimedAt: Date | null; paidClaimSource: string | null; amountDuePence: number | null; paidAmountPence: number | null }>(
    `SELECT "paidAt", "paidClaimedAt", "paidClaimSource", "amountDuePence", "paidAmountPence" FROM "SquadMonthMember" WHERE "monthId" = $1 AND "userId" = $2`,
    [o.month, who.id],
  );

const dms = (db: TestDb, org: string, who: Person) =>
  db.all<{ text: string }>(`SELECT text FROM "BotJob" WHERE "orgId" = $1 AND kind = 'dm' AND phone = $2 ORDER BY "createdAt"`, [org, digits(who.phone)]);

async function dm(request: APIRequestContext, who: Person, body: string): Promise<{ handled?: string; claimed?: boolean; monthId?: string }> {
  const res = await request.post("/api/whatsapp/dm-reply", {
    headers: KEY,
    data: { phone: digits(who.phone), body, waMessageId: msgId(), authorName: who.name },
  });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()) as { handled?: string; claimed?: boolean; monthId?: string };
}

test.beforeAll(async () => {
  resetDb();
  const db = testDb();
  // Club A: started part-way WITH a share. Carl and Dev owe for the month.
  await club(db, A, P.rob, SHARE);
  await person(db, P.carl, A.org);
  await person(db, P.dev, A.org);
  await regular(db, A, P.carl, 1, SHARE * N);
  await regular(db, A, P.dev, 2, SHARE * N);
  // Club B: started part-way with NO share. Nobody has an amount.
  await club(db, B, P.wes, null);
  await person(db, P.finn, B.org);
  await regular(db, B, P.finn, 1, null);
  engineOn({});
});
test.afterAll(() => resetDb());

test("1. a regular of a month started part-way DMs \"paid\": says paid, never paid, answered once", async ({ request, db }) => {
  const first = await dm(request, P.carl, "paid");
  expect(first).toMatchObject({ handled: "month-paid-claim", monthId: A.month, claimed: true });

  const row = (await member(db, A, P.carl))!;
  expect(row.paidClaimedAt).not.toBeNull();
  expect(row.paidClaimSource).toBe("dm");
  // D3: a claim. Only the collector confirms.
  expect(row.paidAt).toBeNull();
  expect(row.paidAmountPence).toBeNull();
  expect(row.amountDuePence).toBe(SHARE * N);

  const acks = await dms(db, A.org, P.carl);
  expect(acks).toHaveLength(1);
  expect(acks[0].text).toContain("£" + ((SHARE * N) / 100).toFixed(2));

  // Saying it again changes nothing and is not answered twice in a day.
  const again = await dm(request, P.carl, "I've paid");
  expect(again).toMatchObject({ handled: "month-paid-claim", claimed: false });
  expect(await dms(db, A.org, P.carl)).toHaveLength(1);
  expect((await member(db, A, P.carl))!.paidAt).toBeNull();
  // Dev said nothing, so nothing is recorded for him.
  expect((await member(db, A, P.dev))!.paidClaimedAt).toBeNull();
});

test("2. the month is still unpriced: no priced list, count or reminder; the collector's daily list has the claim", async ({ request, db }) => {
  expect(
    await db.one(`SELECT "pricedAt", "payByAt", "listOpenedAt", "summarySentAt", status FROM "SquadMonth" WHERE id = $1`, [A.month]),
  ).toEqual({ pricedAt: null, payByAt: null, listOpenedAt: null, summarySentAt: null, status: "running" });

  // Tomorrow, 10:05 London: the hour of the collector's daily list.
  const day = new Date(`${formatInTimeZone(new Date(), LONDON, "yyyy-MM-dd")}T12:00:00.000Z`);
  day.setUTCDate(day.getUTCDate() + 1);
  const now = londonDateTimeToUtc(day.toISOString().slice(0, 10), "10:05");
  const res = await request.get(`/api/whatsapp/due-posts?groupId=${encodeURIComponent(A.group)}`, { headers: { ...KEY, "x-test-now": now.toISOString() } });
  expect(res.status(), await res.text()).toBe(200);
  const keys = ((await res.json()).instructions as Array<{ key: string }>).map((i) => i.key);
  const pay = `org-${A.org}:mpy:`;
  expect(keys.filter((k) => k.startsWith(`${pay}priced:`) || k.startsWith(`${pay}group:`) || k.startsWith(`${pay}dm:`))).toEqual([]);
  expect(await db.count(`SELECT COUNT(*) FROM "SentNotification" WHERE key LIKE $1`, [`${pay}price-ask:%`])).toBe(0);
  // The claim reaches the collector, who alone can confirm it.
  expect(await db.count(`SELECT COUNT(*) FROM "SentNotification" WHERE key LIKE $1`, [`${pay}digest:${A.month}:%`])).toBe(1);
  const list = (await dms(db, A.org, P.rob)).map((d) => d.text).filter((t) => t.includes("Carl Young"));
  expect(list).toHaveLength(1);
  expect(list[0]).toContain("PAID ALL");
  expect((await member(db, A, P.carl))!.paidAt).toBeNull();
});

test("3. a month started part-way with no share has no amount: \"paid\" is not a month claim", async ({ request, db }) => {
  const res = await dm(request, P.finn, "paid");
  expect(res.handled).not.toBe("month-paid-claim");
  expect((await member(db, B, P.finn))!.paidClaimedAt).toBeNull();
});

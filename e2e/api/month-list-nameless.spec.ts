/**
 * THE MONTH'S LIST AT A CLUB WHOSE MEMBERS HAVE NO NAMES YET (2026-11-03).
 *
 * The Vets sandbox's scenario C: Davide posted the month's list and only 4
 * of 13 names went on it, because most members were imported from the
 * WhatsApp member list with no name, and a list's names are matched only
 * against names. Real clubs look like this when they join.
 *
 *   1. the participant sweep names a nameless member from the WhatsApp
 *      name the Pi sends (never a number shown as a name);
 *   2. the organiser's list: the DM shows the names it could not match and
 *      the nameless members, numbered by phone (to him only); the same
 *      list read twice in one flush is offered ONCE;
 *   3. he answers "Craig is 1, steff is 2" by DM, read by the reply reader
 *      (stubbed here): both go on the draft with their lines, and are
 *      named; the draft is sent again; his yes starts the month with all.
 *
 * Every model step is stubbed: $0.
 */
import type { APIRequestContext } from "@playwright/test";
import { formatInTimeZone } from "date-fns-tz";
import { test, expect, resetDb } from "../fixtures";
import { clearMonthlyReaderStub, setMonthlyReaderStub, setMonthSeedReplyStub } from "../helpers/stub";
import { E2E } from "../helpers/env";
import { testDb } from "../helpers/test-db";

test.describe.configure({ mode: "serial" });

const ORG = "e2e-mln-org";
const GROUP = "e2e-month-list-nameless@g.us";
const ACT = "e2e-mln-act";
const MATCH_ID = "e2e-mln-match";
const LONDON = "Europe/London";
const KEY = { "x-api-key": E2E.WHATSAPP_API_KEY };
const digits = (phone: string) => phone.replace(/^\+/, "");

const owner = { id: "e2e-mln-owner", name: "Davide Russo", phone: "+447700933001" };
const nabz = { id: "e2e-mln-nabz", name: null, phone: "+447700933002" };
const craig = { id: "e2e-mln-craig", name: null, phone: "+447700933003" };
const steff = { id: "e2e-mln-steff", name: null, phone: "+447700933004" };
const quiet = { id: "e2e-mln-quiet", name: null, phone: "+447700933005" };

// The COMING month: its list is offered for it whatever today's date is.
const now = new Date();
const next = (() => {
  const d = new Date(`${formatInTimeZone(now, LONDON, "yyyy-MM")}-15T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d;
})();
const NEXT_START = `${formatInTimeZone(next, LONDON, "yyyy-MM")}-01`;
const NEXT_NAME = formatInTimeZone(next, LONDON, "MMMM");
const NEXT_NUMBER = Number(NEXT_START.slice(5, 7));
const KICKOFF = new Date(now.getTime() + 7 * 24 * 3600_000);

const TITLE = `${NEXT_NAME} monthly squad`;
const LIST = `MNF ${NEXT_NAME}\n\n1. Davide (paid)\n2. Nabz (paid 3 only)\n3. Craig (paid)\n4. steff (paid full)`;
const ln = (slot: number, name: string, over: Record<string, unknown> = {}) => ({
  section: "playing", slot, name, member: "", guest: false, host: "", games: 0, payg: false, paygDays: [], paid: true, paidPence: 0, concession: false, newbie: false, ...over,
});
/** As the reader reads the list: Davide is the member it knows; the rest it cannot place. */
const READING = {
  kind: "list", month: NEXT_NUMBER, gameDay: 0, listOf: "month", residual: "", choice: "", signupMonth: 0, signupFor: "", days: [], games: 0,
  lines: [ln(1, "Davide", { member: "p1" }), ln(2, "Nabz", { games: 3 }), ln(3, "Craig"), ln(4, "steff")],
};

let seq = 0;
async function postBatch(request: APIRequestContext, bodies: string[]) {
  const ids = bodies.map(() => `e2e-mln-${Date.now()}-${++seq}`);
  const res = await request.post("/api/whatsapp/analyze", {
    headers: KEY,
    data: {
      groupId: GROUP,
      messages: bodies.map((body, i) => ({ waMessageId: ids[i], body, authorPhone: digits(owner.phone), authorName: owner.name, timestamp: new Date(Date.now() + i).toISOString() })),
    },
  });
  expect(res.status(), await res.text()).toBe(200);
  const json = (await res.json()) as { results?: Array<{ waMessageId: string; intent: string | null; react: string | null; reply: string | null }> };
  return ids.map((id) => json.results?.find((r) => r.waMessageId === id));
}
async function dm(request: APIRequestContext, body: string) {
  const res = await request.post("/api/whatsapp/dm-reply", { headers: KEY, data: { phone: digits(owner.phone), body, waMessageId: `e2e-mln-dm-${++seq}`, authorName: owner.name } });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}
const dmsToOwner = () =>
  testDb().all<{ text: string }>(`SELECT text FROM "BotJob" WHERE "orgId" = $1 AND kind = 'dm' AND phone = $2 ORDER BY "createdAt"`, [ORG, digits(owner.phone)]);

test.beforeAll(async () => {
  resetDb();
  const db = testDb();
  await db.run(
    `INSERT INTO "Organisation" (id, name, slug, "inviteCode", "whatsappGroupId", "whatsappBotEnabled", "squadMode", "paygPricePence", "adminChannelMode", language, "updatedAt")
     VALUES ($1, 'Vets Nameless', $1, $2, $3, true, 'monthly', 800, 'one-person', 'en', now())`,
    [ORG, `${ORG}-invite`, GROUP],
  );
  await db.run(`INSERT INTO "Sport" (id, "orgId", name, "playersPerTeam", positions, "teamLabels", "updatedAt") VALUES ('e2e-mln-sport', $1, 'Football', 7, ARRAY['GK'], ARRAY['A','B'], now())`, [ORG]);
  await db.run(
    `INSERT INTO "Activity" (id, "orgId", "sportId", name, "dayOfWeek", time, venue, "deadlineHours", "updatedAt") VALUES ($1, $2, 'e2e-mln-sport', 'Football 7-a-side', 1, '20:30', 'Goals', 5, now())`,
    [ACT, ORG],
  );
  let i = 0;
  for (const [p, role] of [[owner, "OWNER"], [nabz, "PLAYER"], [craig, "PLAYER"], [steff, "PLAYER"], [quiet, "PLAYER"]] as const) {
    await db.run(`INSERT INTO "User" (id, email, name, "phoneNumber", "updatedAt") VALUES ($1, $2, $3, $4, now())`, [p.id, `${p.id}@e2e.test`, p.name, p.phone]);
    // Joined in this order: the DM numbers the nameless members by it.
    await db.run(`INSERT INTO "Membership" (id, "userId", "orgId", role, "createdAt") VALUES ($1, $2, $3, $4::"MemberRole", now() - ($5 || ' minutes')::interval)`, [
      `mem-${p.id}`, p.id, ORG, role, String(60 - ++i),
    ]);
  }
  await db.run(
    `INSERT INTO "Match" (id, "activityId", date, "maxPlayers", status, "attendanceDeadline", "updatedAt") VALUES ($1, $2, $3, 14, 'UPCOMING', $4, now())`,
    [MATCH_ID, ACT, KICKOFF.toISOString(), new Date(KICKOFF.getTime() - 5 * 3600_000).toISOString()],
  );
});

test.afterAll(() => {
  clearMonthlyReaderStub();
  setMonthSeedReplyStub({});
  resetDb();
});

test("1. the participant sweep names a nameless member from his WhatsApp name, never from a number", async ({ request, db }) => {
  const res = await request.post("/api/whatsapp/sync-participants", {
    headers: KEY,
    data: { groupId: GROUP, participants: [{ phone: digits(nabz.phone), pushname: "Nabz" }, { phone: digits(quiet.phone), pushname: "+44 7700 933005" }] },
  });
  expect(res.status(), await res.text()).toBe(200);
  expect((await db.one<{ name: string | null }>(`SELECT name FROM "User" WHERE id = $1`, [nabz.id]))?.name).toBe("Nabz");
  expect((await db.one<{ name: string | null }>(`SELECT name FROM "User" WHERE id = $1`, [quiet.id]))?.name).toBeNull();
  expect((await db.one<{ name: string | null }>(`SELECT name FROM "User" WHERE id = $1`, [owner.id]))?.name).toBe("Davide Russo");
});

test("2. the list: one DM, with the names it could not match and the nameless members by number; the title and a re-post send no second DM", async ({ request, db }) => {
  // The title answered as the same list (what the live reader did on
  // 2026-11-03, reading the list from the chat around it), and the list.
  setMonthlyReaderStub({ bodies: { [TITLE]: READING, [LIST]: READING } });
  const [title, list] = await postBatch(request, [TITLE, LIST]);
  expect(list, JSON.stringify(list)).toMatchObject({ intent: "month_seed_list", react: null, reply: null });
  // A list none of whose names is in the title is not the title's.
  expect(title, JSON.stringify(title)).toMatchObject({ react: null, reply: null });
  expect(title?.intent).not.toBe("month_seed_list");
  expect(await db.count(`SELECT COUNT(*) FROM "BotJob" WHERE "orgId" = $1 AND kind <> 'dm'`, [ORG])).toBe(0);
  expect(await db.count(`SELECT COUNT(*) FROM "AdminSquadProposal" WHERE "orgId" = $1`, [ORG])).toBe(1);

  const dms = await dmsToOwner();
  expect(dms, "ONE start-the-month DM").toHaveLength(1);
  const text = dms[0].text;
  expect(text).toContain(`I read the list you posted in the group for ${NEXT_NAME}: 2 players (Davide, Nabz (3)).`);
  expect(text).toContain("I couldn't match these names on your list to anyone: Craig, steff.");
  // The nameless members, in the order they joined, by phone.
  expect(text).toContain("1. +44 7700 933003\n2. +44 7700 933004\n3. +44 7700 933005");
  expect(text).toContain(`for example "Craig is 1"`);
  expect(text).not.toMatch(/[\u2013\u2014]/);

  const p = await db.one<{ monthSeed: { unmatched: Array<{ ref: string; name: string }>; nameless: Array<{ n: number; userId: string }> } }>(
    `SELECT "monthSeed" FROM "AdminSquadProposal" WHERE "orgId" = $1`,
    [ORG],
  );
  expect(p?.monthSeed.unmatched.map((u) => [u.ref, u.name])).toEqual([["u1", "Craig"], ["u2", "steff"]]);
  expect(p?.monthSeed.nameless).toEqual([{ n: 1, userId: craig.id }, { n: 2, userId: steff.id }, { n: 3, userId: quiet.id }]);

  // The same list posted again: the draft waiting for his answer stands.
  const [again] = await postBatch(request, [LIST]);
  expect(again, JSON.stringify(again)).toMatchObject({ intent: "month_seed_list", react: null, reply: null });
  expect(await dmsToOwner()).toHaveLength(1);
  expect(await db.count(`SELECT COUNT(*) FROM "AdminSquadProposal" WHERE "orgId" = $1`, [ORG])).toBe(1);
});

test("3. 'Craig is 1, steff is 2' by DM: both on the draft with their lines and named; his yes starts the month with all four", async ({ db, request }) => {
  setMonthSeedReplyStub({
    bodies: {
      "Craig is 1, steff is 2": JSON.stringify({
        answer: "change",
        changes: [
          { action: "match", member: "n1", games: 0, listed: "u1" },
          { action: "match", member: "n2", games: 0, listed: "u2" },
        ],
        confidence: 0.95,
      }),
      "yes go ahead": JSON.stringify({ answer: "yes", changes: [], confidence: 0.97 }),
    },
  });
  expect(await dm(request, "Craig is 1, steff is 2")).toMatchObject({ handled: "month-seed-changed", monthStart: NEXT_START });
  const users = await db.all<{ id: string; name: string | null }>(`SELECT id, name FROM "User" WHERE id = ANY($1) ORDER BY id`, [[craig.id, steff.id]]);
  expect(users).toEqual([{ id: craig.id, name: "Craig" }, { id: steff.id, name: "steff" }]);
  expect(await db.count(`SELECT COUNT(*) FROM "UserAlias" WHERE "orgId" = $1 AND "userId" = ANY($2)`, [ORG, [craig.id, steff.id]])).toBe(2);

  const dms = await dmsToOwner();
  expect(dms).toHaveLength(2);
  expect(dms[1].text).toContain("4 players (Davide, Nabz (3), Craig, steff)");
  expect(dms[1].text).not.toContain("couldn't match");

  expect(await dm(request, "yes go ahead")).toMatchObject({ handled: "month-seed-started", monthStart: NEXT_START });
  const members = await db.all<{ userId: string; gamesCommitted: number | null }>(
    `SELECT mm."userId", mm."gamesCommitted" FROM "SquadMonthMember" mm JOIN "SquadMonth" sm ON sm.id = mm."monthId" WHERE sm."orgId" = $1 ORDER BY mm."userId"`,
    [ORG],
  );
  expect(members.map((m) => m.userId).sort()).toEqual([craig.id, nabz.id, owner.id, steff.id].sort());
  // "3 only" (every month has at least four Mondays) kept from his line.
  expect(members.find((m) => m.userId === nabz.id)?.gamesCommitted).toBe(3);
});

/**
 * THE BENCH FILL MEETS THE ADMIN GROUP (HQ), with Ben as an ORDINARY
 * reserve (review of #622, 2026-11-17).
 *
 * The fixture seeds Ben as on the bench by choice, so the default world
 * never runs the fill. Here the squad is full (Ian in, 5 of 5) and Ben is
 * waiting because there was no room: the first one the bench moves up.
 *
 *   1. A pasted list that takes Tom out and names Zara: Zara gets the place
 *      the list gave her, Ben stays on the bench (all the list's writes,
 *      then the bench). Reproduced failing before the fix: Ben took Tom's
 *      place and Zara landed on the bench.
 *   2. "Tom out, Zara in" read as a change: the same.
 *   3. "Tom out" alone: the place goes to Ben, the first on the bench.
 */
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import { MATCH, ORG_ID, PHONE, U } from "../helpers/constants";
import { E2E } from "../helpers/env";
import { changeReading, clearHqSquadReaderStub, clearPipelineStubs, engineOn, setHqSquadReaderStub, squadReading } from "../helpers/stub";
import type { TestDb } from "../helpers/test-db";

test.describe.configure({ mode: "serial" });

const KEY = { "x-api-key": E2E.WHATSAPP_API_KEY };
const HQ = "120363777000000093@g.us";
const ADMIN = PHONE.admin.replace(/^\+/, "");

let seq = 0;
async function say(request: APIRequestContext, text: string, extra: Record<string, unknown> = {}) {
  const res = await request.post("/api/whatsapp/admin-group", {
    headers: KEY,
    data: { channel: "admin-group", botMentioned: true, groupId: HQ, messageId: `e2e-bfhq-${++seq}`, text, senderPhone: ADMIN, timestamp: String(Math.floor(Date.now() / 1000)), ...extra },
  });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

const statusOf = async (db: TestDb, userId: string) =>
  (await db.one<{ status: string }>(`SELECT status FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`, [MATCH.upcoming, userId]))?.status ?? null;
const confirmed = async (db: TestDb) =>
  Number((await db.one<{ n: string }>(`SELECT count(*)::text AS n FROM "Attendance" WHERE "matchId" = $1 AND status = 'CONFIRMED'`, [MATCH.upcoming]))?.n);

const PASTE = "Friday squad\n1. Alex Admin\n2. Colin Collector\n3. Pat Player\n4. Ian Innes\n5. Zara Zest";

test.beforeEach(async ({ db, request }) => {
  resetDb();
  await db.run(`UPDATE "Organisation" SET "adminGroupId" = $2, "adminChannelMode" = 'admin-group' WHERE id = $1`, [ORG_ID, HQ]);
  // Ben is an ordinary reserve: on the bench because there was no room.
  await db.run(`UPDATE "Attendance" SET "benchByChoice" = false WHERE "matchId" = $1 AND "userId" = $2`, [MATCH.upcoming, U.bench]);
  // Fill the squad first (Ian in, 5 of 5), so Ben is waiting for real.
  engineOn({ "put Ian in": { route: "other_att", reading: changeReading([["Ian Innes", "in"]]) } });
  await say(request, "put Ian in");
  expect(await confirmed(db)).toBe(5);
  expect(await statusOf(db, U.bench)).toBe("BENCH");
});

test.afterAll(() => {
  clearPipelineStubs();
  clearHqSquadReaderStub();
  resetDb();
});

test("a pasted list that takes Tom out and names Zara: Zara gets the place, Ben stays on the bench", async ({ request, db }) => {
  engineOn({ [PASTE]: { route: "other_att" }, YES: { route: "approve" } });
  setHqSquadReaderStub({ bodies: { [PASTE]: squadReading(["Alex Admin", "Colin Collector", "Pat Player", "Ian Innes", "Zara Zest"], { out: ["Tom Third"] }) } });
  const out = await say(request, PASTE);
  expect(out).toMatchObject({ handled: true, outcome: "paste-proposed" });
  const yes = await say(request, "YES", { quotedText: out.replyText, quotedFromMatchTime: true });
  expect(yes).toMatchObject({ handled: true, outcome: "paste-applied" });

  expect(await statusOf(db, U.third)).toBe("DROPPED");
  expect(await statusOf(db, U.extra)).toBe("CONFIRMED");
  expect(await statusOf(db, U.bench)).toBe("BENCH");
  expect(await confirmed(db)).toBe(5);
});

test("'Tom out, Zara in' read as a change: Zara gets the place, Ben stays on the bench", async ({ request, db }) => {
  const MSG = "@Match Time Tom out, Zara in";
  engineOn({ [MSG]: { route: "other_att", reading: changeReading([["Tom Third", "out"], ["Zara Zest", "in"]]) } });
  await say(request, MSG);
  expect(await statusOf(db, U.third)).toBe("DROPPED");
  expect(await statusOf(db, U.extra)).toBe("CONFIRMED");
  expect(await statusOf(db, U.bench)).toBe("BENCH");
  expect(await confirmed(db)).toBe(5);
});

test("'Tom out' alone: the place goes to Ben, the first on the bench, and he is DMed", async ({ request, db }) => {
  const MSG = "@Match Time Tom is out";
  engineOn({ [MSG]: { route: "other_att", reading: changeReading([["Tom Third", "out"]]) } });
  await say(request, MSG);
  expect(await statusOf(db, U.third)).toBe("DROPPED");
  expect(await statusOf(db, U.bench)).toBe("CONFIRMED");
  expect(await confirmed(db)).toBe(5);
  const dms = await db.all<{ text: string }>(`SELECT text FROM "BotJob" WHERE "orgId" = $1 AND kind = 'dm' AND phone = $2`, [ORG_ID, PHONE.bench.replace(/^\+/, "")]);
  expect(dms.map((d) => d.text).join("\n")).toContain("you were first on the bench, so you're in now");
});

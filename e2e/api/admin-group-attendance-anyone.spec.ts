/**
 * ATTENDANCE IN THE ADMIN GROUP IS OPEN TO EVERYONE IN THE CLUB (2026-10-20),
 * against a real Postgres and the real route. Kemal and FNF's admin Raihan
 * agreed in FNF HQ: anyone in HQ may change who plays, not only the owners
 * and admins. The incident: Abdul-Hafeez Niaz, a PLAYER of FNF in HQ, wrote
 * "Naim is out" and nothing happened.
 *
 * The router and the HQ squad reader are STUBBED (`engineOn`): no
 * model is called. Everything from the routes on is the shipped code.
 *
 * The fixture club (E2E Test FC, weekly, first-come) has its upcoming match
 * at 4 of 5: Alex Admin (OWNER, the only organiser), Colin Collector (the
 * money collector), Pat Player, Tom Third; Ben Bench on the bench. Pat
 * Player is the PLAYER in HQ here.
 *
 * Pinned: Pat's "Tom is out", "put Ian in", "Ian to the bench" and "put Ben
 * Bench in" do exactly what an organiser's do, with the organiser's reply
 * and tick, and are recorded as Pat's; the same in Turkish; someone who is
 * not in the club changes nothing; Pat asking to change the fee or the
 * teams is not done, and gets the one line naming who can, tagged or not
 * (2026-10-20, `admin-group-open-list-and-picks.spec.ts`).
 */
import { test, expect, resetDb } from "../fixtures";
import { MATCH, ORG_ID, PHONE, U } from "../helpers/constants";
import { E2E } from "../helpers/env";
import { engineOn, clearPipelineStubs, changeReading } from "../helpers/stub";
import type { TestDb } from "../helpers/test-db";
import type { APIRequestContext } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const KEY = { "x-api-key": E2E.WHATSAPP_API_KEY };
const HQ = "120363777000000071@g.us";
const PLAYER = PHONE.player.replace(/^\+/, "");
/** Nobody MatchTime knows. */
const STRANGER = "447700900998";

let seq = 0;
async function say(request: APIRequestContext, text: string, senderPhone = PLAYER, messageId = `e2e-agaa-${++seq}`) {
  const res = await request.post("/api/whatsapp/admin-group", {
    headers: KEY,
    data: { channel: "admin-group", groupId: HQ, messageId, text, senderPhone, timestamp: String(Math.floor(Date.now() / 1000)) },
  });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

async function statusOf(db: TestDb, userId: string): Promise<string | null> {
  return (
    (await db.one<{ status: string }>(`SELECT status FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`, [MATCH.upcoming, userId]))
      ?.status ?? null
  );
}

const lastEvent = (db: TestDb, userId: string) =>
  db.one<{ actorUserId: string; sourceRef: string }>(
    `SELECT "actorUserId", "sourceRef" FROM "AttendanceEvent" WHERE "matchId" = $1 AND "userId" = $2 ORDER BY at DESC LIMIT 1`,
    [MATCH.upcoming, userId],
  );

test.beforeAll(async ({ db }) => {
  resetDb();
  await db.run(`UPDATE "Organisation" SET "adminGroupId" = $2, "adminChannelMode" = 'admin-group' WHERE id = $1`, [ORG_ID, HQ]);
});

test.afterAll(() => {
  clearPipelineStubs();
  resetDb();
});

test("the incident: a player's 'Tom is out' takes Tom out, with the organiser's reply and tick, recorded as the player's", async ({ request, db }) => {
  engineOn({ "Tom is out": { route: "other_att", reading: changeReading([["Tom Third", "out"]]) } });
  const out = await say(request, "Tom is out", PLAYER, "e2e-agaa-tom-out");
  expect(out).toMatchObject({ handled: true, outcome: "squad-changed", replyText: "Done: Tom Third out. 3 of 5, 1 on the bench (Ben Bench).", react: "✅" });
  expect(await statusOf(db, U.third)).toBe("DROPPED");
  expect(await lastEvent(db, U.third)).toMatchObject({ actorUserId: U.player, sourceRef: "admin-group:e2e-agaa-tom-out" });
});

test("a player puts someone in", async ({ request, db }) => {
  engineOn({ "put Ian in": { route: "other_att", reading: changeReading([["Ian Innes", "in"]]) } });
  const out = await say(request, "put Ian in");
  expect(out).toMatchObject({ handled: true, outcome: "squad-changed", replyText: "Done: Ian Innes in. 4 of 5, 1 on the bench (Ben Bench).", react: "✅" });
  expect(await statusOf(db, U.fresh)).toBe("CONFIRMED");
  expect((await lastEvent(db, U.fresh))?.actorUserId).toBe(U.player);
});

test("a player puts someone on the bench, as an organiser can", async ({ request, db }) => {
  engineOn({ "Ian to the bench": { route: "other_att", reading: changeReading([["Ian Innes", "bench"]]) } });
  const out = await say(request, "Ian to the bench");
  expect(out).toMatchObject({ handled: true, outcome: "squad-changed", react: "✅" });
  expect(await statusOf(db, U.fresh)).toBe("BENCH");
});

test("a player brings someone in from the bench, as an organiser can", async ({ request, db }) => {
  engineOn({ "put Ben Bench in": { route: "other_att", reading: changeReading([["Ben Bench", "in"]]) } });
  const out = await say(request, "put Ben Bench in");
  expect(out).toMatchObject({ handled: true, outcome: "squad-changed", react: "✅" });
  expect(out.replyText).toMatch(/^Done: Ben Bench in\. 4 of 5/);
  expect(await statusOf(db, U.bench)).toBe("CONFIRMED");
});

test("in Turkish", async ({ request, db }) => {
  await db.run(`UPDATE "Organisation" SET language = 'tr' WHERE id = $1`, [ORG_ID]);
  engineOn({ "Colin çıktı": { route: "other_att", reading: changeReading([["Colin Collector", "out"]]) } });
  const out = await say(request, "Colin çıktı");
  await db.run(`UPDATE "Organisation" SET language = 'en' WHERE id = $1`, [ORG_ID]);
  expect(out).toMatchObject({ handled: true, outcome: "squad-changed", react: "✅" });
  expect(out.replyText).toMatch(/^Tamam: Colin Collector çıktı\. 3\/5/);
  expect(await statusOf(db, U.collector)).toBe("DROPPED");
});

test("someone who is not in the club: nothing changed; tagged, one line naming who can", async ({ request, db }) => {
  engineOn({
    "Pat out": { route: "other_att", reading: changeReading([["Pat Player", "out"]]) },
    "@Match Time Pat out": { route: "other_att", reading: changeReading([["Pat Player", "out"]]) },
  });
  expect(await say(request, "Pat out", STRANGER)).toMatchObject({ handled: false, replyText: null });
  expect(await say(request, "@Match Time Pat out", STRANGER)).toMatchObject({
    handled: true,
    outcome: "hq-only-organisers",
    replyText: "Only Alex can change that.",
    react: null,
  });
  expect(await statusOf(db, U.player)).toBe("CONFIRMED");
});

const ADMIN_FACTS = { payerRef: "", count: 0, coveredRefs: [], undo: false, matchDay: "", phrase: "", note: "", lookbackMatches: 0 };

test("a player asking to change the fee: not done; one line naming who can, tagged or not (2026-10-20)", async ({ request, db }) => {
  const fee = async () =>
    (await db.one<{ f: number | null }>(`SELECT "feePerPlayer" AS f FROM "Match" WHERE id = $1`, [MATCH.upcoming]))?.f ?? null;
  const before = await fee();
  engineOn({
    "make the fee 6 pounds": { route: "admin_ops", facts: { action: "other", ...ADMIN_FACTS } },
    "@Match Time make the fee 6 pounds": { route: "admin_ops", facts: { action: "other", ...ADMIN_FACTS } },
  });
  const line = { handled: true, outcome: "hq-only-organisers", replyText: "Only Alex can change that.", react: null };
  expect(await say(request, "make the fee 6 pounds")).toMatchObject(line);
  expect(await say(request, "@Match Time make the fee 6 pounds")).toMatchObject(line);
  expect(await fee()).toBe(before);
});

test("a player asking for a free place: not theirs, one line naming who can", async ({ request, db }) => {
  engineOn({
    "@Match Time Tom is free this week": { route: "admin_ops", facts: { action: "fee_waiver", ...ADMIN_FACTS, coveredRefs: ["Tom"] } },
  });
  expect(await say(request, "@Match Time Tom is free this week")).toMatchObject({
    handled: true,
    outcome: "hq-only-organisers",
    replyText: "Only Alex can change that.",
    react: null,
  });
  const asked = await db.one<{ n: string }>(`SELECT count(*)::text AS n FROM "AdminGroupMessage" WHERE "orgId" = $1 AND "askRef" LIKE 'fee:%'`, [ORG_ID]);
  expect(asked?.n).toBe("0");
});

test("a player asking MatchTime to post the place-open ask in the players' group: still the organisers'", async ({ request }) => {
  engineOn({ "@Match Time ask the group if anyone can play": { route: "ask_group" } });
  expect(await say(request, "@Match Time ask the group if anyone can play")).toMatchObject({
    handled: true,
    outcome: "hq-only-organisers",
    react: null,
  });
});

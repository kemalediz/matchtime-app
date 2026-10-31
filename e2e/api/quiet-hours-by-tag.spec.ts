/**
 * QUIET HOURS BY TAGGING MATCHTIME (2026-10-31). MT Test: "@Match Time turn
 * off quiet hours now" from the owner routed admin_ops, was read `other`,
 * and got "I can't change that by message". Kemal: every admin feature also
 * works by tagging MatchTime in WhatsApp.
 *
 * Against a real Postgres and the real routes. The router and the admin
 * extractor are STUBBED ($0; what the real model reads for these words is
 * the paid check, scripts/live-check-quiet-hours.ts). Everything after is
 * the shipped code: the tag and organiser gates, and the one save core the
 * settings page uses (`quiet-hours-save.ts`), which releases a message the
 * old quiet hours were holding.
 *
 *   players' group   an owner switches them off: the held club post is
 *                    released, and the reply says so; then new times
 *   players' group   a player: the organisers-only line, nothing changed
 *   players' group   untagged: nothing changed, nothing said
 *   HQ               an owner switches them off, then on again (Turkish)
 *   HQ               a player: the organisers-only line
 */
import type { APIRequestContext } from "@playwright/test";
import { formatInTimeZone } from "date-fns-tz";
import { test, expect, postAnalyze, resetDb } from "../fixtures";
import { NAME, ORG_ID, PHONE } from "../helpers/constants";
import { E2E } from "../helpers/env";
import { engineOn, clearPipelineStubs } from "../helpers/stub";
import type { TestDb } from "../helpers/test-db";
import { messageHoursSendAfter } from "@/lib/message-hours";

test.describe.configure({ mode: "serial" });

const KEY = { "x-api-key": E2E.WHATSAPP_API_KEY };
const HQ = "120363777000000071@g.us";
const OFF = "@Match Time turn off quiet hours now";
const OFF_TR = "@Match Time sessiz saatleri kapat";
const ON_TR = "@Match Time sessiz saatleri tekrar aç";
const TIMES = "@Match Time quiet hours from 22:00 to 8am";
const UNTAGGED = "quiet hours off would be nice";

const quiet = (fields: Record<string, unknown>) => ({
  route: "admin_ops",
  facts: { action: "quiet_hours", quietOff: false, quietFrom: "", quietTo: "", toMatchTime: true, ...fields },
});

const london = (d: Date) => formatInTimeZone(d, "Europe/London", "HH:mm");
const row = (db: TestDb) =>
  db.one<{ enabled: boolean; from: string; to: string }>(
    `SELECT "quietHoursEnabled" AS enabled, "quietHoursFrom" AS "from", "quietHoursTo" AS "to" FROM "Organisation" WHERE id = $1`,
    [ORG_ID],
  );
const heldUntil = async (db: TestDb) =>
  (await db.one<{ sendAfter: Date | null }>(`SELECT "sendAfter" FROM "BotJob" WHERE id = 'e2e-qh-held'`))!.sendAfter;

/**
 * Quiet hours around NOW (an hour ago to two hours on), and a club post
 * queued five minutes ago that they hold to their end, stamped as
 * `messageHoursSendAfter` stamps a real hold.
 */
async function holdAPost(db: TestDb): Promise<Date> {
  const now = Date.now();
  const q = { enabled: true, from: london(new Date(now - 3_600_000)), to: london(new Date(now + 7_200_000)) };
  await db.run(`UPDATE "Organisation" SET "quietHoursEnabled" = true, "quietHoursFrom" = $2, "quietHoursTo" = $3 WHERE id = $1`, [ORG_ID, q.from, q.to]);
  const createdAt = new Date(now - 5 * 60_000);
  const sendAfter = messageHoursSendAfter(createdAt, q)!;
  await db.run(
    `INSERT INTO "BotJob" (id, "orgId", kind, text, "pollOptions", "createdAt", "sendAfter") VALUES ('e2e-qh-held', $1, 'group', 'the held club post', '{}', $2, $3)`,
    [ORG_ID, createdAt, sendAfter],
  );
  return sendAfter;
}

let seq = 0;
async function pg(request: APIRequestContext, body: string, who: "admin" | "player" = "admin", tagged = true) {
  const waMessageId = `e2e-qh-${Date.now()}-${++seq}`;
  const res = await postAnalyze(request, [{ waMessageId, body, authorPhone: PHONE[who], authorName: NAME[who], botMentioned: tagged }]);
  const mine = res.results.filter((r: { waMessageId: string }) => r.waMessageId === waMessageId);
  expect(mine, JSON.stringify(res.results)).toHaveLength(1);
  return mine[0] as { reply: string | null; intent: string };
}
async function hq(request: APIRequestContext, text: string, who: "admin" | "player" = "admin") {
  const res = await request.post("/api/whatsapp/admin-group", {
    headers: KEY,
    data: { channel: "admin-group", botMentioned: true, groupId: HQ, messageId: `e2e-qh-hq-${++seq}`, text, senderPhone: PHONE[who].replace(/^\+/, ""), timestamp: String(Math.floor(Date.now() / 1000)) },
  });
  expect(res.status(), await res.text()).toBe(200);
  return res.json() as Promise<{ outcome: string; replyText: string | null }>;
}

test.beforeEach(async ({ db }) => {
  resetDb();
  await db.run(`DELETE FROM "BotJob"`);
  engineOn({
    [OFF]: quiet({ quietOff: true }),
    [OFF_TR]: quiet({ quietOff: true }),
    [ON_TR]: quiet({}),
    [TIMES]: quiet({ quietFrom: "22:00", quietTo: "08:00" }),
    [UNTAGGED]: quiet({ quietOff: true, toMatchTime: false }),
  });
});

test.afterAll(() => {
  clearPipelineStubs();
  resetDb();
});

test("players' group: the owner switches quiet hours off, the held post is released, then sets new times", async ({ request, db }) => {
  const was = await holdAPost(db);
  expect((await heldUntil(db))?.getTime()).toBe(was.getTime());

  const off = await pg(request, OFF);
  expect(off).toMatchObject({ intent: "quiet-hours-off", reply: "✅ Quiet hours are off. The message I was holding goes out now." });
  expect((await row(db))?.enabled).toBe(false);
  // Released exactly as the settings page releases it: due on the next dispatch.
  expect(await heldUntil(db)).toBeNull();

  const times = await pg(request, TIMES);
  expect(times.reply).toBe("✅ Quiet hours are on, from 22:00 to 08:00. I'll hold my messages in that time.");
  expect(await row(db)).toEqual({ enabled: true, from: "22:00", to: "08:00" });
});

test("players' group: a player tagging it hears who can, and nothing changes", async ({ request, db }) => {
  const out = await pg(request, OFF, "player");
  expect(out.reply).toMatch(/^Only .+ can change that\.$/);
  expect((await row(db))?.enabled).toBe(true);
});

test("players' group: untagged, nothing changes and nothing is said", async ({ request, db }) => {
  const out = await pg(request, UNTAGGED, "admin", false);
  expect(out.reply ?? null).toBeNull();
  expect((await row(db))?.enabled).toBe(true);
});

test("HQ: the owner switches them off and on again, in Turkish; a player hears who can", async ({ request, db }) => {
  await db.run(`UPDATE "Organisation" SET "adminGroupId" = $2, "adminChannelMode" = 'admin-group', language = 'tr' WHERE id = $1`, [ORG_ID, HQ]);
  await holdAPost(db);

  const player = await hq(request, OFF_TR, "player");
  expect(player.outcome).toBe("hq-only-organisers");
  expect((await row(db))?.enabled).toBe(true);

  const off = await hq(request, OFF_TR);
  expect(off).toMatchObject({ outcome: "hq-quiet-hours-off", replyText: "✅ Sessiz saatler kapalı. Beklettiğim mesaj şimdi gidiyor." });
  expect(await heldUntil(db)).toBeNull();

  const on = await hq(request, ON_TR);
  expect(on.outcome).toBe("hq-quiet-hours-on");
  const r = await row(db);
  expect(r?.enabled).toBe(true);
  expect(on.replyText).toBe(`✅ Sessiz saatler açık: ${r!.from} ile ${r!.to} arası. Bu saatlerde mesajlarımı bekletirim.`);
});

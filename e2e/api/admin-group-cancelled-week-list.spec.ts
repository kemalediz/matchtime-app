/**
 * "WHAT'S THE LIST" ON A CANCELLED WEEK (FNF, 2026-10-23), against a real
 * Postgres and the real routes. The router and the question extractor are
 * STUBBED (what the models would have said); everything after is shipped
 * code: `loadSquadState`, the engine, the composer, and for the players'
 * group the analyze route's squad pass.
 *
 * THE INCIDENT. FNF's Friday 23 Oct game was cancelled on the 22nd. At
 * 09:51 UTC on the 23rd a player asked HQ "What's the list @Match Time"
 * and got "📋 Based on all the messages I've picked up, here's the latest
 * squad: 18/18 ✅ full squad." It was the 30 Oct squad (the rolling squad
 * had seeded it from 16 Oct), nothing said so, and everyone read it as
 * that night's. The answer now names its match and leads with the
 * cancellation.
 *
 * The world, rebuilt from the fixture club to FNF's shape: the last
 * played games a week and more ago, tonight's game CANCELLED, and the
 * next one (4 of 5, Ben Bench on the bench) a week away.
 */
import { formatInTimeZone } from "date-fns-tz";
import { tr as trLocale } from "date-fns/locale";
import type { APIRequestContext } from "@playwright/test";
import { test, expect, postAnalyze, resetDb } from "../fixtures";
import { ACTIVITY_ID, MATCH, ORG_ID, PHONE, londonAt } from "../helpers/constants";
import { E2E } from "../helpers/env";
import { engineOn, clearPipelineStubs } from "../helpers/stub";
import type { TestDb } from "../helpers/test-db";

test.describe.configure({ mode: "serial" });

const KEY = { "x-api-key": E2E.WHATSAPP_API_KEY };
const HQ = "120363777000000061@g.us";
const PLAYER = PHONE.player.replace(/^\+/, "");
const LONDON = "Europe/London";
const CANCELLED_ID = "e2e-match-cancelled-tonight";

const LIST_Q = "What's the list @Match Time";
const PLAYERS_Q = "@Match Time who's playing?";
const LIST_TR = "@Match Time liste ne?";

const q = (topic: string) => ({
  route: "question",
  facts: { topic, personRef: "", statedCount: -1, table: "none", listSize: -1, listEnd: "top", period: "none", periodCount: -1, periodUnit: "none", feature: "none" },
});

/** Tonight, later than now whatever time the suite runs: the cancelled
 *  game had not kicked off when FNF asked. */
const tonight = () => new Date(Date.now() + 2 * 60 * 60 * 1000);
const NEXT = londonAt(7, 20, 30);

let seq = 0;
async function askHq(request: APIRequestContext, text: string) {
  const res = await request.post("/api/whatsapp/admin-group", {
    headers: KEY,
    data: { channel: "admin-group", groupId: HQ, messageId: `e2e-agcw-${++seq}`, text, senderPhone: PLAYER, timestamp: String(Math.floor(Date.now() / 1000)) },
  });
  expect(res.status(), await res.text()).toBe(200);
  return res.json() as Promise<{ handled: boolean; outcome: string; replyText: string }>;
}

async function cancelTonight(db: TestDb, cancelled: boolean) {
  await db.run(`DELETE FROM "Match" WHERE id = $1`, [CANCELLED_ID]);
  if (!cancelled) return;
  const at = tonight();
  await db.run(
    `INSERT INTO "Match" (id, "activityId", date, "maxPlayers", status, "attendanceDeadline", "postMatchEndFlow", "updatedAt")
     VALUES ($1, $2, $3, 5, 'CANCELLED', $4, false, now())`,
    [CANCELLED_ID, ACTIVITY_ID, at, new Date(at.getTime() - 60 * 60 * 1000)],
  );
}

test.beforeAll(async ({ db }) => {
  resetDb();
  await db.run(`UPDATE "Organisation" SET "adminGroupId" = $2, "adminChannelMode" = 'admin-group' WHERE id = $1`, [ORG_ID, HQ]);
  // FNF's shape: the games played are a week and more back, the next is a week away.
  await db.run(`UPDATE "Match" SET date = now() - interval '7 days' WHERE id = $1`, [MATCH.pay]);
  await db.run(`UPDATE "Match" SET date = now() - interval '8 days' WHERE id = $1`, [MATCH.rate]);
  await db.run(`UPDATE "Match" SET date = $2, "attendanceDeadline" = $3 WHERE id = $1`, [
    MATCH.upcoming,
    NEXT,
    new Date(NEXT.getTime() - 5 * 60 * 60 * 1000),
  ]);
  engineOn({ [LIST_Q]: q("squad"), [PLAYERS_Q]: q("squad"), [LIST_TR]: q("squad") });
});

test.afterAll(() => {
  clearPipelineStubs();
  resetDb();
});

const nextLabel = () => formatInTimeZone(NEXT, LONDON, "EEE d MMM, HH:mm");
const tonightDay = () => formatInTimeZone(tonight(), LONDON, "EEE d MMM");

test("the incident, in HQ: tonight's match is cancelled, then the next match's squad, named", async ({ request, db }) => {
  await cancelTonight(db, true);
  const out = await askHq(request, LIST_Q);
  expect(out).toMatchObject({ handled: true, outcome: "hq-answered" });
  expect(out.replyText.startsWith(
    `❌ The match on *${tonightDay()}* is cancelled.\n\n📋 Here's the squad and bench for *${nextLabel()}*: *4/5*, need *1 more* 🙏`,
  ), out.replyText).toBe(true);
  expect(out.replyText).toContain("Pat Player");
  expect(out.replyText).toContain("Ben Bench");
  expect(out.replyText).not.toMatch(/[–—]/);
});

test("in Turkish", async ({ request, db }) => {
  await cancelTonight(db, true);
  await db.run(`UPDATE "Organisation" SET language = 'tr' WHERE id = $1`, [ORG_ID]);
  const out = await askHq(request, LIST_TR);
  await db.run(`UPDATE "Organisation" SET language = 'en' WHERE id = $1`, [ORG_ID]);
  expect(out).toMatchObject({ handled: true, outcome: "hq-answered" });
  const day = formatInTimeZone(tonight(), LONDON, "d MMMM EEEE", { locale: trLocale });
  const next = formatInTimeZone(NEXT, LONDON, "d MMMM EEEE HH:mm", { locale: trLocale });
  expect(out.replyText.startsWith(
    `❌ *${day}* maçı iptal edildi.\n\n📋 *${next}* maçının kadrosu ve yedekleri: *4/5*, *1 kişi daha* lazım 🙏`,
  ), out.replyText).toBe(true);
});

test("a normal week in HQ: the squad named for its match, no cancellation line", async ({ request, db }) => {
  await cancelTonight(db, false);
  const out = await askHq(request, LIST_Q);
  expect(out).toMatchObject({ handled: true, outcome: "hq-answered" });
  expect(out.replyText.startsWith(`📋 Here's the squad and bench for *${nextLabel()}*: *4/5*`), out.replyText).toBe(true);
  expect(out.replyText).not.toContain("cancelled");
});

test("the players' group, through the analyze route's squad pass: the same lines", async ({ request, db }) => {
  await cancelTonight(db, true);
  const id = `e2e-agcw-p-${++seq}`;
  const res = await postAnalyze(request, [{ waMessageId: id, body: PLAYERS_Q, authorPhone: PLAYER, authorName: "Pat Player", botMentioned: true }]);
  const reply = (res.results as Array<{ waMessageId: string; reply?: string | null }>).find((r) => r.waMessageId === id)?.reply ?? "";
  expect(reply.startsWith(
    `❌ The match on *${tonightDay()}* is cancelled.\n\n📋 Here's the squad and bench for *${nextLabel()}*: *4/5*`,
  ), reply).toBe(true);
});

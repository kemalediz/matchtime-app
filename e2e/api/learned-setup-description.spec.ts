/**
 * F3, LEARNED SETUP: THE READING USES THE GROUP DESCRIPTION (go-live
 * slice D3, 2026-10-12). /api/cron/learn-setup against a real Postgres
 * and the real route, with the model STUBBED through the test-only
 * `x-mt-test-setup-learning-stub` header (honoured only under
 * MT_TEST_MODE=1). Nothing here calls a model.
 *
 * The description WhatsApp shared at the add is stored masked on the
 * connect request beside the chat. Three clubs, one sweep each:
 *
 *   SUPPORTS  the description states a drop-out deadline that ONE message
 *             repeats, a fee per player the chat never mentions, and a
 *             masked bank line. The deadline is switched on (a message
 *             and the description are two sources), the fee is only
 *             suggested, the DM says which quote is the description's,
 *             and the masked line is nowhere.
 *   STALE     the description is out of date and the model (stubbed to be
 *             WRONG) answers from it alone, twice over. The description
 *             is one source, so nothing is switched and nothing is sent.
 *   SHORT     too little chat, a full description: nothing is read (no
 *             reading from the description alone), and both are deleted.
 *
 * In every case the description is deleted with the chat.
 */
import { test, expect, resetDb } from "../fixtures";
import { E2E, REPO_ROOT } from "../helpers/env";
import { testDb } from "../helpers/test-db";
import type { APIRequestContext } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";

interface Fx {
  groupSubject: string;
  description: string;
  weeklyGame: { dayOfWeek: number; time: string; venue: string; playersPerSide: number };
  history: Array<{ author: string; text: string; timestamp: string }>;
}
const fixture = (name: string) =>
  JSON.parse(readFileSync(path.join(REPO_ROOT, `src/lib/setup-learning/__fixtures__/${name}.json`), "utf8")) as Fx;
const supports = fixture("description-supports");
const stale = fixture("description-stale");

test.describe.configure({ mode: "serial" });

const CRON = { authorization: `Bearer ${E2E.CRON_SECRET}` };
const NOW = "2026-10-05T11:00:00Z"; // 12:00 London, daytime
const APPROVED = "2026-10-05T09:00:00Z";

const none = { confidence: "low", evidence: [] as string[] };
const BLANK = {
  regular_game: true,
  squad: { answer: "unclear", ...none },
  open_places: { answer: "unclear", ...none },
  drop_out_deadline: { day: "none", time: "none", ...none },
  list_published: { day: "none", time: "none", ...none },
  payments: { answer: "no_sign", ...none },
  monthly_list: { answer: "no_sign", prepay_for_month: false, pay_as_you_go_fill_ins: false, credit_for_missed_games: false, ...none },
  weekly_game: { day: "none", time: "none", venue: "", players_per_side: 0, ...none },
  match_fee: { amount: 0, currency: "none", basis: "none", ...none },
};

/** A correct answer: one quote from the message, one from the description
 *  (it ends in the description's full stop), and the fee from the
 *  description. The third deadline "quote" is the masked bank line. */
const SUPPORTS_ANSWER = {
  ...BLANK,
  drop_out_deadline: {
    day: "tuesday",
    time: "18:00",
    confidence: "high",
    evidence: ["drop out by Tuesday 6pm or you still pay, that hasn't changed", "Drop out by Tuesday 6pm or you still pay."],
  },
  payments: { answer: "players_confirm_paying", confidence: "high", evidence: ["Pay Kemal [number removed]", "[number removed]"] },
  match_fee: { amount: 6, currency: "pounds", basis: "per_player", confidence: "medium", evidence: ["£6 a player, pay before kick off."] },
};

/** A WRONG answer: everything taken from the out-of-date description. */
const STALE_WRONG_ANSWER = {
  ...BLANK,
  squad: { answer: "rolling", confidence: "high", evidence: ["Squad is the same every week", "only message if you can't play"] },
  drop_out_deadline: { day: "wednesday", time: "12:00", confidence: "high", evidence: ["Drop out by Wednesday noon", "Drop out by Wednesday noon."] },
};

const C = { org: "e2e-desc-supports", owner: "e2e-desc-supports-owner", phone: "+447700900971" };
const D = { org: "e2e-desc-stale", owner: "e2e-desc-stale-owner", phone: "+447700900972" };
const S = { org: "e2e-desc-short", owner: "e2e-desc-short-owner", phone: "+447700900973" };

async function sweep(request: APIRequestContext, answer: unknown) {
  const res = await request.get("/api/cron/learn-setup", {
    headers: {
      ...CRON,
      "x-test-now": NOW,
      "x-mt-test-setup-learning": "1",
      // Header values are Latin-1: the pound sign travels escaped.
      "x-mt-test-setup-learning-stub": JSON.stringify(answer).replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`),
    },
  });
  expect(res.status(), await res.text()).toBe(200);
  return res.json() as Promise<{ considered: number; outcomes: Array<{ orgId: string; outcome: { kind: string; reason?: string } }> }>;
}

async function seedClub(c: typeof C, fx: Fx, history: Fx["history"]) {
  const db = testDb();
  await db.run(
    `INSERT INTO "User" (id, name, email, "phoneNumber", onboarded, "isActive", "updatedAt") VALUES ($1,'Kemal Arslan',$2,$3,true,true,now())`,
    [c.owner, `${c.owner}@e2e-test.invalid`, c.phone],
  );
  await db.run(
    `INSERT INTO "Organisation" ("id","name","slug","inviteCode","approvalStatus","approvedAt","whatsappGroupId",
       "whatsappBotEnabled","language","settingsSetByOrganiser","createdAt","updatedAt")
     VALUES ($1,$2,$1,$3,'approved',$4,$5,true,'en','{}',now(),now())`,
    [c.org, fx.groupSubject, `${c.org}-invite`, APPROVED, `${c.org}@g.us`],
  );
  await db.run(`INSERT INTO "Membership" (id, "userId", "orgId", role) VALUES ($1,$2,$3,'OWNER')`, [`${c.owner}-mem`, c.owner, c.org]);
  await db.run(
    `INSERT INTO "Sport" ("id","orgId","name","playersPerTeam","positions","teamLabels","createdAt","updatedAt")
     VALUES ($1,$2,'Football',$3,ARRAY['GK','DEF','MID','FWD'],ARRAY['Red','Yellow'],now(),now())`,
    [`${c.org}-sport`, c.org, fx.weeklyGame.playersPerSide],
  );
  await db.run(
    `INSERT INTO "Activity" ("id","orgId","sportId","name","dayOfWeek","time","venue","isActive","deadlineHours","createdAt","updatedAt")
     VALUES ($1,$2,$3,'Weekly game',$4,$5,$6,true,5,now(),now())`,
    [`${c.org}-activity`, c.org, `${c.org}-sport`, fx.weeklyGame.dayOfWeek, fx.weeklyGame.time, fx.weeklyGame.venue],
  );
  // The description goes in as the group add stores it: already masked.
  await db.run(
    `INSERT INTO "ClubConnect" ("id","orgId","userId","phone","code","status","expiresAt","groupId","groupSubject","linkedAt",
       "capturedHistory","capturedDescription","updatedAt")
     VALUES ($1,$2,$3,$4,$5,'closed',$6,$7,$8,$6,$9::jsonb,$10,now())`,
    [
      `${c.org}-cc`,
      c.org,
      c.owner,
      c.phone.replace(/^\+/, ""),
      c.org.slice(-4).toUpperCase(),
      APPROVED,
      `${c.org}@g.us`,
      fx.groupSubject,
      JSON.stringify(history),
      fx.description,
    ],
  );
}

const settings = (id: string) =>
  testDb().one<{ squad: boolean; day: number | null; time: string | null; paid: boolean }>(
    `SELECT "rollingSquadEnabled" AS squad, "dropOutDeadlineDay" AS day, "dropOutDeadlineTime" AS time, "paymentTrackingEnabled" AS paid
       FROM "Organisation" WHERE id = $1`,
    [id],
  );
type Item = { key: string; evidence: string[]; fromDescription?: string[]; current?: string; detected?: string };
const learning = (id: string) =>
  testDb().one<{ status: string; reason: string | null; applied: Item[]; suggestions: Item[]; kept: Array<{ key: string; reason: string }> }>(
    `SELECT status, reason, applied, suggestions, kept FROM "ClubSetupLearning" WHERE "orgId" = $1`,
    [id],
  );
const captured = (id: string) =>
  testDb().one<{ h: unknown; d: string | null }>(`SELECT "capturedHistory" AS h, "capturedDescription" AS d FROM "ClubConnect" WHERE "orgId" = $1`, [id]);
const fee = (id: string) => testDb().one<{ fee: number | null }>(`SELECT "feePerPlayer" AS fee FROM "Activity" WHERE "orgId" = $1`, [id]);
const dms = (phone: string) =>
  testDb().all<{ text: string }>(`SELECT text FROM "PlatformJob" WHERE purpose = 'setup-learned' AND phone = $1`, [phone.replace(/^\+/, "")]);

test.beforeAll(() => resetDb());
test.afterAll(() => resetDb());

test("description + one message: the deadline is switched on, the fee is only suggested, and the DM says which quote is the description's", async ({
  request,
}) => {
  await seedClub(C, supports, supports.history);
  expect((await captured(C.org))!.d).toContain("Pay Kemal [number removed]");

  const r = await sweep(request, SUPPORTS_ANSWER);
  expect(r.outcomes.map((o) => [o.orgId, o.outcome.kind])).toEqual([[C.org, "done"]]);

  // Switched: the deadline, on a message and the description. Not payment
  // tracking: its only "evidence" was the masked bank line.
  expect(await settings(C.org)).toEqual({ squad: false, day: 2, time: "18:00", paid: false });
  const row = (await learning(C.org))!;
  expect(row.status).toBe("applied");
  expect(row.applied).toMatchObject([
    {
      key: "dropOutDeadline",
      evidence: ["drop out by Tuesday 6pm or you still pay, that hasn't changed", "Drop out by Tuesday 6pm or you still pay."],
      fromDescription: ["Drop out by Tuesday 6pm or you still pay."],
    },
  ]);
  // Suggested, never set: the fee stays empty on the weekly game.
  expect(row.suggestions).toEqual([
    {
      key: "matchFee",
      current: "",
      detected: "6",
      evidence: ["£6 a player, pay before kick off."],
      fromDescription: ["£6 a player, pay before kick off."],
    },
  ]);
  expect((await fee(C.org))!.fee).toBeNull();
  expect(JSON.stringify(row)).not.toMatch(/removed\]|Pay Kemal/);

  // The chat and the description are deleted together.
  expect(await captured(C.org)).toEqual({ h: null, d: null });

  const sent = await dms(C.phone);
  expect(sent).toHaveLength(1);
  const text = sent[0].text;
  expect(text).toContain(
    `✅ *Drop-out deadline:* Tuesday 18:00. MatchTime reminds the group before it.\n` +
      `From messages like: "drop out by Tuesday 6pm or you still pay, that hasn't changed"\n` +
      `From your group description: "Drop out by Tuesday 6pm or you still pay."\n` +
      `Undo or change: `,
  );
  expect(text).toMatch(
    /🔎 The match fee looks like £6 a player; your weekly game has no fee set\.\nFrom your group description: "£6 a player, pay before kick off\."\nSet it here: \S+\/r\/\S+/,
  );
  expect(text).not.toMatch(/removed\]|Pay Kemal|[—–]/);
});

test("a stale description the model leans on alone: one source, so nothing is switched and nothing is sent", async ({ request }) => {
  await seedClub(D, stale, stale.history);
  const r = await sweep(request, STALE_WRONG_ANSWER);
  expect(r.outcomes.map((o) => [o.orgId, o.outcome.kind])).toEqual([[D.org, "done"]]);

  expect(await settings(D.org)).toEqual({ squad: false, day: null, time: null, paid: false });
  const row = (await learning(D.org))!;
  expect(row).toMatchObject({ status: "nothing", applied: [], suggestions: [] });
  expect(row.kept).toEqual([
    { key: "rollingSquad", reason: "thin-evidence" },
    { key: "dropOutDeadline", reason: "thin-evidence" },
  ]);
  expect(await captured(D.org)).toEqual({ h: null, d: null });
  expect(await dms(D.phone)).toEqual([]);
});

test("too little chat: nothing is read from the description alone, and it is deleted with the chat", async ({ request }) => {
  await seedClub(S, supports, supports.history.slice(0, 5));
  const r = await sweep(request, SUPPORTS_ANSWER);
  expect(r.outcomes.map((o) => [o.orgId, o.outcome.kind, o.outcome.reason])).toEqual([[S.org, "skipped", "too-short"]]);

  expect(await settings(S.org)).toEqual({ squad: false, day: null, time: null, paid: false });
  expect(await learning(S.org)).toMatchObject({ status: "skipped", reason: "too-short" });
  expect(await captured(S.org)).toEqual({ h: null, d: null });
  expect(await dms(S.phone)).toEqual([]);
});

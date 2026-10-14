/**
 * PICTURE READING (2026-10-14), the server route against a real Postgres.
 *
 *   - flag off (the production default): every answer is "flag-off";
 *   - an owner's picture is read, a member's meme is not, a member's
 *     picture captioned "Teams" is;
 *   - a read claims one slot per message (a retry is a duplicate, no second
 *     model call), the club's picture cap holds at 10 a day, and the stub
 *     model's cost lands in OrgAiUsage like any other call;
 *   - at the club's AI cap nothing is read;
 *   - nothing of the picture, caption or transcript is stored.
 *
 * Deterministic: the model is the `x-mt-test-picture-stub` header.
 */
import { test, expect, resetDb } from "../fixtures";
import { ORG_ID, PHONE } from "../helpers/constants";
import { E2E } from "../helpers/env";
import type { APIRequestContext } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const NOW = "2026-10-09T17:00:00.000Z";
const DAY = "2026-10-09";
const OWNER = PHONE.admin.replace(/^\+/, "");
const MEMBER = PHONE.player.replace(/^\+/, "");
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0]).toString("base64");
const POSTER = "Poster: list of players for Friday 9 October 8:30pm at Harris Merton: 1. Shehryar 2. Imz";

function headers(extra: Record<string, string> = {}) {
  return {
    "x-api-key": E2E.WHATSAPP_API_KEY,
    "x-mt-test-picture-reading": "1",
    "x-test-now": NOW,
    "x-mt-test-picture-stub": POSTER,
    ...extra,
  };
}

async function call(request: APIRequestContext, data: Record<string, unknown>, extra: Record<string, string> = {}) {
  const res = await request.post("/api/whatsapp/picture", { headers: headers(extra), data });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

const read = (id: string, sender: string, caption?: string) => ({
  mode: "read",
  groupId: E2E.GROUP_ID,
  waMessageId: id,
  senderPhone: sender,
  caption,
  image: { data: JPEG, mediaType: "image/jpeg" },
});

test.beforeAll(() => resetDb());
test.afterAll(() => resetDb());
test.beforeEach(async ({ db }) => {
  await db.run(`DELETE FROM "SentNotification" WHERE kind = 'picture-read'`);
  await db.run(`DELETE FROM "OrgAiUsage" WHERE "orgId" = $1`, [ORG_ID]);
  await db.run(`UPDATE "Organisation" SET "aiDailyCapUsd" = NULL WHERE id = $1`, [ORG_ID]);
});

test("no api key: 401", async ({ request }) => {
  const res = await request.post("/api/whatsapp/picture", { data: { mode: "check" } });
  expect(res.status()).toBe(401);
});

test("flag off: nothing is read and nothing is counted", async ({ request, db }) => {
  const r = await call(request, read("pic-off", OWNER), { "x-mt-test-picture-reading": "0" });
  expect(r).toEqual({ read: false, reason: "flag-off" });
  expect(await db.all(`SELECT 1 FROM "SentNotification" WHERE kind = 'picture-read'`)).toHaveLength(0);
});

test("check: the owner yes, a member's meme no, a member's 'Teams' picture yes, an unknown group no", async ({ request }) => {
  const check = (sender: string, caption?: string, groupId: string = E2E.GROUP_ID) =>
    call(request, { mode: "check", groupId, waMessageId: "c1", senderPhone: sender, caption });
  expect(await check(OWNER)).toEqual({ read: true, why: "admin" });
  expect(await check(MEMBER, "lol")).toEqual({ read: false, reason: "not-qualifying" });
  expect(await check(MEMBER, "Teams for tonight")).toEqual({ read: true, why: "caption" });
  expect(await check(OWNER, undefined, "120363999999999999@g.us")).toEqual({ read: false, reason: "no-club" });
});

test("read: the owner's poster comes back as a prefixed transcript, booked to the club's AI usage", async ({ request, db }) => {
  const r = await call(request, read("pic-1", OWNER));
  expect(r).toEqual({ read: true, transcript: `[Picture] ${POSTER}` });
  // The AI ledger books on the real clock (ai-budget.ts), not the pinned
  // one; the row was cleared before this test, so there is one.
  const usage = await db.one<{ calls: number; costUsd: number }>(
    `SELECT calls, "costUsd" FROM "OrgAiUsage" WHERE "orgId" = $1`,
    [ORG_ID],
  );
  expect(usage?.calls).toBe(1);
  expect(Number(usage?.costUsd)).toBeCloseTo(0.0042, 5);
  // The claim row holds the ids only.
  const rows = await db.all<{ key: string }>(`SELECT key FROM "SentNotification" WHERE kind = 'picture-read'`);
  expect(rows.map((x) => x.key)).toEqual([`picture-read:${ORG_ID}:${DAY}:pic-1`]);
});

test("a retry of the same message is a duplicate: no second call, no second charge", async ({ request, db }) => {
  await call(request, read("pic-dup", OWNER));
  expect(await call(request, read("pic-dup", OWNER))).toEqual({ read: false, reason: "duplicate" });
  const usage = await db.one<{ calls: number }>(`SELECT calls FROM "OrgAiUsage" WHERE "orgId" = $1`, [ORG_ID]);
  expect(usage?.calls).toBe(1);
});

test("'Not about the game' is read with no transcript", async ({ request }) => {
  const r = await call(request, read("pic-meme", OWNER), { "x-mt-test-picture-stub": "Not about the game" });
  expect(r).toEqual({ read: true, transcript: null });
});

test("the club's picture cap: ten a day, the eleventh is refused before any call", async ({ request, db }) => {
  for (let i = 0; i < 10; i++) expect((await call(request, read(`cap-${i}`, OWNER))).read).toBe(true);
  expect(await call(request, read("cap-10", OWNER))).toEqual({ read: false, reason: "daily-cap" });
  const usage = await db.one<{ calls: number }>(`SELECT calls FROM "OrgAiUsage" WHERE "orgId" = $1`, [ORG_ID]);
  expect(usage?.calls).toBe(10);
});

test("at the club's AI cap nothing is read", async ({ request, db }) => {
  await db.run(`UPDATE "Organisation" SET "aiDailyCapUsd" = 0 WHERE id = $1`, [ORG_ID]);
  expect(await call(request, read("pic-capped", OWNER))).toEqual({ read: false, reason: "ai-cap" });
});

test("a picture that is not an image is refused", async ({ request }) => {
  const r = await call(request, { ...read("pic-bad", OWNER), image: { data: JPEG, mediaType: "image/heic" } });
  expect(r).toEqual({ read: false, reason: "bad-image" });
});

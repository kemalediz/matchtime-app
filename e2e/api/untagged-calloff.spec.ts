/**
 * AN ORGANISER CALLING THE GAME OFF WITHOUT A TAG (Vets MNF, 2026-10-26).
 * "Alright, so it's off gents, enjoy your evenings at home", untagged, from
 * an organiser, left the game live. Now: the group hears nothing, the
 * organiser is DM'd once ("Sounds like Monday is off. Reply *cancel* ..."),
 * and his yes cancels it through the one cancel core (the group is told).
 *
 * Against a real Postgres and the real analyze and dm-reply routes. The
 * router routes the message wherever it likes (stubbed: no mapping, so
 * none) and the call-off reader is STUBBED (`setCalloffStub`): "calloff"
 * for the group message, "yes" or "no" for his DM. Everything after is the
 * shipped code. $0: no model is called.
 *
 * Alex is the OWNER; Pat is a player.
 */
import { readFileSync } from "node:fs";
import { test, expect, postAnalyze, resetDb } from "../fixtures";
import { MATCH, NAME, ORG_ID, PHONE } from "../helpers/constants";
import { E2E } from "../helpers/env";
import { clearPipelineStubs, setCalloffStub, clearCalloffStub, engineOn } from "../helpers/stub";
import type { TestDb } from "../helpers/test-db";
import type { APIRequestContext } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const HEADERS = { "x-api-key": E2E.WHATSAPP_API_KEY };
const OFF = "Alright, so it's off gents, enjoy your evenings at home";
const ASKING = "Are we off for tonight?";
const YES = "yeah go on";
const NO = "no it's still on, found two more";
const UNRELATED = "what time is kickoff again";

let seq = 0;
const msgId = () => `e2e-calloff-${Date.now()}-${++seq}`;

async function say(request: APIRequestContext, body: string, who: "admin" | "player" = "admin", tagged = false) {
  const waMessageId = msgId();
  const res = await postAnalyze(request, [{ waMessageId, body, authorPhone: PHONE[who], authorName: NAME[who], botMentioned: tagged }]);
  const mine = res.results.filter((r: { waMessageId: string }) => r.waMessageId === waMessageId);
  expect(mine, JSON.stringify(res.results)).toHaveLength(1);
  return mine[0] as { reply: string | null; react: string | null; intent: string };
}

async function dm(request: APIRequestContext, body: string, who: "admin" | "player" = "admin") {
  const res = await request.post("/api/whatsapp/dm-reply", {
    headers: HEADERS,
    data: { phone: PHONE[who], body, waMessageId: msgId(), authorName: NAME[who] },
  });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

const status = async (db: TestDb) => (await db.one<{ status: string }>(`SELECT status FROM "Match" WHERE id = $1`, [MATCH.upcoming]))!.status;
const groupPosts = async (db: TestDb) =>
  (await db.all<{ text: string }>(`SELECT text FROM "BotJob" WHERE kind = 'group' AND "orgId" = $1 ORDER BY "createdAt"`, [ORG_ID])).map((p) => p.text);
const dmsTo = async (db: TestDb, who: "admin" | "player") =>
  (await db.all<{ text: string }>(`SELECT text FROM "BotJob" WHERE kind = 'dm' AND phone = $1 ORDER BY "createdAt"`, [PHONE[who].replace(/^\+/, "")])).map((p) => p.text);

test.beforeEach(async ({ db }) => {
  resetDb();
  clearPipelineStubs();
  // Monday 20:30, three hours from now: the club's next game.
  await db.run(`UPDATE "Match" SET date = now() + interval '3 hours', status = 'UPCOMING' WHERE id = $1`, [MATCH.upcoming]);
  await db.run(`DELETE FROM "BotJob"`);
  await db.run(`DELETE FROM "SentNotification" WHERE kind LIKE 'calloff-offer%'`);
  setCalloffStub({ bodies: { [OFF]: "calloff", [YES]: "yes", [NO]: "no" } });
});

test.afterAll(() => {
  clearPipelineStubs();
  resetDb();
});

test("an organiser, untagged: silent in the group, one DM; his yes cancels it and the group is told", async ({ request, db }) => {
  const out = await say(request, OFF);
  expect(out.reply ?? null).toBeNull();
  expect(out.react ?? null).toBeNull();
  expect(await status(db)).toBe("UPCOMING");
  expect(await groupPosts(db)).toHaveLength(0);
  const dms = await dmsTo(db, "admin");
  expect(dms).toHaveLength(1);
  expect(dms[0]).toMatch(/^Sounds like \w+day is off\. Reply \*cancel\* and I'll cancel it and tell the group, or ignore this if it's still on\.$/);

  // The reader saw the group's recent chat and that he is an organiser.
  const calls = readFileSync(`${E2E.CALLOFF_STUB_FILE}.calls`, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { label: string; user: string });
  const read = calls.find((c) => c.label === "calloff-reader")!;
  expect(read.user).toContain("THE CLUB'S NEXT GAME:");
  expect(read.user).toContain("an organiser of the club");

  // Said again: no second DM, and no second model call.
  await say(request, OFF);
  expect(await dmsTo(db, "admin")).toHaveLength(1);

  const reply = await dm(request, YES);
  expect(reply).toMatchObject({ handled: "calloff-cancelled", result: "cancelled" });
  expect(await status(db)).toBe("CANCELLED");
  expect(await groupPosts(db)).toEqual([expect.stringMatching(/^❌ \*Match cancelled\*/)]);
  const after = await dmsTo(db, "admin");
  expect(after[after.length - 1]).toMatch(/^Done: .+ is cancelled\. I've told the players' group\.$/);

  // Answered: his next DM is not read as this answer again.
  const again = await dm(request, YES);
  expect(again.handled).not.toBe("calloff-cancelled");
});

test("his no leaves the game on and says so; anything else is not taken as an answer", async ({ request, db }) => {
  await say(request, OFF);
  const other = await dm(request, UNRELATED);
  expect(String(other.handled ?? "")).not.toMatch(/^calloff/);
  expect(await status(db)).toBe("UPCOMING");

  const no = await dm(request, NO);
  expect(no).toMatchObject({ handled: "calloff-left-on" });
  expect(await status(db)).toBe("UPCOMING");
  const dms = await dmsTo(db, "admin");
  expect(dms[dms.length - 1]).toMatch(/^OK, I'll leave \w+day on\.$/);
  expect(await groupPosts(db)).toHaveLength(0);
});

test("a player saying it is off: nothing, no DM, no model call", async ({ request, db }) => {
  clearCalloffStub();
  setCalloffStub({ bodies: { [OFF]: "calloff" } });
  await say(request, OFF, "player");
  expect(await dmsTo(db, "player")).toHaveLength(0);
  expect(await dmsTo(db, "admin")).toHaveLength(0);
  let calls = "";
  try {
    calls = readFileSync(`${E2E.CALLOFF_STUB_FILE}.calls`, "utf8");
  } catch {
    calls = "";
  }
  expect(calls).not.toContain("calloff-reader");
});

test("an organiser asking whether it is off (the model says no call-off): nothing", async ({ request, db }) => {
  const out = await say(request, ASKING);
  expect(out.reply ?? null).toBeNull();
  expect(await dmsTo(db, "admin")).toHaveLength(0);
  expect(await status(db)).toBe("UPCOMING");
});

test("tagged: the tagged cancel path owns it, the reader is never asked", async ({ request, db }) => {
  await db.run(`UPDATE "Organisation" SET "adminGroupId" = NULL WHERE id = $1`, [ORG_ID]);
  const tagged = `@Match Time ${OFF}`;
  engineOn({ [tagged]: { route: "none" } });
  setCalloffStub({ bodies: { [tagged]: "calloff" } });
  await say(request, tagged, "admin", true);
  expect(await dmsTo(db, "admin")).toHaveLength(0);
});

test("no game in the next 7 days: nothing", async ({ request, db }) => {
  await db.run(`UPDATE "Match" SET date = now() + interval '9 days' WHERE id = $1`, [MATCH.upcoming]);
  await say(request, OFF);
  expect(await dmsTo(db, "admin")).toHaveLength(0);
});

test("a monthly club: his yes cancels through the same core", async ({ request, db }) => {
  await db.run(`UPDATE "Organisation" SET "squadMode" = 'monthly' WHERE id = $1`, [ORG_ID]);
  await say(request, OFF);
  expect(await dmsTo(db, "admin")).toHaveLength(1);
  const reply = await dm(request, YES);
  expect(reply).toMatchObject({ handled: "calloff-cancelled" });
  expect(await status(db)).toBe("CANCELLED");
  expect((await groupPosts(db))[0]).toMatch(/^❌ \*Match cancelled\*/);
});

test("Turkish club: the DM in Turkish", async ({ request, db }) => {
  await db.run(`UPDATE "Organisation" SET language = 'tr' WHERE id = $1`, [ORG_ID]);
  await say(request, OFF);
  const dms = await dmsTo(db, "admin");
  expect(dms).toHaveLength(1);
  expect(dms[0]).toMatch(/^\S+ maçı yapılmayacak gibi görünüyor\. \*iptal\* yazarsan maçı iptal edip gruba haber veririm\. Maç hâlâ yapılıyorsa bu mesajı boş ver\.$/);
});

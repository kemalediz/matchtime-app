/**
 * AN HQ LIST WHOSE MESSAGE IS DELETED, OR EDITED (2026-11-15, PR #606),
 * through the real admin-group and message-change routes and a real
 * database. DELETED: the pasted list's proposal is cancelled, so a later
 * YES applies nothing, MatchTime's own question about it loses its words,
 * and the YES is answered ONCE ("That list was changed, so I've dropped
 * it..."), never with silence. EDITED: MatchTime acts on what it read, as
 * it always has: the proposal stays, a YES applies it, and only the stored
 * words of the pasted message are forgotten. The squad reader and the
 * router are stubbed: no model call, $0. Made-up people from the fixture
 * world.
 */
import { test, expect, resetDb } from "../fixtures";
import { MATCH, ORG_ID, PHONE, U } from "../helpers/constants";
import { E2E } from "../helpers/env";
import { engineOn, clearPipelineStubs, setHqSquadReaderStub, clearHqSquadReaderStub, squadReading } from "../helpers/stub";
import type { APIRequestContext } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const KEY = { "x-api-key": E2E.WHATSAPP_API_KEY };
const HQ = "120363777000000061@g.us";
const ADMIN = PHONE.admin.replace(/^\+/, "");
const LIST = "Alex Admin\nColin Collector\nIan Innes\nZara Zest\nNaim Newman";
const CHANGED = "That list was changed, so I've dropped it. Paste it again and I'll read it.";

let seq = 0;
const bareId = () => `3EB0HQPASTE${Date.now().toString(16).toUpperCase()}${++seq}`;
const storedId = (bare: string) => `false_${HQ}_${bare}_${ADMIN}@c.us`;

async function say(request: APIRequestContext, text: string, messageId: string, extra: Record<string, unknown> = {}) {
  const res = await request.post("/api/whatsapp/admin-group", {
    headers: KEY,
    data: { channel: "admin-group", botMentioned: true, groupId: HQ, messageId, text, senderPhone: ADMIN, timestamp: String(Math.floor(Date.now() / 1000)), ...extra },
  });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

async function change(request: APIRequestContext, kind: "edit" | "revoke", bare: string) {
  const res = await request.post("/api/whatsapp/message-change", {
    headers: KEY,
    data: { kind, chatId: HQ, messageId: bare, byAdmin: false, senderJids: [`${ADMIN}@c.us`], senderPhone: ADMIN },
  });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

test.beforeAll(async ({ db }) => {
  resetDb();
  await db.run(`UPDATE "Organisation" SET "adminGroupId" = $2, "adminChannelMode" = 'admin-group' WHERE id = $1`, [ORG_ID, HQ]);
  engineOn({ YES: { route: "approve" }, [LIST]: { route: "other_att" } });
  setHqSquadReaderStub({ bodies: { [LIST]: squadReading(["Alex Admin", "Colin Collector", "Ian Innes", "Zara Zest", "Naim Newman"], { out: ["Pat Player"] }) } });
});

test.afterAll(() => {
  clearPipelineStubs();
  clearHqSquadReaderStub();
  resetDb();
});

const statusOf = async (db: import("../helpers/test-db").TestDb, userId: string) =>
  (await db.one<{ status: string }>(`SELECT status FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`, [MATCH.upcoming, userId]))?.status ?? null;

test("a pasted list whose message is then DELETED: the proposal is cancelled, MatchTime's question loses its words, and the YES is told once that the list was dropped", async ({ request, db }) => {
  const bare = bareId();
  const proposed = await say(request, LIST, storedId(bare));
  expect(proposed).toMatchObject({ outcome: "paste-proposed" });
  expect(await db.count(`SELECT count(*)::int AS c FROM "AdminSquadProposal" WHERE "waMessageId" = $1 AND "resolvedAt" IS NULL`, [storedId(bare)])).toBe(1);

  await change(request, "revoke", bare);
  expect(await db.one(`SELECT outcome, "playingNewNames" FROM "AdminSquadProposal" WHERE "waMessageId" = $1`, [storedId(bare)])).toEqual({
    outcome: "source-deleted",
    playingNewNames: [],
  });
  // MatchTime's own question repeated the names: its words go too.
  expect(await db.count(`SELECT count(*)::int AS c FROM "SentNotification" WHERE key = $1 AND text IS NOT NULL`, [`hqreply:${ORG_ID}:${storedId(bare)}`])).toBe(0);
  expect(await db.count(`SELECT count(*)::int AS c FROM "AdminGroupMessage" WHERE "askRef" = $1 AND text <> ''`, [`list:${storedId(bare)}`])).toBe(0);

  const yes = await say(request, "YES", `e2e-hqpaste-yes-${bare}`);
  expect(yes).toMatchObject({ handled: true, outcome: "paste-source-changed", replyText: CHANGED });
  // Nothing applied: Pat is still in, Zara still not.
  expect(await statusOf(db, U.player)).toBe("CONFIRMED");
  expect(await statusOf(db, U.extra)).toBeNull();
  // Once: a second YES is about nothing.
  const again = await say(request, "YES", `e2e-hqpaste-yes2-${bare}`);
  expect(again.replyText).not.toBe(CHANGED);
});

test("an edit recorded BEFORE the paste reaches HQ: the proposal stays open (an edit never cancels)", async ({ request, db }) => {
  const bare = bareId();
  await change(request, "edit", bare);
  const proposed = await say(request, LIST, storedId(bare));
  expect(proposed).toMatchObject({ outcome: "paste-proposed" });
  expect(await db.count(`SELECT count(*)::int AS c FROM "AdminSquadProposal" WHERE "waMessageId" = $1 AND "resolvedAt" IS NULL`, [storedId(bare)])).toBe(1);
});

test("a list dropped by its delete, then a NEW list pasted and applied: a later YES is not told the old list was changed", async ({ request, db }) => {
  const dropped = bareId();
  expect(await say(request, LIST, storedId(dropped))).toMatchObject({ outcome: "paste-proposed" });
  await change(request, "revoke", dropped);
  const fresh = bareId();
  expect(await say(request, LIST, storedId(fresh))).toMatchObject({ outcome: "paste-proposed" });
  expect(await say(request, "YES", `e2e-hqpaste-apply-${fresh}`)).toMatchObject({ outcome: "paste-applied" });
  const later = await say(request, "YES", `e2e-hqpaste-later-${fresh}`);
  expect(later.replyText).not.toBe(CHANGED);
  expect(await db.one(`SELECT outcome FROM "AdminSquadProposal" WHERE "waMessageId" = $1`, [storedId(dropped)])).toEqual({ outcome: "source-deleted" });
});

// Last: it applies the list.
test("a pasted list whose message is then EDITED by its author: the proposal stays open, and the YES applies it (MatchTime acts on what it read); the pasted words are forgotten", async ({ request, db }) => {
  // The test before applied the same list: Zara out again, so there is something to apply.
  await db.run(`DELETE FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`, [MATCH.upcoming, U.extra]);
  const bare = bareId();
  expect(await say(request, LIST, storedId(bare))).toMatchObject({ outcome: "paste-proposed" });
  await change(request, "edit", bare);
  expect(await db.count(`SELECT count(*)::int AS c FROM "AdminSquadProposal" WHERE "waMessageId" = $1 AND "resolvedAt" IS NULL`, [storedId(bare)])).toBe(1);
  expect(await db.count(`SELECT count(*)::int AS c FROM "AdminGroupMessage" WHERE "waMessageId" = $1`, [storedId(bare)])).toBe(0);
  const yes = await say(request, "YES", `e2e-hqpaste-edit-yes-${bare}`);
  expect(yes).toMatchObject({ outcome: "paste-applied" });
  expect(yes.replyText).not.toBe(CHANGED);
  // Applied: Zara is on the list again (in or, with the squad full, on the bench).
  expect(await statusOf(db, U.extra)).not.toBeNull();
});

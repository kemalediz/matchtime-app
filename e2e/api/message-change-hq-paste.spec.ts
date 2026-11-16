/**
 * AN HQ LIST WHOSE MESSAGE IS EDITED OR DELETED (2026-11-15, PR #606 round
 * 5), through the real admin-group and message-change routes and a real
 * database: the pasted list's proposal is cancelled, so a later YES applies
 * nothing, and the YES is answered ONCE ("That list was changed, so I've
 * dropped it..."), never with silence. The squad reader and the router are
 * stubbed: no model call, $0. Made-up people from the fixture world.
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

for (const kind of ["edit", "revoke"] as const) {
  test(`a pasted list whose message is then ${kind === "edit" ? "EDITED" : "DELETED"}: the proposal is cancelled, and the YES is told once that the list was dropped`, async ({ request, db }) => {
    const bare = bareId();
    const proposed = await say(request, LIST, storedId(bare));
    expect(proposed).toMatchObject({ outcome: "paste-proposed" });
    expect(await db.count(`SELECT count(*)::int AS c FROM "AdminSquadProposal" WHERE "waMessageId" = $1 AND "resolvedAt" IS NULL`, [storedId(bare)])).toBe(1);

    await change(request, kind, bare);
    expect(await db.one(`SELECT outcome, "playingNewNames" FROM "AdminSquadProposal" WHERE "waMessageId" = $1`, [storedId(bare)])).toEqual({
      outcome: "source-deleted",
      playingNewNames: [],
    });

    const yes = await say(request, "YES", `e2e-hqpaste-yes-${bare}`);
    expect(yes).toMatchObject({ handled: true, outcome: "paste-source-changed", replyText: CHANGED });
    // Nothing applied: Pat is still in, Zara still not.
    expect(await statusOf(db, U.player)).toBe("CONFIRMED");
    expect(await statusOf(db, U.extra)).toBeNull();
    // Once: a second YES is about nothing.
    const again = await say(request, "YES", `e2e-hqpaste-yes2-${bare}`);
    expect(again.replyText).not.toBe(CHANGED);
  });
}

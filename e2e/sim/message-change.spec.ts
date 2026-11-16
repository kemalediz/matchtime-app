/**
 * A MESSAGE DELETED FOR EVERYONE IS GONE FROM WHAT THE NEXT ANSWER IS
 * SHOWN; AN EDIT REPLACES IT (2026-11-15), through the REAL analyze,
 * message-change and admin-group routes and a REAL database.
 *
 * Each spec stores a member's message, deletes or edits it the way the Pi
 * now reports it (`POST /api/whatsapp/message-change`, by WhatsApp id and
 * group), then asks a following question and reads what the STUBBED model
 * was shown: the extractors' recent chat, the open answer's week of chat,
 * the unified answer's chat, players' group and HQ. No model call, $0.
 * Made-up people, simulated numbers.
 */
import { readFileSync } from "node:fs";
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import { createGroup, type SimGroup } from "./group";
import { clearExtractorStub, clearPipelineStubs, clearRouterStub, engineOn, selfOut } from "../helpers/stub";
import { E2E } from "../helpers/env";

const LIVE = process.env.MT_SIM_LIVE_LLM === "1";
const SECRET = "my door code is 4321, come round after";
const OTHER = "parking is free after 6";
const EMPTY = { personRef: "", statedCount: -1, table: "none", listSize: -1, listEnd: "top", period: "none", periodCount: -1, periodUnit: "none", feature: "none", badge: "none" };

function calls(): Array<{ label: string; user: string }> {
  try {
    return readFileSync(`${E2E.EXTRACTOR_STUB_FILE}.calls`, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { label: string; user: string });
  } catch {
    return [];
  }
}

/** The RECENT CHAT block of a user turn, one entry per line shown. */
function recentChatOf(user: string): string[] {
  const lines = user.split("\n");
  const start = lines.findIndex((l) => l.startsWith("RECENT CHAT"));
  if (start < 0) return [];
  const out: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (!l.startsWith("  ")) break;
    out.push(l.trim());
  }
  return out;
}

const digits = (p: string | null) => (p ?? "").replace(/\D/g, "");
/** A stored id as the Pi sends it: `false_<group>_<id>_<participant>`. */
const storedId = (chat: string, bare: string, phone: string | null) => `false_${chat}_${bare}_${digits(phone)}@c.us`;
let seq = 0;
const bareId = () => `3EB0E2E${Date.now().toString(16).toUpperCase()}${++seq}`;

async function change(request: APIRequestContext, body: Record<string, unknown>) {
  const res = await request.post("/api/whatsapp/message-change", { headers: { "x-api-key": E2E.WHATSAPP_API_KEY }, data: body });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

/** Dan's secret and Pete's ordinary line, analysed and stored. */
async function storeTwoLines(g: SimGroup): Promise<string> {
  const bare = bareId();
  await g.postBatch([
    { player: "dan", body: SECRET, route: "none", waMessageId: storedId(g.groupId, bare, g.player("dan").phone) },
    { player: "pete", body: OTHER, route: "none" },
  ]);
  return bare;
}

(LIVE ? test.describe.skip : test.describe)("a deleted or edited message, and the next answer", () => {
  test.describe.configure({ mode: "serial" });
  test.beforeAll(resetDb);
  test.beforeEach(() => clearExtractorStub());
  test.afterEach(() => {
    clearRouterStub();
    clearExtractorStub();
  });
  test.afterAll(() => clearPipelineStubs());

  test("deleted: the stored row keeps no words, and the next extractor's recent chat has no trace of it", async ({ request, db }) => {
    const g = await createGroup(request, db, { attendance: [{ key: "pete", status: "CONFIRMED" as const }] });
    const bare = await storeTwoLines(g);

    const r = await change(request, { kind: "revoke", chatId: g.groupId, messageId: bare });
    expect(r).toMatchObject({ ok: true, kind: "revoke", analyzed: 1 });
    const row = await db.one<{ body: string | null; reasoning: string | null }>(
      `SELECT body, reasoning FROM "AnalyzedMessage" WHERE "waMessageId" = $1`,
      [storedId(g.groupId, bare, g.player("dan").phone)],
    );
    expect(row).toEqual({ body: null, reasoning: null });

    const res = await g.postBatch([{ player: "pete", body: "@Match Time out", tag: true, route: "self_att", facts: selfOut() }]);
    expect(res.results[0].react).toBe("👋");
    const call = calls().find((c) => c.user.endsWith("@Match Time out"));
    expect(call, "the attendance extractor was called for Pete's OUT").toBeTruthy();
    expect(recentChatOf(call!.user)).toEqual([`${g.player("pete").name}: ${OTHER}`]);
    expect(JSON.stringify(calls())).not.toContain("4321");
  });

  test("deleted: a tagged question's open answer is shown the week without it", async ({ request, db }) => {
    const g = await createGroup(request, db);
    const bare = await storeTwoLines(g);
    await change(request, { kind: "revoke", chatId: g.groupId, messageId: bare });

    const Q = "@Match Time what did Dan say earlier?";
    const res = await g.postBatch([{ player: "pete", body: Q, tag: true, route: "question", facts: { ...EMPTY, topic: "other", kind: "other", answer: "Nothing I can see." } }]);
    expect(res.results[0].reply).toBe("Nothing I can see.");
    const answer = calls().find((c) => c.label === "open-answer" && c.user.trimEnd().endsWith(Q));
    expect(answer, "the open answer was asked").toBeTruthy();
    expect(answer!.user).toContain(OTHER);
    expect(answer!.user).not.toContain("4321");
  });

  test("deleted: the unified answer is shown the chat without it", async ({ request, db }) => {
    const g = await createGroup(request, db);
    const bare = await storeTwoLines(g);
    await change(request, { kind: "revoke", chatId: g.groupId, messageId: bare });

    const Q = "@Match Time anything new from Dan?";
    const res = await g.postBatch(
      [{ player: "pete", body: Q, tag: true, route: "question", facts: { ...EMPTY, topic: "other", kind: "other", answer: "Not that I can see." } }],
      { headers: { "x-mt-test-unified-answers": "1" } },
    );
    expect(res.results[0].reply).toBe("Not that I can see.");
    const answer = calls().find((c) => c.label === "unified-answer" && c.user.trimEnd().endsWith(Q));
    expect(answer, "the unified answer was asked").toBeTruthy();
    expect(answer!.user).toContain(OTHER);
    expect(answer!.user).not.toContain("4321");
  });

  test("edited by its author: the next recent chat carries the new words, never the old", async ({ request, db }) => {
    const g = await createGroup(request, db, { attendance: [{ key: "pete", status: "CONFIRMED" as const }] });
    const bare = await storeTwoLines(g);
    const dan = g.player("dan");
    const r = await change(request, {
      kind: "edit",
      chatId: g.groupId,
      messageId: bare,
      text: "see you all at 8",
      senderJids: [`${digits(dan.phone)}@c.us`],
      senderPhone: digits(dan.phone),
    });
    expect(r).toMatchObject({ ok: true, analyzed: 1, editsRefused: 0 });

    await g.postBatch([{ player: "pete", body: "@Match Time out", tag: true, route: "self_att", facts: selfOut() }]);
    const call = calls().find((c) => c.user.endsWith("@Match Time out"));
    expect(recentChatOf(call!.user)).toEqual([`${dan.name}: see you all at 8`, `${g.player("pete").name}: ${OTHER}`]);
    expect(JSON.stringify(calls())).not.toContain("4321");
  });

  test("HQ: a deleted organiser's message leaves the log, and the next HQ answer is shown the chat without it", async ({ request, db }) => {
    const g = await createGroup(request, db);
    const HQ = `${g.groupId.replace("@g.us", "")}-hq@g.us`;
    await db.run(`UPDATE "Organisation" SET "adminGroupId" = $2, "adminChannelMode" = 'admin-group' WHERE id = $1`, [g.orgId, HQ]);
    const alice = g.player("alice");
    const bare = bareId();
    const Q = "@Match Time what did Alice say?";
    engineOn({
      [SECRET]: { route: "none" },
      [OTHER]: { route: "none" },
      [Q]: { route: "question", facts: { ...EMPTY, topic: "other", kind: "other", answer: "Nothing to report." } },
    });
    const hq = (messageId: string, text: string, botMentioned = false) =>
      request.post("/api/whatsapp/admin-group", {
        headers: { "x-api-key": E2E.WHATSAPP_API_KEY, "x-mt-test-unified-answers": "1" },
        data: { channel: "admin-group", botMentioned, groupId: HQ, messageId, text, senderPhone: digits(alice.phone), timestamp: String(Math.floor(Date.now() / 1000)) },
      });
    expect((await hq(storedId(HQ, bare, alice.phone), SECRET)).status()).toBe(200);
    expect((await hq(storedId(HQ, bareId(), alice.phone), OTHER)).status()).toBe(200);
    expect(await db.count(`SELECT count(*)::int AS c FROM "AdminGroupMessage" WHERE "orgId" = $1 AND text = $2`, [g.orgId, SECRET])).toBe(1);

    const r = await change(request, { kind: "revoke", chatId: HQ, messageId: bare });
    expect(r).toMatchObject({ ok: true, hq: 1 });
    expect(await db.count(`SELECT count(*)::int AS c FROM "AdminGroupMessage" WHERE "orgId" = $1 AND "waMessageId" = $2`, [g.orgId, storedId(HQ, bare, alice.phone)])).toBe(0);

    const asked = await hq(storedId(HQ, bareId(), alice.phone), Q, true);
    expect(asked.status(), await asked.text()).toBe(200);
    const answer = calls().find((c) => c.label === "unified-answer" && c.user.trimEnd().endsWith(Q));
    expect(answer, "the unified answer was asked in HQ").toBeTruthy();
    expect(answer!.user).toContain(OTHER);
    expect(answer!.user).not.toContain("4321");
  });
});

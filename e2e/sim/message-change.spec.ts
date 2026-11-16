/**
 * A MESSAGE DELETED FOR EVERYONE IS GONE FROM WHAT THE NEXT ANSWER IS
 * SHOWN; AN EDITED ONE'S ORIGINAL WORDS ARE FORGOTTEN, BUT WHAT MATCHTIME
 * READ STILL COUNTS (2026-11-15), through the REAL analyze, message-change
 * and admin-group routes and a REAL database.
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
import { clearExtractorStub, clearPipelineStubs, clearRouterStub, engineOn, selfIn, selfOut } from "../helpers/stub";
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

/** A delete as the Pi posts it, sent by a member of the group (the author, unless said). */
function revokeBy(g: SimGroup, key: string, bare: string, chatId = g.groupId, byAdmin = false) {
  const phone = digits(g.player(key).phone);
  return { kind: "revoke", chatId, messageId: bare, byAdmin, senderJids: [`${phone}@c.us`], senderPhone: phone };
}

/** An author's edit as the Pi posts it: no words. */
function editBy(g: SimGroup, key: string, bare: string, chatId = g.groupId) {
  const phone = digits(g.player(key).phone);
  return { kind: "edit", chatId, messageId: bare, senderJids: [`${phone}@c.us`], senderPhone: phone };
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

    const r = await change(request, revokeBy(g, "dan", bare));
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
    await change(request, revokeBy(g, "dan", bare));

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
    await change(request, revokeBy(g, "dan", bare));

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

  test("edited by its author: a purge. The next recent chat has neither the old words nor the new", async ({ request, db }) => {
    const g = await createGroup(request, db, { attendance: [{ key: "pete", status: "CONFIRMED" as const }] });
    const bare = await storeTwoLines(g);
    // Even if a Pi sent the new words, they are never stored.
    const r = await change(request, { ...editBy(g, "dan", bare), text: "see you all at 8" });
    expect(r).toMatchObject({ ok: true, analyzed: 1, refused: 0 });
    expect(await db.one(`SELECT reason FROM "DeletedMessage" WHERE "chatId" = $1 AND "waMessageId" = $2`, [g.groupId, bare])).toEqual({ reason: "edited" });

    await g.postBatch([{ player: "pete", body: "@Match Time out", tag: true, route: "self_att", facts: selfOut() }]);
    const call = calls().find((c) => c.user.endsWith("@Match Time out"));
    expect(recentChatOf(call!.user)).toEqual([`${g.player("pete").name}: ${OTHER}`]);
    expect(JSON.stringify(calls())).not.toContain("4321");
    expect(JSON.stringify(calls())).not.toContain("see you all at 8");
    expect(await db.count(`SELECT count(*)::int AS c FROM "AnalyzedMessage" WHERE body LIKE '%see you all at 8%'`)).toBe(0);
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

    const r = await change(request, { kind: "revoke", chatId: HQ, messageId: bare, byAdmin: false, senderJids: [`${digits(alice.phone)}@c.us`], senderPhone: digits(alice.phone) });
    expect(r).toMatchObject({ ok: true, hq: 1 });
    expect(await db.count(`SELECT count(*)::int AS c FROM "AdminGroupMessage" WHERE "orgId" = $1 AND "waMessageId" = $2`, [g.orgId, storedId(HQ, bare, alice.phone)])).toBe(0);

    const asked = await hq(storedId(HQ, bareId(), alice.phone), Q, true);
    expect(asked.status(), await asked.text()).toBe(200);
    const answer = calls().find((c) => c.label === "unified-answer" && c.user.trimEnd().endsWith(Q));
    expect(answer, "the unified answer was asked in HQ").toBeTruthy();
    expect(answer!.user).toContain(OTHER);
    expect(answer!.user).not.toContain("4321");
  });

  // ── Round 2 (two reviews of #606) ──────────────────────────────────

  const Q_OPEN = { route: "question", facts: { ...EMPTY, topic: "other", kind: "other", answer: "Nothing I can see." } };

  test("a reply quoting a message deleted inside the Pi's window (never stored): no model call sees the quote", async ({ request, db }) => {
    const g = await createGroup(request, db);
    const bare = bareId();
    // The delete lands first: nothing was ever stored, so only the tombstone holds it.
    expect(await change(request, revokeBy(g, "dan", bare))).toMatchObject({ ok: true, analyzed: 0 });
    const Q = "@Match Time is that right?";
    await g.postBatch([{ player: "pete", body: Q, tag: true, ...Q_OPEN, quote: { id: bare, text: SECRET, authorJid: `${digits(g.player("dan").phone)}@c.us` } }]);
    expect(calls().some((c) => c.user.includes(Q))).toBe(true);
    expect(JSON.stringify(calls())).not.toContain("4321");
  });

  test("a reply quoting a stored message that was then deleted: no model call sees the quote", async ({ request, db }) => {
    const g = await createGroup(request, db);
    const bare = await storeTwoLines(g);
    await change(request, revokeBy(g, "dan", bare));
    const Q = "@Match Time what did he mean?";
    await g.postBatch([{ player: "pete", body: Q, tag: true, ...Q_OPEN, quote: { id: storedId(g.groupId, bare, g.player("dan").phone), text: SECRET, authorJid: `${digits(g.player("dan").phone)}@c.us` } }]);
    expect(calls().some((c) => c.user.includes(Q))).toBe(true);
    expect(JSON.stringify(calls())).not.toContain("4321");
  });

  test("the original arriving AFTER its delete (a replay after a restart) is never stored or shown", async ({ request, db }) => {
    const g = await createGroup(request, db, { attendance: [{ key: "pete", status: "CONFIRMED" as const }] });
    const bare = bareId();
    const id = storedId(g.groupId, bare, g.player("dan").phone);
    await change(request, revokeBy(g, "dan", bare));
    await g.postBatch([
      { player: "dan", body: SECRET, route: "none", waMessageId: id },
      { player: "pete", body: OTHER, route: "none" },
    ]);
    expect(await db.count(`SELECT count(*)::int AS c FROM "AnalyzedMessage" WHERE body LIKE '%4321%'`)).toBe(0);
    await g.postBatch([{ player: "pete", body: "@Match Time out", tag: true, route: "self_att", facts: selfOut() }]);
    const call = calls().find((c) => c.user.endsWith("@Match Time out"));
    expect(recentChatOf(call!.user)).toEqual([`${g.player("pete").name}: ${OTHER}`]);
    expect(JSON.stringify(calls())).not.toContain("4321");
  });

  test("a delete by somebody who is neither the author nor a group admin changes nothing", async ({ request, db }) => {
    const g = await createGroup(request, db);
    const bare = await storeTwoLines(g);
    expect(await change(request, revokeBy(g, "pete", bare))).toMatchObject({ ok: true, analyzed: 0, refused: 1 });
    expect(await db.count(`SELECT count(*)::int AS c FROM "AnalyzedMessage" WHERE body = $1`, [SECRET])).toBe(1);
    // A group admin's delete of the same message does apply.
    expect(await change(request, revokeBy(g, "pete", bare, g.groupId, true))).toMatchObject({ ok: true, analyzed: 1 });
    expect(await db.count(`SELECT count(*)::int AS c FROM "AnalyzedMessage" WHERE body = $1`, [SECRET])).toBe(0);
  });

  test("an edit arriving after its delete (reversed order) puts nothing back; a retried delete changes nothing more", async ({ request, db }) => {
    const g = await createGroup(request, db);
    const bare = await storeTwoLines(g);
    const dan = g.player("dan");
    const del = revokeBy(g, "dan", bare);
    expect(await change(request, del)).toMatchObject({ analyzed: 1 });
    // The Pi's retry of the same delete (its first answer was lost): the same, idempotent.
    expect(await change(request, del)).toMatchObject({ ok: true, analyzed: 0, archived: 0, hq: 0 });
    await change(request, { kind: "edit", chatId: g.groupId, messageId: bare, text: "my door code is 4321, sorry", senderJids: [`${digits(dan.phone)}@c.us`], senderPhone: digits(dan.phone) });
    expect(await db.count(`SELECT count(*)::int AS c FROM "AnalyzedMessage" WHERE body LIKE '%4321%'`)).toBe(0);
    expect(await db.count(`SELECT count(*)::int AS c FROM "DeletedMessage" WHERE "chatId" = $1 AND "waMessageId" = $2`, [g.groupId, bare])).toBe(1);
  });

  test("the archive, the mentions and the organiser lines: every copy goes", async ({ request, db }) => {
    const g = await createGroup(request, db, { features: { squadFromList: true } });
    const bare = bareId();
    const dan = g.player("dan");
    const id = storedId(g.groupId, bare, dan.phone);
    await g.postBatch([
      { player: "dan", body: `${SECRET} @447700900777`, route: "none", waMessageId: id, mentions: [{ jid: "447700900777@c.us", name: "Somebody", phone: "447700900777" }] },
    ]);
    // An organiser line of the same message, as ask-source-group keeps them.
    await db.run(
      `INSERT INTO "AdminGroupMessage" (id, "orgId", "waMessageId", "fromMatchTime", text, "createdAt") VALUES ($1, $2, $3, false, $4, now())`,
      [`e2e-org-line-${bare}`, g.orgId, `group:${id}`, SECRET],
    );
    expect(await db.count(`SELECT count(*)::int AS c FROM "GroupMessage" WHERE "waMessageId" = $1 AND body LIKE '%4321%'`, [id])).toBe(1);
    expect(await db.count(`SELECT count(*)::int AS c FROM "MessageMentions" WHERE "waMessageId" = $1`, [id])).toBe(1);

    expect(await change(request, revokeBy(g, "dan", bare))).toMatchObject({ ok: true, analyzed: 1, archived: 1, hq: 1, mentions: 1 });
    expect(await db.one(`SELECT body FROM "GroupMessage" WHERE "waMessageId" = $1`, [id])).toEqual({ body: "" });
    expect(await db.count(`SELECT count(*)::int AS c FROM "MessageMentions" WHERE "waMessageId" = $1`, [id])).toBe(0);
    expect(await db.count(`SELECT count(*)::int AS c FROM "AdminGroupMessage" WHERE "waMessageId" = $1`, [`group:${id}`])).toBe(0);
  });

  test("HQ: the original and its delete arriving together, in either order, never leave the words behind", async ({ request, db }) => {
    const g = await createGroup(request, db);
    const HQ = `${g.groupId.replace("@g.us", "")}-hq2@g.us`;
    await db.run(`UPDATE "Organisation" SET "adminGroupId" = $2, "adminChannelMode" = 'admin-group' WHERE id = $1`, [g.orgId, HQ]);
    const alice = g.player("alice");
    const post = (messageId: string) =>
      request.post("/api/whatsapp/admin-group", {
        headers: { "x-api-key": E2E.WHATSAPP_API_KEY },
        data: {
          channel: "admin-group",
          botMentioned: false,
          groupId: HQ,
          messageId,
          text: `${SECRET} @447700900777`,
          mentions: ["447700900777@c.us"],
          mentionNames: [{ jid: "447700900777@c.us", name: "Somebody", phone: "447700900777" }],
          senderPhone: digits(alice.phone),
          timestamp: String(Math.floor(Date.now() / 1000)),
        },
      });
    const del = (bare: string) => change(request, { kind: "revoke", chatId: HQ, messageId: bare, byAdmin: false, senderJids: [`${digits(alice.phone)}@c.us`], senderPhone: digits(alice.phone) });
    for (let i = 0; i < 6; i++) {
      const bare = bareId();
      const id = storedId(HQ, bare, alice.phone);
      if (i % 3 === 2) {
        await del(bare); // the delete first, then the original
        const res = await post(id);
        expect(res.status()).toBe(200);
      } else {
        const [res] = await Promise.all([post(id), del(bare)]);
        expect(res.status()).toBe(200);
      }
      expect(await db.count(`SELECT count(*)::int AS c FROM "AdminGroupMessage" WHERE "waMessageId" = $1`, [id])).toBe(0);
      expect(await db.count(`SELECT count(*)::int AS c FROM "MessageMentions" WHERE "waMessageId" = $1`, [id])).toBe(0);
    }
    expect(await db.count(`SELECT count(*)::int AS c FROM "AdminGroupMessage" WHERE "orgId" = $1 AND text LIKE '%4321%'`, [g.orgId])).toBe(0);
  });

  test("a failed post (no tombstone table: a deploy before the migration) changes nothing and breaks no door; the Pi's retry then applies it", async ({ request, db }) => {
    const g = await createGroup(request, db);
    const bare = await storeTwoLines(g);
    await db.run(`ALTER TABLE "DeletedMessage" RENAME TO "DeletedMessage_offline"`);
    try {
      const failed = await request.post("/api/whatsapp/message-change", { headers: { "x-api-key": E2E.WHATSAPP_API_KEY }, data: revokeBy(g, "dan", bare) });
      expect(failed.status()).toBe(500);
      expect(await failed.json()).toEqual({ ok: false, error: "not applied" });
      expect(await db.count(`SELECT count(*)::int AS c FROM "AnalyzedMessage" WHERE body = $1`, [SECRET])).toBe(1);
      // The doors still read and store with no table to check.
      const res = await g.postBatch([{ player: "pete", body: "still here", route: "none" }]);
      expect(res.results).toHaveLength(1);
    } finally {
      await db.run(`ALTER TABLE "DeletedMessage_offline" RENAME TO "DeletedMessage"`);
    }
    // The Pi's outbox retries the same body.
    expect(await change(request, revokeBy(g, "dan", bare))).toMatchObject({ ok: true, analyzed: 1 });
    expect(await db.count(`SELECT count(*)::int AS c FROM "AnalyzedMessage" WHERE body = $1`, [SECRET])).toBe(0);
  });

  test("a delete landing while its batch is being analysed: nothing of it is left stored", async ({ request, db }) => {
    const g = await createGroup(request, db, { features: { squadFromList: true } });
    for (let i = 0; i < 3; i++) {
      const bare = bareId();
      const id = storedId(g.groupId, bare, g.player("dan").phone);
      await Promise.all([g.postBatch([{ player: "dan", body: `${SECRET} #${i}`, route: "none", waMessageId: id }]), change(request, revokeBy(g, "dan", bare))]);
      expect(await db.count(`SELECT count(*)::int AS c FROM "AnalyzedMessage" WHERE "waMessageId" = $1 AND body IS NOT NULL`, [id])).toBe(0);
      expect(await db.count(`SELECT count(*)::int AS c FROM "GroupMessage" WHERE "waMessageId" = $1 AND body <> ''`, [id])).toBe(0);
    }
  });

  // ── Round 3: an edit is a purge, and the cases the second reviews proved ──

  test("an edit landing while its batch is analysed: nothing of the original is left stored", async ({ request, db }) => {
    const g = await createGroup(request, db, { features: { squadFromList: true } });
    for (let i = 0; i < 3; i++) {
      const bare = bareId();
      const id = storedId(g.groupId, bare, g.player("dan").phone);
      await Promise.all([g.postBatch([{ player: "dan", body: `${SECRET} #${i}`, route: "none", waMessageId: id }]), change(request, editBy(g, "dan", bare))]);
      expect(await db.count(`SELECT count(*)::int AS c FROM "AnalyzedMessage" WHERE "waMessageId" = $1 AND body IS NOT NULL`, [id])).toBe(0);
      expect(await db.count(`SELECT count(*)::int AS c FROM "GroupMessage" WHERE "waMessageId" = $1 AND body <> ''`, [id])).toBe(0);
    }
  });

  test("edits reordered or repeated by retries, an edit then a delete, a delete then an edit: always the same purge", async ({ request, db }) => {
    const g = await createGroup(request, db);
    for (const order of [["edit", "edit"], ["edit", "revoke"], ["revoke", "edit"]]) {
      const bare = await storeTwoLines(g);
      for (const kind of order) await change(request, kind === "edit" ? { ...editBy(g, "dan", bare), text: `edit ${kind}` } : revokeBy(g, "dan", bare));
      expect(await db.count(`SELECT count(*)::int AS c FROM "AnalyzedMessage" WHERE "groupId" = $1 AND body LIKE '%4321%'`, [g.groupId])).toBe(0);
      const t = await db.one<{ reason: string }>(`SELECT reason FROM "DeletedMessage" WHERE "chatId" = $1 AND "waMessageId" = $2`, [g.groupId, bare]);
      expect(t?.reason).toBe(order.includes("revoke") ? "deleted" : "edited");
    }
    expect(await db.count(`SELECT count(*)::int AS c FROM "AnalyzedMessage" WHERE body LIKE 'edit %'`)).toBe(0);
  });

  test("an edit by somebody else is ignored entirely", async ({ request, db }) => {
    const g = await createGroup(request, db);
    const bare = await storeTwoLines(g);
    expect(await change(request, editBy(g, "pete", bare))).toMatchObject({ ok: true, analyzed: 0, refused: 1 });
    expect(await db.count(`SELECT count(*)::int AS c FROM "AnalyzedMessage" WHERE body = $1`, [SECRET])).toBe(1);
  });

  test("HQ: the original and its author's edit arriving together never leave the original behind", async ({ request, db }) => {
    const g = await createGroup(request, db);
    const HQ = `${g.groupId.replace("@g.us", "")}-hq3@g.us`;
    await db.run(`UPDATE "Organisation" SET "adminGroupId" = $2, "adminChannelMode" = 'admin-group' WHERE id = $1`, [g.orgId, HQ]);
    const alice = g.player("alice");
    for (let i = 0; i < 6; i++) {
      const bare = bareId();
      const id = storedId(HQ, bare, alice.phone);
      const post = request.post("/api/whatsapp/admin-group", {
        headers: { "x-api-key": E2E.WHATSAPP_API_KEY },
        data: { channel: "admin-group", botMentioned: false, groupId: HQ, messageId: id, text: `${SECRET} #${i}`, senderPhone: digits(alice.phone), timestamp: String(Math.floor(Date.now() / 1000)) },
      });
      const [res] = await Promise.all([post, change(request, editBy(g, "alice", bare, HQ))]);
      expect(res.status()).toBe(200);
      expect(await db.count(`SELECT count(*)::int AS c FROM "AdminGroupMessage" WHERE "waMessageId" = $1`, [id])).toBe(0);
    }
  });

  test("a FORGED delete (neither the author nor an admin) changes nothing: the quote of the message still reaches the model", async ({ request, db }) => {
    const g = await createGroup(request, db);
    const bare = await storeTwoLines(g);
    expect(await change(request, revokeBy(g, "pete", bare))).toMatchObject({ ok: true, analyzed: 0 });
    const Q = "@Match Time is the code right?";
    await g.postBatch([{ player: "pete", body: Q, tag: true, ...Q_OPEN, quote: { id: bare, text: SECRET, authorJid: `${digits(g.player("dan").phone)}@c.us` } }]);
    expect(JSON.stringify(calls().filter((c) => c.user.includes(Q)))).toContain("4321");
    expect(await db.count(`SELECT count(*)::int AS c FROM "AnalyzedMessage" WHERE "groupId" = $1 AND body = $2`, [g.groupId, SECRET])).toBe(1);
  });

  test("Ali IN, Sam IN, Sam deletes while the batch is analysed: the batch's squad post still comes back", async ({ request, db }) => {
    const g = await createGroup(request, db);
    const bare = bareId();
    const id = storedId(g.groupId, bare, g.player("dan").phone);
    // FORCED ORDER: the batch passes the door (no tombstone yet) and is held
    // there by the test seam; the delete lands; the batch is then analysed.
    const batch = g.postBatch(
      [
        { player: "pete", body: "in", route: "self_att", facts: selfIn() },
        { player: "dan", body: "in for me", route: "self_att", facts: selfIn(), waMessageId: id },
        { player: "felix", body: "@Match Time who's in?", tag: true, route: "question", facts: { ...EMPTY, topic: "squad", kind: "list" } },
      ],
      { headers: { "x-mt-test-pause-after-door-ms": "2500" } },
    );
    await new Promise((r) => setTimeout(r, 800));
    await change(request, revokeBy(g, "dan", bare));
    expect(await db.count(`SELECT count(*)::int AS c FROM "AnalyzedMessage" WHERE "waMessageId" = $1`, [id]), "the delete landed before the batch wrote").toBe(0);
    const res = await batch;
    const spoke = res.results.filter((r) => (r.reply ?? "").length > 0);
    expect(spoke.length + res.groupPosts.length, "the squad post is still said").toBeGreaterThan(0);
    expect(JSON.stringify([spoke.map((r) => r.reply), res.groupPosts])).toContain(g.player("pete").name.split(" ")[0]);
    expect((await g.attendanceOf("pete"))?.status).toBe("CONFIRMED");
    // And the deleted message's words did not stay: cleared after the batch wrote.
    expect(await db.count(`SELECT count(*)::int AS c FROM "AnalyzedMessage" WHERE "waMessageId" = $1 AND body IS NOT NULL`, [id])).toBe(0);
  });

  test("the hourly sweep: a delete whose request died before its own clear is enforced, once", async ({ request, db }) => {
    const g = await createGroup(request, db, { features: { squadFromList: true } });
    const bare = await storeTwoLines(g);
    const id = storedId(g.groupId, bare, g.player("dan").phone);
    // The tombstone was written, the request that should have cleared the copy died.
    await db.run(
      `INSERT INTO "DeletedMessage" (id, "chatId", "waMessageId", "byAdmin", reason, "senderJids", "senderPhones", "deletedAt") VALUES ($1, $2, $3, false, 'deleted', $4, $5, now())`,
      [`e2e-tomb-${bare}`, g.groupId, bare, [`${digits(g.player("dan").phone)}@c.us`], [digits(g.player("dan").phone)]],
    );
    expect(await db.count(`SELECT count(*)::int AS c FROM "AnalyzedMessage" WHERE "waMessageId" = $1 AND body IS NOT NULL`, [id])).toBe(1);
    // A real archive row, so the sweep's clear of it is checked, not assumed.
    expect(await db.one(`SELECT body FROM "GroupMessage" WHERE "waMessageId" = $1`, [id])).toEqual({ body: SECRET });
    const sweep = async () => {
      const res = await request.get("/api/cron/bot-health", { headers: { authorization: `Bearer ${E2E.CRON_SECRET}` } });
      expect(res.status(), await res.text()).toBe(200);
      return (await res.json()).deletes as { checked: number; cleared: number };
    };
    expect((await sweep()).cleared).toBeGreaterThanOrEqual(1);
    expect(await db.count(`SELECT count(*)::int AS c FROM "AnalyzedMessage" WHERE "waMessageId" = $1 AND body IS NOT NULL`, [id])).toBe(0);
    expect(await db.one(`SELECT body FROM "GroupMessage" WHERE "waMessageId" = $1`, [id])).toEqual({ body: "" });
    expect(await db.one(`SELECT "enforcedAt" IS NOT NULL AS done FROM "DeletedMessage" WHERE "chatId" = $1 AND "waMessageId" = $2`, [g.groupId, bare])).toEqual({ done: true });
    expect((await sweep()).cleared).toBe(0);
  });

  // ── Round 4 ────────────────────────────────────────────────────────

  test("an EDITED tombstone does not drop a batch carrying the message: it is analysed, and any stored copy is purged after", async ({ request, db }) => {
    const g = await createGroup(request, db);
    const bare = bareId();
    const id = storedId(g.groupId, bare, g.player("dan").phone);
    // The edit landed first (the Pi had already sent the original once), then a batch carries the message.
    await change(request, editBy(g, "dan", bare));
    const res = await g.postBatch([{ player: "dan", body: "in", route: "self_att", facts: selfIn(), waMessageId: id }]);
    expect(res.results.find((r) => r.waMessageId === id)?.handledBy).not.toBe("missing");
    expect((await g.attendanceOf("dan"))?.status).toBe("CONFIRMED");
    expect(await db.count(`SELECT count(*)::int AS c FROM "AnalyzedMessage" WHERE "waMessageId" = $1 AND body IS NOT NULL`, [id])).toBe(0);
  });

  test("a DELETED message is dropped at the door, and a batch left empty still answers with the next kickoff", async ({ request, db }) => {
    const g = await createGroup(request, db);
    const bare = bareId();
    await change(request, revokeBy(g, "dan", bare));
    const res = await request.post("/api/whatsapp/analyze", {
      headers: { "x-api-key": E2E.WHATSAPP_API_KEY },
      data: { groupId: g.groupId, messages: [{ waMessageId: storedId(g.groupId, bare, g.player("dan").phone), body: SECRET, authorPhone: digits(g.player("dan").phone), authorName: "Dan", timestamp: new Date().toISOString() }] },
    });
    expect(res.status()).toBe(200);
    const json = await res.json();
    expect(json.results).toEqual([]);
    expect(typeof json.nextKickoffMs).toBe("number");
  });

  test("two changes of one message posted at once (the author's and an admin's) are merged in one statement: byAdmin and both senders kept", async ({ request, db }) => {
    const g = await createGroup(request, db);
    for (let i = 0; i < 5; i++) {
      const bare = bareId();
      await Promise.all([change(request, revokeBy(g, "pete", bare, g.groupId, true)), change(request, revokeBy(g, "dan", bare)), change(request, editBy(g, "dan", bare))]);
      const t = await db.one<{ byAdmin: boolean; reason: string; n: number }>(
        `SELECT "byAdmin", reason, cardinality("senderPhones")::int AS n FROM "DeletedMessage" WHERE "chatId" = $1 AND "waMessageId" = $2`,
        [g.groupId, bare],
      );
      expect(t).toEqual({ byAdmin: true, reason: "deleted", n: 2 });
    }
  });

  test("a group linked to no club: nothing is recorded", async ({ request, db }) => {
    const r = await change(request, { kind: "revoke", chatId: "120363999999999990@g.us", messageId: bareId(), byAdmin: true, senderJids: [], senderPhone: null });
    expect(r).toMatchObject({ ok: true, analyzed: 0 });
    expect(await db.count(`SELECT count(*)::int AS c FROM "DeletedMessage" WHERE "chatId" = $1`, ["120363999999999990@g.us"])).toBe(0);
  });

  // ── Round 5: one rule for an author's edit ──────────────────────────

  test("a reply quoting an EDITED message: no model call sees the original words", async ({ request, db }) => {
    const g = await createGroup(request, db);
    const bare = await storeTwoLines(g);
    await change(request, editBy(g, "dan", bare));
    const Q = "@Match Time did he change it?";
    await g.postBatch([{ player: "pete", body: Q, tag: true, ...Q_OPEN, quote: { id: bare, text: SECRET, authorJid: `${digits(g.player("dan").phone)}@c.us` } }]);
    expect(calls().some((c) => c.user.includes(Q))).toBe(true);
    expect(JSON.stringify(calls())).not.toContain("4321");
  });

  test("a message already analysed, re-queued by a catch-up after its edit: never analysed again, and its stored text stays purged", async ({ request, db }) => {
    const g = await createGroup(request, db);
    const bare = bareId();
    const id = storedId(g.groupId, bare, g.player("dan").phone);
    await g.postBatch([{ player: "dan", body: "inn", route: "self_att", facts: selfIn(), waMessageId: id }]);
    expect((await g.attendanceOf("dan"))?.status).toBe("CONFIRMED");
    await change(request, editBy(g, "dan", bare));
    const res = await g.postBatch([{ player: "dan", body: "in", route: "self_att", facts: selfIn(), waMessageId: id }]);
    expect(res.results.find((r) => r.waMessageId === id)?.handledBy).toBe("deduped");
    expect(await db.count(`SELECT count(*)::int AS c FROM "AnalyzedMessage" WHERE "waMessageId" = $1`, [id])).toBe(1);
    expect(await db.count(`SELECT count(*)::int AS c FROM "AnalyzedMessage" WHERE "waMessageId" = $1 AND body IS NOT NULL`, [id])).toBe(0);
    expect((await g.attendanceOf("dan"))?.status).toBe("CONFIRMED");
  });

  // ── Round 6 ────────────────────────────────────────────────────────

  for (const order of ["forged delete first", "author's edit first"]) {
    test(`a forged delete and the author's real edit (${order}) never make an authorised delete: the author's IN counts, with its tick`, async ({ request, db }) => {
      const g = await createGroup(request, db);
      const bare = bareId();
      const id = storedId(g.groupId, bare, g.player("dan").phone);
      const forged = change(request, revokeBy(g, "pete", bare));
      const edited = () => change(request, editBy(g, "dan", bare));
      if (order.startsWith("forged")) {
        await forged;
        await edited();
      } else {
        await edited();
        await forged;
      }
      const res = await g.postBatch([{ player: "dan", body: "in", route: "self_att", facts: selfIn(), waMessageId: id }]);
      const r = res.results.find((x) => x.waMessageId === id);
      expect(r?.handledBy).not.toBe("missing");
      expect(r?.react).toBeTruthy();
      expect((await g.attendanceOf("dan"))?.status).toBe("CONFIRMED");
    });
  }

  // ── The edit rule after six rounds: acted on once, as read; words forgotten ──

  test("a typo edit while its batch is analysed: 'inn' is acted on ONCE as MatchTime read it, then its stored text is purged; a catch-up copy is not analysed again", async ({ request, db }) => {
    const g = await createGroup(request, db);
    const bare = bareId();
    const id = storedId(g.groupId, bare, g.player("dan").phone);
    // FORCED ORDER: past the door, held; the author's edit lands; then analysed.
    const batch = g.postBatch([{ player: "dan", body: "inn", route: "self_att", facts: selfIn(), waMessageId: id }], { headers: { "x-mt-test-pause-after-door-ms": "2000" } });
    await new Promise((r) => setTimeout(r, 600));
    await change(request, editBy(g, "dan", bare));
    const res = await batch;
    const r = res.results.find((x) => x.waMessageId === id);
    expect(r?.handledBy).not.toBe("missing");
    expect(r?.react).toBeTruthy();
    expect((await g.attendanceOf("dan"))?.status).toBe("CONFIRMED");
    expect(await db.count(`SELECT count(*)::int AS c FROM "AnalyzedMessage" WHERE "waMessageId" = $1 AND body IS NOT NULL`, [id])).toBe(0);
    const again = await g.postBatch([{ player: "dan", body: "inn", route: "self_att", facts: selfIn(), waMessageId: id }]);
    expect(again.results.find((x) => x.waMessageId === id)?.handledBy).toBe("deduped");
    expect(await db.count(`SELECT count(*)::int AS c FROM "AnalyzedMessage" WHERE "waMessageId" = $1`, [id])).toBe(1);
  });

  test("the same change posted again (outbox retries) is kept once; at most 20 changes are kept per message, a delete never pushed out by edits (real Postgres)", async ({ request, db }) => {
    const g = await createGroup(request, db);
    const bare = bareId();
    for (let i = 0; i < 3; i++) await change(request, editBy(g, "dan", bare));
    for (let i = 0; i < 2; i++) await change(request, revokeBy(g, "dan", bare));
    const reasons = async () =>
      (await db.one<{ changes: Array<{ reason: string }> }>(`SELECT changes FROM "DeletedMessage" WHERE "chatId" = $1 AND "waMessageId" = $2`, [g.groupId, bare]))!.changes.map((c) => c.reason);
    expect(await reasons()).toEqual(["edited", "deleted"]);
    for (let i = 0; i < 25; i++) {
      const phone = `4477009020${String(i).padStart(2, "0")}`;
      await change(request, { kind: "edit", chatId: g.groupId, messageId: bare, senderJids: [`${phone}@c.us`], senderPhone: phone });
    }
    await change(request, revokeBy(g, "pete", bare, g.groupId, true));
    const kept = await reasons();
    expect(kept).toHaveLength(20);
    expect(kept.filter((x) => x === "deleted")).toHaveLength(2);
    const t = await db.one<{ first: Date; last: Date }>(`SELECT "deletedAt" AS first, "lastChangeAt" AS last FROM "DeletedMessage" WHERE "chatId" = $1 AND "waMessageId" = $2`, [g.groupId, bare]);
    expect(new Date(t!.last).getTime()).toBeGreaterThan(new Date(t!.first).getTime());
  });

  test("the server's safety net: a Pi recent-chat line carrying an EDITED message's original words never reaches the model", async ({ request, db }) => {
    const g = await createGroup(request, db, { attendance: [{ key: "pete", status: "CONFIRMED" as const }] });
    const bare = bareId();
    const dan = g.player("dan");
    await change(request, editBy(g, "dan", bare));
    await g.postBatch([{ player: "pete", body: "@Match Time out", tag: true, route: "self_att", facts: selfOut() }], {
      history: [
        { authorName: dan.name, body: SECRET, timestamp: new Date(Date.now() - 60_000).toISOString(), waMessageId: storedId(g.groupId, bare, dan.phone) },
        { authorName: dan.name, body: OTHER, timestamp: new Date(Date.now() - 30_000).toISOString() },
      ],
    });
    expect(JSON.stringify(calls())).not.toContain("4321");
    expect(JSON.stringify(calls())).toContain(OTHER);
  });
});

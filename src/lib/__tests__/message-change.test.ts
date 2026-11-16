/**
 * EDIT OR DELETE A MESSAGE, AND MATCHTIME FORGETS THE ORIGINAL WORDS
 * (2026-11-15, `message-change.ts`, round 3).
 *
 * An edit by its author is a purge through the very path a delete takes
 * (the tombstone, then every copy cleared), and the new words are never
 * stored. The pure half (what the Pi's post carries, which stored ids are
 * the message, who may delete or edit it) and the store half against an
 * in-memory fake whose `$transaction` rolls back. Made-up people,
 * simulated numbers.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { failures, makeDb, row, type Row } from "./fake-message-db";

const NAMES = ["analyzedMessage", "groupMessage", "adminGroupMessage", "messageMentions", "deletedMessage", "organisation"];
const T: Record<string, Row[]> = {};
const fake = makeDb(T, NAMES, { deletedMessage: [["chatId", "waMessageId"]] });
vi.mock("@/lib/db", () => ({
  get db() {
    return fake.db;
  },
}));

import {
  applyMessageChange,
  bareIdOf,
  deleteApplies,
  deletedAmong,
  DELETED_MESSAGE_RETENTION_DAYS,
  enforceDeletes,
  isAuthorOf,
  isStoredIdOf,
  parseMessageChangeInput,
  storedIdForms,
  sweepRecentTombstones,
  withoutDeletedQuotes,
} from "../message-change";

const NOW = new Date("2026-11-15T18:00:00.000Z");
const ago = (m: number) => new Date(NOW.getTime() - m * 60 * 1000);
const G = "120363000000000111@g.us";
const HQ = "120363000000000999@g.us";
const OTHER_G = "120363000000000222@g.us";
const ID = "3EB0AAAA1111BBBB";
const SAM_PN = "447700900123";
const SAM_LID = "158055467598020";
const ALI_PN = "447700900456";
const SAM_ID = `false_${G}_${ID}_${SAM_PN}@c.us`;
const SAM = { senderJids: [`${SAM_PN}@c.us`], senderPhone: SAM_PN };
const ALI = { senderJids: [`${ALI_PN}@c.us`], senderPhone: ALI_PN };
const byAuthor = { kind: "revoke" as const, chatId: G, messageId: ID, byAdmin: false, ...SAM };
const editBy = (who: typeof SAM) => ({ kind: "edit" as const, chatId: G, messageId: ID, byAdmin: false, ...who });
const words = () => JSON.stringify([T.analyzedMessage, T.groupMessage, T.adminGroupMessage, T.messageMentions]);

beforeEach(() => {
  fake.missing.clear();
  for (const k of NAMES) T[k] = [];
  T.organisation.push({ id: "org-a", whatsappGroupId: G, adminGroupId: HQ }, { id: "org-b", whatsappGroupId: OTHER_G, adminGroupId: null });
  delete failures.beforeWrite;
});

// ── The Pi's post ──────────────────────────────────────────────────────

describe("parseMessageChangeInput", () => {
  it("a revoke: the group, the message id, who sent it and whether they are a group admin", () => {
    expect(parseMessageChangeInput({ kind: "revoke", chatId: G, messageId: ID, byAdmin: true, senderJids: [`${SAM_LID}@lid`, 5], senderPhone: "+44 7700 900123" })).toEqual({
      kind: "revoke",
      chatId: G,
      messageId: ID,
      byAdmin: true,
      senderJids: [`${SAM_LID}@lid`],
      senderPhone: SAM_PN,
    });
  });

  it("an edit carries no words (any sent are dropped) and is never an admin's", () => {
    expect(parseMessageChangeInput({ kind: "edit", chatId: G, messageId: ID, text: "new words", mentions: ["x@c.us"], byAdmin: true, ...SAM })).toEqual({
      kind: "edit",
      chatId: G,
      messageId: ID,
      byAdmin: false,
      ...SAM,
    });
  });

  it("refuses what is not a group message change", () => {
    expect(parseMessageChangeInput(null)).toBeNull();
    expect(parseMessageChangeInput({ kind: "revoke", chatId: "447700900123@c.us", messageId: ID })).toBeNull();
    expect(parseMessageChangeInput({ kind: "revoke", chatId: G })).toBeNull();
    expect(parseMessageChangeInput({ kind: "revoke", chatId: G, messageId: "a b" })).toBeNull();
    expect(parseMessageChangeInput({ kind: "revoke", chatId: G, messageId: "x@y" })).toBeNull();
    expect(parseMessageChangeInput({ kind: "react", chatId: G, messageId: ID })).toBeNull();
  });
});

// ── Ids and authors ────────────────────────────────────────────────────

describe("ids: matched by WhatsApp id and group, never by text", () => {
  it("the serialised forms, with and without a participant", () => {
    expect(isStoredIdOf(SAM_ID, G, ID)).toBe(true);
    expect(isStoredIdOf(`false_${G}_${ID}_${SAM_LID}@lid`, G, ID)).toBe(true);
    expect(isStoredIdOf(`true_${G}_${ID}`, G, ID)).toBe(true);
    expect(isStoredIdOf(`false_${OTHER_G}_${ID}_${SAM_PN}@c.us`, G, ID)).toBe(false);
    expect(isStoredIdOf(`false_${G}_${ID}X_${SAM_PN}@c.us`, G, ID)).toBe(false);
    expect(isStoredIdOf(ID, G, ID)).toBe(false);
    expect(isStoredIdOf(ID, G, ID, { bare: true })).toBe(true);
    expect(isStoredIdOf(`group:${SAM_ID}`, G, ID, { prefix: "group:" })).toBe(true);
    expect(storedIdForms(G, ID).prefixes).toEqual([`false_${G}_${ID}_`, `true_${G}_${ID}_`]);
  });

  it("bareIdOf reads the WhatsApp id out of every stored spelling", () => {
    expect(bareIdOf(SAM_ID)).toBe(ID);
    expect(bareIdOf(`group:${SAM_ID}`)).toBe(ID);
    expect(bareIdOf(ID)).toBe(ID);
    expect(bareIdOf("synthetic:abc")).toBeNull();
  });

  it("isAuthorOf and deleteApplies: an admin's delete always, anyone else's only their own", () => {
    const at = { storedId: SAM_ID, chatId: G, messageId: ID };
    expect(isAuthorOf({ storedId: `false_${G}_${ID}_${SAM_LID}@lid`, chatId: G, messageId: ID, storedPhone: `+${SAM_PN}` }, { jids: [], phones: [SAM_PN] })).toBe(true);
    expect(deleteApplies({ byAdmin: true, senderJids: [`${ALI_PN}@c.us`], senderPhones: [] }, at)).toBe(true);
    expect(deleteApplies({ byAdmin: false, senderJids: [`${SAM_PN}@c.us`], senderPhones: [] }, at)).toBe(true);
    expect(deleteApplies({ byAdmin: false, senderJids: [`${ALI_PN}@c.us`], senderPhones: [ALI_PN] }, at)).toBe(false);
  });
});

// ── The stores ─────────────────────────────────────────────────────────

function seed(at = ago(5)) {
  T.analyzedMessage.push(
    row({ waMessageId: SAM_ID, orgId: "org-a", groupId: G, authorPhone: SAM_PN, body: "my door code is 4321", reasoning: "Sam shared a door code 4321", pipelineTrace: { v: 1, facts: "4321" }, handledBy: "none", createdAt: at }),
    row({ waMessageId: `false_${OTHER_G}_${ID}_${SAM_PN}@c.us`, orgId: "org-b", groupId: OTHER_G, authorPhone: SAM_PN, body: "other group's words", handledBy: "none", createdAt: at }),
    row({ waMessageId: `false_${G}_OTHERID999_${SAM_PN}@c.us`, orgId: "org-a", groupId: G, authorPhone: SAM_PN, body: "unrelated line", handledBy: "none", createdAt: at }),
  );
  T.groupMessage.push(
    row({ waMessageId: SAM_ID, orgId: "org-a", waChatId: G, senderPhone: SAM_PN, body: "my door code is 4321", createdAt: at, timestamp: at }),
    row({ waMessageId: `false_${G}_OTHERID999_${SAM_PN}@c.us`, orgId: "org-a", waChatId: G, senderPhone: SAM_PN, body: "unrelated line", createdAt: at, timestamp: at }),
  );
  T.adminGroupMessage.push(
    row({ waMessageId: `group:${SAM_ID}`, orgId: "org-a", fromMatchTime: false, text: "my door code is 4321", pipelineTrace: { v: 1, facts: "4321" }, hqOutcome: "hq-answered", createdAt: at }),
    row({ waMessageId: "mt:teams:m1:1:abc", orgId: "org-a", fromMatchTime: true, text: "Teams ready, YES?", createdAt: at }),
  );
  T.messageMentions.push(row({ waMessageId: SAM_ID, orgId: "org-a", chatId: G, mentions: [{ phone: "447700900555" }], sentAt: at, createdAt: at }));
}
const analyzed = () => T.analyzedMessage.find((x) => x.waMessageId === SAM_ID)!;

describe("a delete for everyone", () => {
  it("by its author: the words leave every store, only this message's, and the delete is recorded", async () => {
    seed();
    expect(await applyMessageChange(byAuthor, NOW)).toEqual({ analyzed: 1, archived: 1, hq: 1, mentions: 1, refused: 0 });
    expect(analyzed()).toMatchObject({ body: null, reasoning: null, pipelineTrace: null });
    expect(T.groupMessage.find((x) => x.waMessageId === SAM_ID)!.body).toBe("");
    expect(T.adminGroupMessage.map((x) => x.waMessageId)).toEqual(["mt:teams:m1:1:abc"]);
    expect(T.messageMentions).toEqual([]);
    expect(T.deletedMessage).toEqual([expect.objectContaining({ chatId: G, waMessageId: ID, byAdmin: false, reason: "deleted", senderJids: [`${SAM_PN}@c.us`], senderPhones: [SAM_PN] })]);
    expect(words()).not.toContain("4321");
    expect(T.analyzedMessage.map((x) => x.body)).toEqual([null, "other group's words", "unrelated line"]);
  });

  it("by a group admin (somebody else's message): the same", async () => {
    seed();
    expect(await applyMessageChange({ ...byAuthor, ...ALI, byAdmin: true }, NOW)).toMatchObject({ analyzed: 1, archived: 1, hq: 1, mentions: 1, refused: 0 });
  });

  it("by anyone else: nothing changes (it is recorded, and applies to nothing)", async () => {
    seed();
    expect(await applyMessageChange({ ...byAuthor, ...ALI }, NOW)).toEqual({ analyzed: 0, archived: 0, hq: 0, mentions: 0, refused: 3 });
    expect(analyzed().body).toBe("my door code is 4321");
    expect(T.messageMentions).toHaveLength(1);
  });

  it("a retry is idempotent, and a later admin delete merges into the record", async () => {
    seed();
    await applyMessageChange({ ...byAuthor, ...ALI }, NOW);
    await applyMessageChange({ ...byAuthor, ...ALI, byAdmin: true }, NOW);
    expect(T.deletedMessage).toHaveLength(1);
    expect(T.deletedMessage[0]).toMatchObject({ byAdmin: true });
    expect(analyzed().body).toBeNull();
    // The author's own retry: nothing left to clear.
    expect(await applyMessageChange(byAuthor, NOW)).toEqual({ analyzed: 0, archived: 0, hq: 0, mentions: 0, refused: 0 });
  });

  it("ATOMIC: a failure half-way changes nothing, the tombstone is kept, and the retry does it all", async () => {
    seed();
    let writes = 0;
    failures.beforeWrite = () => {
      if (++writes === 2) throw new Error("connection reset");
    };
    await expect(applyMessageChange(byAuthor, NOW)).rejects.toThrow("connection reset");
    expect(analyzed().body).toBe("my door code is 4321");
    expect(T.groupMessage[0].body).toBe("my door code is 4321");
    expect(T.deletedMessage).toHaveLength(1);
    delete failures.beforeWrite;
    expect(await applyMessageChange(byAuthor, NOW)).toMatchObject({ analyzed: 1, archived: 1, hq: 1, mentions: 1 });
  });
});

describe("an edit is a purge, never a replacement", () => {
  it("by its author: the original words leave every store, mentions and the model's reading included, and no new words are stored", async () => {
    seed();
    expect(await applyMessageChange(editBy(SAM), NOW)).toEqual({ analyzed: 1, archived: 1, hq: 1, mentions: 1, refused: 0 });
    expect(analyzed()).toMatchObject({ body: null, reasoning: null, pipelineTrace: null });
    expect(T.messageMentions).toEqual([]);
    expect(T.deletedMessage[0]).toMatchObject({ reason: "edited", byAdmin: false });
    expect(words()).not.toContain("4321");
  });

  it("by anyone else, a group admin included: ignored entirely", async () => {
    seed();
    expect(await applyMessageChange(editBy(ALI), NOW)).toMatchObject({ analyzed: 0, archived: 0, hq: 0, mentions: 0 });
    expect(await applyMessageChange({ ...editBy(ALI), byAdmin: true }, NOW)).toMatchObject({ analyzed: 0 });
    expect(analyzed()).toMatchObject({ body: "my door code is 4321", reasoning: "Sam shared a door code 4321" });
    expect(T.messageMentions).toHaveLength(1);
  });

  it("edits in any order, repeated, then a delete, or a delete then an edit: the same purge, and the record says 'deleted'", async () => {
    seed();
    await applyMessageChange(editBy(SAM), NOW);
    await applyMessageChange(editBy(SAM), NOW);
    seed(); // a late copy, then the delete
    await applyMessageChange(byAuthor, NOW);
    await applyMessageChange(editBy(SAM), NOW);
    expect(T.deletedMessage).toHaveLength(1);
    expect(T.deletedMessage[0]).toMatchObject({ reason: "deleted" });
    expect(words()).not.toContain("4321");
  });
});

describe("the delete or edit wins whatever the order (the tombstone)", () => {
  it("a copy written AFTER it (HQ's slow handler, a replay) is cleared by enforceDeletes", async () => {
    await applyMessageChange(editBy(SAM), NOW);
    seed();
    expect(await enforceDeletes(G, [SAM_ID, `group:${SAM_ID}`])).toBe(1);
    expect(words()).not.toContain("4321");
  });

  it("enforceDeletes leaves a message whose delete does not apply, and messages never deleted", async () => {
    await applyMessageChange({ ...byAuthor, ...ALI }, NOW);
    seed();
    expect(await enforceDeletes(G, [SAM_ID, `false_${G}_OTHERID999_${SAM_PN}@c.us`])).toBe(0);
    expect(analyzed().body).toBe("my door code is 4321");
  });

  it("deletedAmong names the batch's deleted or edited messages", async () => {
    await applyMessageChange(editBy(SAM), NOW);
    expect([...(await deletedAmong(G, [{ id: SAM_ID }, { id: `false_${G}_OTHERID999_${SAM_PN}@c.us` }]))]).toEqual([SAM_ID]);
    expect((await deletedAmong(OTHER_G, [{ id: `false_${OTHER_G}_${ID}_${SAM_PN}@c.us` }])).size).toBe(0);
  });

  it("with no tombstone table yet: the doors change nothing and never throw; the change itself fails, for the Pi to retry", async () => {
    seed();
    fake.missing.add("deletedMessage");
    expect(await enforceDeletes(G, [SAM_ID])).toBe(0);
    expect((await deletedAmong(G, [{ id: SAM_ID }])).size).toBe(0);
    expect(await withoutDeletedQuotes(G, [{ quotedMessageId: ID, quotedBody: "w" }], "quotedBody")).toEqual([{ quotedMessageId: ID, quotedBody: "w" }]);
    await expect(applyMessageChange(byAuthor, NOW)).rejects.toThrow(/does not exist/);
    expect(await sweepRecentTombstones(NOW)).toMatchObject({ checked: 0 });
    expect(analyzed().body).toBe("my door code is 4321");
  });
});

describe("a quote of a deleted or edited message: stripped only when its author or an admin made the change", () => {
  const reply = (author: Record<string, unknown>) => ({ waMessageId: "r1", quotedMessageId: ID, quotedBody: "my door code is 4321", ...author });

  it("the author, matched by the quote's participant id (a LID) with no phone known: stripped", async () => {
    await applyMessageChange({ ...byAuthor, senderJids: [`${SAM_LID}@lid`], senderPhone: null }, NOW);
    const [out] = await withoutDeletedQuotes(G, [reply({ quotedAuthorJid: `${SAM_LID}@lid` })], "quotedBody");
    expect(out).toEqual({ waMessageId: "r1", quotedMessageId: ID, quotedAuthorJid: `${SAM_LID}@lid` });
  });

  it("the author by phone, and a group admin: stripped", async () => {
    await applyMessageChange(byAuthor, NOW);
    expect((await withoutDeletedQuotes(G, [reply({ quotedAuthorPhone: SAM_PN })], "quotedBody"))[0].quotedBody).toBeUndefined();
  });

  it("a FORGED delete (neither the quoted message's author nor an admin) changes nothing, the quote included", async () => {
    await applyMessageChange({ ...byAuthor, ...ALI }, NOW);
    expect((await withoutDeletedQuotes(G, [reply({ quotedAuthorJid: `${SAM_PN}@c.us`, quotedAuthorPhone: SAM_PN })], "quotedBody"))[0].quotedBody).toBe("my door code is 4321");
    // An unknown quoted author and a delete that is no admin's: nothing to tie it to, the quote stays.
    expect((await withoutDeletedQuotes(G, [reply({})], "quotedBody"))[0].quotedBody).toBe("my door code is 4321");
  });

  it("an admin's delete strips the quote whoever wrote it", async () => {
    await applyMessageChange({ ...byAuthor, ...ALI, byAdmin: true }, NOW);
    expect((await withoutDeletedQuotes(G, [reply({})], "quotedBody"))[0].quotedBody).toBeUndefined();
  });
});

describe("the safety sweep (hourly, on /api/cron/bot-health)", () => {
  it("enforces every recent tombstone against the stores: a copy an interrupted request wrote is cleared", async () => {
    await applyMessageChange(byAuthor, ago(30));
    seed(ago(20)); // written after the delete, by a request that died before its own clear
    expect(await sweepRecentTombstones(NOW)).toEqual({ checked: 1, cleared: 1, pruned: 0 });
    expect(words()).not.toContain("4321");
    // Idempotent: a second run changes nothing more.
    expect(await sweepRecentTombstones(NOW)).toEqual({ checked: 1, cleared: 0, pruned: 0 });
  });

  it("prunes tombstones older than the retention, and never applies a delete that does not apply", async () => {
    await applyMessageChange({ ...byAuthor, ...ALI }, ago(10));
    T.deletedMessage.push(row({ chatId: G, waMessageId: "OLDMESSAGE01", byAdmin: true, reason: "deleted", senderJids: [], senderPhones: [], deletedAt: ago((DELETED_MESSAGE_RETENTION_DAYS + 1) * 24 * 60) }));
    seed();
    expect(await sweepRecentTombstones(NOW)).toEqual({ checked: 1, cleared: 0, pruned: 1 });
    expect(analyzed().body).toBe("my door code is 4321");
    expect(T.deletedMessage).toHaveLength(1);
  });
});

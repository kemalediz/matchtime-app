/**
 * A WhatsApp message deleted for everyone leaves MatchTime's stored chat,
 * and an edit replaces it (2026-11-15, `message-change.ts`, round 2).
 *
 * The pure half (what the Pi's post must carry, which stored ids are the
 * message, who may delete or edit it) and the store half against an
 * in-memory fake whose `$transaction` rolls back. Every reviewer scenario
 * has a case here. Made-up people, simulated numbers.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { failures, makeDb, row, type Row } from "./fake-message-db";

const NAMES = ["analyzedMessage", "groupMessage", "adminGroupMessage", "messageMentions", "deletedMessage", "membership", "userAlias", "onboardingSession", "clubConnect"];
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
  enforceDeletes,
  isAuthorOf,
  isStoredIdOf,
  parseMessageChangeInput,
  scrubbedEditText,
  storedIdForms,
  withoutDeletedQuotes,
} from "../message-change";

const G = "120363000000000111@g.us";
const OTHER_G = "120363000000000222@g.us";
const ID = "3EB0AAAA1111BBBB";
const SAM_PN = "447700900123";
const SAM_LID = "158055467598020";
const ALI_PN = "447700900456";
const SAM_ID = `false_${G}_${ID}_${SAM_PN}@c.us`;
const SAM = { senderJids: [`${SAM_PN}@c.us`], senderPhone: SAM_PN };
const ALI = { senderJids: [`${ALI_PN}@c.us`], senderPhone: ALI_PN };
const byAuthor = { kind: "revoke" as const, chatId: G, messageId: ID, byAdmin: false, ...SAM };
const editBy = (who: typeof SAM, text: string, extra: Record<string, unknown> = {}) => ({ kind: "edit" as const, chatId: G, messageId: ID, text, ...who, ...extra });

beforeEach(() => {
  fake.missing.clear();
  for (const k of NAMES) T[k] = [];
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

  it("an edit, with its mentions; an edit that left no text is still an edit (a caption removed)", () => {
    expect(parseMessageChangeInput({ kind: "edit", chatId: G, messageId: ID, text: "  hi @447700900456  ", mentions: ["447700900456@c.us"], mentionNames: [{ jid: "447700900456@c.us", name: "Ali" }], ...SAM })).toEqual({
      kind: "edit",
      chatId: G,
      messageId: ID,
      text: "hi @447700900456",
      mentions: ["447700900456@c.us"],
      mentionNames: [{ jid: "447700900456@c.us", name: "Ali" }],
      ...SAM,
    });
    expect(parseMessageChangeInput({ kind: "edit", chatId: G, messageId: ID, text: "", ...SAM })).toMatchObject({ kind: "edit", text: "" });
  });

  it("refuses what is not a group message change", () => {
    expect(parseMessageChangeInput(null)).toBeNull();
    expect(parseMessageChangeInput({ kind: "revoke", chatId: "447700900123@c.us", messageId: ID })).toBeNull();
    expect(parseMessageChangeInput({ kind: "revoke", chatId: G })).toBeNull();
    expect(parseMessageChangeInput({ kind: "revoke", chatId: G, messageId: "a b" })).toBeNull();
    expect(parseMessageChangeInput({ kind: "revoke", chatId: G, messageId: "x@y" })).toBeNull();
    expect(parseMessageChangeInput({ kind: "react", chatId: G, messageId: ID })).toBeNull();
    expect(parseMessageChangeInput({ kind: "edit", chatId: G, messageId: ID })).toBeNull();
  });
});

// ── Which stored ids are this message, and who wrote it ────────────────

describe("ids: matched by WhatsApp id and group, never by text", () => {
  it("the serialised forms, with and without a participant", () => {
    expect(isStoredIdOf(SAM_ID, G, ID)).toBe(true);
    expect(isStoredIdOf(`false_${G}_${ID}_${SAM_LID}@lid`, G, ID)).toBe(true);
    expect(isStoredIdOf(`true_${G}_${ID}`, G, ID)).toBe(true);
    expect(isStoredIdOf(`false_${OTHER_G}_${ID}_${SAM_PN}@c.us`, G, ID)).toBe(false);
    expect(isStoredIdOf(`false_${G}_${ID}X_${SAM_PN}@c.us`, G, ID)).toBe(false);
    expect(isStoredIdOf(`false_${G}_${ID}_X_${SAM_PN}@c.us`, G, ID)).toBe(false);
    expect(isStoredIdOf(ID, G, ID)).toBe(false);
    expect(isStoredIdOf(ID, G, ID, { bare: true })).toBe(true);
    expect(isStoredIdOf(`group:${SAM_ID}`, G, ID, { prefix: "group:" })).toBe(true);
    expect(storedIdForms(G, ID).prefixes).toEqual([`false_${G}_${ID}_`, `true_${G}_${ID}_`]);
  });

  it("bareIdOf reads the WhatsApp id out of every stored spelling", () => {
    expect(bareIdOf(SAM_ID)).toBe(ID);
    expect(bareIdOf(`group:${SAM_ID}`)).toBe(ID);
    expect(bareIdOf(`true_${G}_${ID}`)).toBe(ID);
    expect(bareIdOf(ID)).toBe(ID);
    expect(bareIdOf("synthetic:abc")).toBeNull();
  });

  it("isAuthorOf: the participant, either spelling, or the stored phone", () => {
    expect(isAuthorOf({ storedId: SAM_ID, chatId: G, messageId: ID }, { jids: [`${SAM_PN}@c.us`], phones: [] })).toBe(true);
    expect(isAuthorOf({ storedId: `false_${G}_${ID}_${SAM_LID}@lid`, chatId: G, messageId: ID, storedPhone: `+${SAM_PN}` }, { jids: [], phones: [SAM_PN] })).toBe(true);
    expect(isAuthorOf({ storedId: SAM_ID, chatId: G, messageId: ID }, { jids: [`${ALI_PN}@c.us`], phones: [ALI_PN] })).toBe(false);
    expect(isAuthorOf({ storedId: `true_${G}_${ID}`, chatId: G, messageId: ID }, { jids: [], phones: [] })).toBe(false);
  });

  it("deleteApplies: a group admin's delete always, anyone else's only their own message", () => {
    const at = { storedId: SAM_ID, chatId: G, messageId: ID };
    expect(deleteApplies({ byAdmin: true, senderJids: [`${ALI_PN}@c.us`], senderPhones: [] }, at)).toBe(true);
    expect(deleteApplies({ byAdmin: false, senderJids: [`${SAM_PN}@c.us`], senderPhones: [] }, at)).toBe(true);
    expect(deleteApplies({ byAdmin: false, senderJids: [`${ALI_PN}@c.us`], senderPhones: [ALI_PN] }, at)).toBe(false);
  });

  it("an edit's words never keep a raw phone or LID, and are cut", () => {
    expect(scrubbedEditText("ask @447700900456 or @158055467598020", 2000)).toBe("ask @someone or @someone");
    expect(scrubbedEditText("x".repeat(3000), 2000)).toHaveLength(2000);
  });
});

// ── The stores ─────────────────────────────────────────────────────────

function seed() {
  T.analyzedMessage.push(
    row({ waMessageId: SAM_ID, orgId: "org-a", groupId: G, authorPhone: SAM_PN, body: "my door code is 4321", reasoning: "Sam shared a door code 4321", pipelineTrace: { v: 1, facts: "4321" }, intent: "none", handledBy: "none" }),
    row({ waMessageId: `false_${OTHER_G}_${ID}_${SAM_PN}@c.us`, orgId: "org-b", groupId: OTHER_G, authorPhone: SAM_PN, body: "other group's words", handledBy: "none" }),
    row({ waMessageId: `false_${G}_OTHERID999_${SAM_PN}@c.us`, orgId: "org-a", groupId: G, authorPhone: SAM_PN, body: "unrelated line", handledBy: "none" }),
  );
  T.groupMessage.push(
    row({ waMessageId: SAM_ID, orgId: "org-a", waChatId: G, senderPhone: SAM_PN, body: "my door code is 4321" }),
    row({ waMessageId: `false_${G}_OTHERID999_${SAM_PN}@c.us`, orgId: "org-a", waChatId: G, senderPhone: SAM_PN, body: "unrelated line" }),
  );
  T.adminGroupMessage.push(
    row({ waMessageId: SAM_ID, orgId: "org-a", fromMatchTime: false, text: "my door code is 4321", pipelineTrace: { v: 1, facts: "4321" }, hqOutcome: "hq-answered" }),
    row({ waMessageId: `group:${SAM_ID}`, orgId: "org-a", fromMatchTime: false, text: "my door code is 4321" }),
    row({ waMessageId: "mt:teams:m1:1:abc", orgId: "org-a", fromMatchTime: true, text: "Teams ready, YES?" }),
  );
  T.messageMentions.push(row({ waMessageId: SAM_ID, orgId: "org-a", chatId: G, mentions: [{ phone: "447700900555" }] }));
}
const analyzed = () => T.analyzedMessage.find((x) => x.waMessageId === SAM_ID)!;

describe("a delete for everyone", () => {
  it("by its author: the words leave every store, only this message's, and the delete is recorded", async () => {
    seed();
    expect(await applyMessageChange(byAuthor)).toEqual({ analyzed: 1, archived: 1, hq: 2, mentions: 1, refused: 0 });
    expect(analyzed()).toMatchObject({ body: null, reasoning: null, pipelineTrace: null });
    expect(T.groupMessage.find((x) => x.waMessageId === SAM_ID)!.body).toBe("");
    expect(T.adminGroupMessage.map((x) => x.waMessageId)).toEqual(["mt:teams:m1:1:abc"]);
    expect(T.messageMentions).toEqual([]);
    expect(T.deletedMessage).toEqual([expect.objectContaining({ chatId: G, waMessageId: ID, byAdmin: false, senderJids: [`${SAM_PN}@c.us`], senderPhones: [SAM_PN] })]);
    expect(JSON.stringify([T.analyzedMessage, T.groupMessage, T.adminGroupMessage])).not.toContain("4321");
    expect(T.analyzedMessage.map((x) => x.body)).toEqual([null, "other group's words", "unrelated line"]);
  });

  it("by a group admin (somebody else's message): the same", async () => {
    seed();
    expect(await applyMessageChange({ ...byAuthor, ...ALI, byAdmin: true })).toMatchObject({ analyzed: 1, archived: 1, hq: 2, mentions: 1, refused: 0 });
    expect(analyzed().body).toBeNull();
  });

  it("by anyone else: nothing changes (it is recorded, and applies to nothing)", async () => {
    seed();
    expect(await applyMessageChange({ ...byAuthor, ...ALI })).toEqual({ analyzed: 0, archived: 0, hq: 0, mentions: 0, refused: 4 });
    expect(analyzed().body).toBe("my door code is 4321");
    expect(T.messageMentions).toHaveLength(1);
    expect(T.adminGroupMessage).toHaveLength(3);
  });

  it("a retry is idempotent, and a later admin delete merges into the record", async () => {
    seed();
    await applyMessageChange({ ...byAuthor, ...ALI });
    await applyMessageChange({ ...byAuthor, ...ALI, byAdmin: true });
    expect(T.deletedMessage).toHaveLength(1);
    expect(T.deletedMessage[0]).toMatchObject({ byAdmin: true });
    expect(analyzed().body).toBeNull();
    expect(await applyMessageChange(byAuthor)).toEqual({ analyzed: 1, archived: 1, hq: 0, mentions: 0, refused: 0 });
  });

  it("ATOMIC: a failure half-way changes nothing, and the retry then does it all", async () => {
    seed();
    let writes = 0;
    failures.beforeWrite = () => {
      if (++writes === 2) throw new Error("connection reset");
    };
    await expect(applyMessageChange(byAuthor)).rejects.toThrow("connection reset");
    expect(analyzed().body).toBe("my door code is 4321");
    expect(T.groupMessage[0].body).toBe("my door code is 4321");
    // The tombstone was committed first, on its own: the delete is not lost.
    expect(T.deletedMessage).toHaveLength(1);
    delete failures.beforeWrite;
    expect(await applyMessageChange(byAuthor)).toMatchObject({ analyzed: 1, archived: 1, hq: 2, mentions: 1 });
  });

  it("finds a row stored under the bare id in this group", async () => {
    T.analyzedMessage.push(row({ waMessageId: ID, orgId: "org-a", groupId: G, authorPhone: SAM_PN, body: "secret", handledBy: "none" }));
    T.analyzedMessage.push(row({ waMessageId: ID + "Z", orgId: "org-a", groupId: G, authorPhone: SAM_PN, body: "keep", handledBy: "none" }));
    expect((await applyMessageChange(byAuthor)).analyzed).toBe(1);
    expect(T.analyzedMessage.map((x) => x.body)).toEqual([null, "keep"]);
  });
});

describe("the delete wins whatever the order (the tombstone)", () => {
  it("a copy written AFTER the delete (HQ's slow handler, a replay) is cleared by enforceDeletes", async () => {
    await applyMessageChange(byAuthor);
    seed(); // the late writes
    expect(await enforceDeletes(G, [SAM_ID, `group:${SAM_ID}`])).toBe(1);
    expect(JSON.stringify([T.analyzedMessage, T.groupMessage, T.adminGroupMessage, T.messageMentions])).not.toContain("4321");
    expect(T.messageMentions).toEqual([]);
  });

  it("enforceDeletes leaves a message whose delete does not apply, and messages never deleted", async () => {
    await applyMessageChange({ ...byAuthor, ...ALI });
    seed();
    expect(await enforceDeletes(G, [SAM_ID, `false_${G}_OTHERID999_${SAM_PN}@c.us`])).toBe(0);
    expect(analyzed().body).toBe("my door code is 4321");
  });

  it("an edit that arrives after the delete puts nothing back", async () => {
    seed();
    await applyMessageChange(byAuthor);
    // HQ's copies are gone with the delete; the two left are refused.
    expect(await applyMessageChange(editBy(SAM, "my door code is 4321, sorry"))).toMatchObject({ analyzed: 0, archived: 0, hq: 0, refused: 2 });
    expect(JSON.stringify([T.analyzedMessage, T.groupMessage, T.adminGroupMessage])).not.toContain("4321");
  });

  it("deletedAmong names the batch's deleted messages; withoutDeletedQuotes empties replies' quotes of them", async () => {
    await applyMessageChange(byAuthor);
    expect([...(await deletedAmong(G, [{ id: SAM_ID }, { id: `false_${G}_OTHERID999_${SAM_PN}@c.us` }]))]).toEqual([SAM_ID]);
    expect((await deletedAmong(OTHER_G, [{ id: `false_${OTHER_G}_${ID}_${SAM_PN}@c.us` }])).size).toBe(0);
    const out = await withoutDeletedQuotes(
      G,
      [
        { waMessageId: "r1", quotedMessageId: ID, quotedBody: "my door code is 4321" },
        { waMessageId: "r2", quotedMessageId: "OTHERID999", quotedBody: "unrelated line" },
        { waMessageId: "r3" },
      ],
      "quotedBody",
    );
    expect(out).toEqual([{ waMessageId: "r1", quotedMessageId: ID }, { waMessageId: "r2", quotedMessageId: "OTHERID999", quotedBody: "unrelated line" }, { waMessageId: "r3" }]);
  });

  it("a quote stays when the only delete of it was somebody else's", async () => {
    await applyMessageChange({ ...byAuthor, ...ALI });
    const out = await withoutDeletedQuotes(G, [{ quotedMessageId: ID, quotedAuthorPhone: SAM_PN, quotedBody: "words" }], "quotedBody");
    expect(out[0].quotedBody).toBe("words");
  });

  it("with no tombstone table yet (deployed before the migration): the doors change nothing and never throw; the delete itself fails, for the Pi to retry", async () => {
    seed();
    fake.missing.add("deletedMessage");
    try {
      expect(await enforceDeletes(G, [SAM_ID])).toBe(0);
      expect((await deletedAmong(G, [{ id: SAM_ID }])).size).toBe(0);
      expect(await withoutDeletedQuotes(G, [{ quotedMessageId: ID, quotedBody: "w" }], "quotedBody")).toEqual([{ quotedMessageId: ID, quotedBody: "w" }]);
      await expect(applyMessageChange(byAuthor)).rejects.toThrow(/does not exist/);
      expect(analyzed().body).toBe("my door code is 4321");
    } finally {
      fake.missing.clear();
    }
  });
});

describe("an edit", () => {
  it("by its author: the new words everywhere, and the model's reading of the old words cleared", async () => {
    seed();
    expect(await applyMessageChange(editBy(SAM, "running 10 mins late"))).toEqual({ analyzed: 1, archived: 1, hq: 2, mentions: 0, refused: 0 });
    expect(analyzed()).toMatchObject({ body: "running 10 mins late", reasoning: null, pipelineTrace: null });
    expect(T.groupMessage.find((x) => x.waMessageId === SAM_ID)!.body).toBe("running 10 mins late");
    expect(T.adminGroupMessage.find((x) => x.waMessageId === SAM_ID)).toMatchObject({ text: "running 10 mins late", pipelineTrace: null, hqOutcome: null });
    expect(T.messageMentions).toHaveLength(1);
    expect(JSON.stringify([T.analyzedMessage, T.groupMessage, T.adminGroupMessage])).not.toContain("4321");
  });

  it("cut as inbound text is: 2,000 in AnalyzedMessage, 4,000 in the archive, 500 in HQ", async () => {
    seed();
    await applyMessageChange(editBy(SAM, "y".repeat(4000)));
    expect((analyzed().body as string).length).toBe(2000);
    expect((T.groupMessage[0].body as string).length).toBe(4000);
    expect((T.adminGroupMessage[0].text as string).length).toBe(500);
  });

  it("its @-mentions are named from the club's roster, and one the roster cannot name is never stored as digits", async () => {
    seed();
    T.membership.push(row({ orgId: "org-a", user: { id: "u-ali", name: "Ali Example", phoneNumber: `+${ALI_PN}` } }));
    await applyMessageChange(editBy(SAM, "ask @447700900456 or @158000000000099", { mentions: [`${ALI_PN}@c.us`, "158000000000099@lid"] }));
    expect(analyzed().body).toBe("ask @Ali Example or @someone");
    expect(JSON.stringify([T.analyzedMessage, T.groupMessage, T.adminGroupMessage])).not.toMatch(/447700900456|158000000000099/);
  });

  it("an edit that left no text (a caption removed) clears the text", async () => {
    seed();
    await applyMessageChange(editBy(SAM, ""));
    expect(analyzed().body).toBeNull();
    expect(T.groupMessage[0].body).toBe("");
    expect(T.adminGroupMessage[0].text).toBe("");
  });

  it("by anyone else: ignored, nothing changes", async () => {
    seed();
    expect(await applyMessageChange(editBy(ALI, "I owe everyone £50"))).toEqual({ analyzed: 0, archived: 0, hq: 0, mentions: 0, refused: 4 });
    expect(analyzed()).toMatchObject({ body: "my door code is 4321", reasoning: "Sam shared a door code 4321" });
    expect(JSON.stringify(T)).not.toContain("£50");
  });
});

/**
 * A WhatsApp message deleted for everyone leaves MatchTime's stored chat,
 * and an edit replaces it (2026-11-15, `message-change.ts`).
 *
 * The pure half (what the Pi's post must carry, which stored ids are the
 * message, whether an edit is its author's) and the store half against an
 * in-memory fake of the four tables. Made-up people, simulated numbers.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeTable, row, type Row } from "./fake-message-db";

const T: Record<string, Row[]> = {};
const tables = () => ({
  analyzedMessage: makeTable((T.analyzedMessage ??= [])),
  groupMessage: makeTable((T.groupMessage ??= [])),
  adminGroupMessage: makeTable((T.adminGroupMessage ??= [])),
  messageMentions: makeTable((T.messageMentions ??= [])),
});
vi.mock("@/lib/db", () => ({
  get db() {
    return tables();
  },
}));

import {
  applyMessageChange,
  editIsByAuthor,
  isStoredIdOf,
  parseMessageChangeInput,
  storedIdForms,
} from "../message-change";

const G = "120363000000000111@g.us";
const OTHER_G = "120363000000000222@g.us";
const ID = "3EB0AAAA1111BBBB";
const SAM_PN = "447700900123";
const SAM_LID = "158055467598020";
const SAM_ID = `false_${G}_${ID}_${SAM_PN}@c.us`;

beforeEach(() => {
  for (const k of ['analyzedMessage', 'groupMessage', 'adminGroupMessage', 'messageMentions']) T[k] = [];
});

// ── The Pi's post ──────────────────────────────────────────────────────

describe("parseMessageChangeInput", () => {
  it("takes a revoke: a group, a message id", () => {
    expect(parseMessageChangeInput({ kind: "revoke", chatId: G, messageId: ID })).toEqual({ kind: "revoke", chatId: G, messageId: ID });
  });

  it("takes an edit with its new text and who sent it", () => {
    expect(
      parseMessageChangeInput({ kind: "edit", chatId: G, messageId: ID, text: "  in, sorry late  ", senderJids: [`${SAM_LID}@lid`, 5], senderPhone: "+44 7700 900123" }),
    ).toEqual({ kind: "edit", chatId: G, messageId: ID, text: "in, sorry late", senderJids: [`${SAM_LID}@lid`], senderPhone: SAM_PN });
  });

  it("refuses what is not a group message change", () => {
    expect(parseMessageChangeInput(null)).toBeNull();
    expect(parseMessageChangeInput({ kind: "revoke", chatId: "447700900123@c.us", messageId: ID })).toBeNull();
    expect(parseMessageChangeInput({ kind: "revoke", chatId: G })).toBeNull();
    expect(parseMessageChangeInput({ kind: "revoke", chatId: G, messageId: "a b" })).toBeNull();
    expect(parseMessageChangeInput({ kind: "revoke", chatId: G, messageId: "x@y" })).toBeNull();
    expect(parseMessageChangeInput({ kind: "react", chatId: G, messageId: ID })).toBeNull();
    // An edit with no new text is not something we can store.
    expect(parseMessageChangeInput({ kind: "edit", chatId: G, messageId: ID, text: "   " })).toBeNull();
  });

  it("cuts a giant edit to the archive's 4000 characters", () => {
    const r = parseMessageChangeInput({ kind: "edit", chatId: G, messageId: ID, text: "x".repeat(9000) });
    expect(r && r.kind === "edit" && r.text.length).toBe(4000);
  });
});

// ── Which stored ids are this message ──────────────────────────────────

describe("isStoredIdOf: matched by WhatsApp id and group, never by text", () => {
  it("the serialised forms, with and without a participant", () => {
    expect(isStoredIdOf(SAM_ID, G, ID)).toBe(true);
    expect(isStoredIdOf(`false_${G}_${ID}_${SAM_LID}@lid`, G, ID)).toBe(true);
    expect(isStoredIdOf(`true_${G}_${ID}`, G, ID)).toBe(true);
  });

  it("not another group's message with the same id, nor a longer id", () => {
    expect(isStoredIdOf(`false_${OTHER_G}_${ID}_${SAM_PN}@c.us`, G, ID)).toBe(false);
    expect(isStoredIdOf(`false_${G}_${ID}X_${SAM_PN}@c.us`, G, ID)).toBe(false);
    expect(isStoredIdOf(`false_${G}_${ID}_X_${SAM_PN}@c.us`, G, ID)).toBe(false);
    expect(isStoredIdOf(`synthetic:abc`, G, ID)).toBe(false);
  });

  it("the bare id only where the caller says the row is already this group's", () => {
    expect(isStoredIdOf(ID, G, ID)).toBe(false);
    expect(isStoredIdOf(ID, G, ID, { bare: true })).toBe(true);
  });

  it("a prefixed form (the players' group's organiser lines in HQ's table)", () => {
    expect(isStoredIdOf(`group:${SAM_ID}`, G, ID, { prefix: "group:" })).toBe(true);
    expect(isStoredIdOf(SAM_ID, G, ID, { prefix: "group:" })).toBe(false);
  });

  it("storedIdForms lists the exact ids and the participant prefixes", () => {
    const f = storedIdForms(G, ID);
    expect(f.exact).toEqual([`false_${G}_${ID}`, `true_${G}_${ID}`]);
    expect(f.prefixes).toEqual([`false_${G}_${ID}_`, `true_${G}_${ID}_`]);
    expect(storedIdForms(G, ID, "group:").exact[0]).toBe(`group:false_${G}_${ID}`);
  });
});

describe("editIsByAuthor: an edit replaces only its author's words", () => {
  it("the stored participant is one of the sender's JIDs, either spelling", () => {
    expect(editIsByAuthor({ storedId: SAM_ID, chatId: G, messageId: ID }, { jids: [`${SAM_PN}@c.us`], phone: null })).toBe(true);
    expect(
      editIsByAuthor({ storedId: `false_${G}_${ID}_${SAM_LID}@lid`, chatId: G, messageId: ID }, { jids: [`${SAM_LID}@lid`, `${SAM_PN}@c.us`], phone: null }),
    ).toBe(true);
  });

  it("or the stored phone is the sender's phone", () => {
    expect(
      editIsByAuthor({ storedId: `false_${G}_${ID}_${SAM_LID}@lid`, chatId: G, messageId: ID, storedPhone: `+${SAM_PN}` }, { jids: [], phone: SAM_PN }),
    ).toBe(true);
  });

  it("someone else's edit, or one nobody can check, is not the author's", () => {
    expect(editIsByAuthor({ storedId: SAM_ID, chatId: G, messageId: ID }, { jids: ["447700900999@c.us"], phone: "447700900999" })).toBe(false);
    expect(editIsByAuthor({ storedId: `true_${G}_${ID}`, chatId: G, messageId: ID }, { jids: [], phone: null })).toBe(false);
  });
});

// ── The stores ─────────────────────────────────────────────────────────

function seed() {
  T.analyzedMessage.push(
    row({ waMessageId: SAM_ID, orgId: "org-a", groupId: G, authorPhone: SAM_PN, body: "my door code is 4321", reasoning: "Sam shared a door code 4321", pipelineTrace: { v: 1, facts: "4321" }, handledBy: "none" }),
    // Same WhatsApp id in ANOTHER group: never touched.
    row({ waMessageId: `false_${OTHER_G}_${ID}_${SAM_PN}@c.us`, orgId: "org-b", groupId: OTHER_G, authorPhone: SAM_PN, body: "other group's words", handledBy: "none" }),
    row({ waMessageId: `false_${G}_OTHERID999_${SAM_PN}@c.us`, orgId: "org-a", groupId: G, authorPhone: SAM_PN, body: "unrelated line", handledBy: "none" }),
  );
  T.groupMessage.push(
    row({ waMessageId: SAM_ID, orgId: "org-a", waChatId: G, senderPhone: SAM_PN, body: "my door code is 4321" }),
    row({ waMessageId: `false_${G}_OTHERID999_${SAM_PN}@c.us`, orgId: "org-a", waChatId: G, senderPhone: SAM_PN, body: "unrelated line" }),
  );
  T.adminGroupMessage.push(
    row({ waMessageId: SAM_ID, orgId: "org-a", fromMatchTime: false, text: "my door code is 4321", pipelineTrace: { v: 1 } }),
    row({ waMessageId: `group:${SAM_ID}`, orgId: "org-a", fromMatchTime: false, text: "my door code is 4321" }),
    row({ waMessageId: "mt:teams:m1:1:abc", orgId: "org-a", fromMatchTime: true, text: "Teams ready, YES?" }),
  );
  T.messageMentions.push(row({ waMessageId: SAM_ID, orgId: "org-a", chatId: G, mentions: [{ phone: "447700900555" }] }));
}

describe("applyMessageChange: a delete for everyone", () => {
  it("removes the text from every store, and only this message's", async () => {
    seed();
    const r = await applyMessageChange({ kind: "revoke", chatId: G, messageId: ID });
    expect(r).toEqual({ analyzed: 1, archived: 1, hq: 2, mentions: 1, editsRefused: 0 });

    const a = T.analyzedMessage.find((x) => x.waMessageId === SAM_ID)!;
    // The row stays (it is the analyze route's dedupe key, so a replay of
    // the same message is not analysed again); its words do not.
    expect(a.body).toBeNull();
    expect(a.reasoning).toBeNull();
    expect(a.pipelineTrace).toBeNull();
    expect(T.groupMessage.find((x) => x.waMessageId === SAM_ID)!.body).toBe("");
    expect(T.adminGroupMessage.map((x) => x.waMessageId)).toEqual(["mt:teams:m1:1:abc"]);
    expect(T.messageMentions).toEqual([]);

    expect(JSON.stringify(T)).not.toContain("4321");
    expect(T.analyzedMessage.map((x) => x.body)).toEqual([null, "other group's words", "unrelated line"]);
    expect(T.groupMessage.map((x) => x.body)).toEqual(["", "unrelated line"]);
  });

  it("finds a row stored under the bare id in this group", async () => {
    T.analyzedMessage.push(row({ waMessageId: ID, orgId: "org-a", groupId: G, body: "secret", handledBy: "none" }));
    T.analyzedMessage.push(row({ waMessageId: ID + "Z", orgId: "org-a", groupId: G, body: "keep", handledBy: "none" }));
    const r = await applyMessageChange({ kind: "revoke", chatId: G, messageId: ID });
    expect(r.analyzed).toBe(1);
    expect(T.analyzedMessage.map((x) => x.body)).toEqual([null, "keep"]);
  });

  it("is idempotent and harmless for a message nobody stored", async () => {
    seed();
    await applyMessageChange({ kind: "revoke", chatId: G, messageId: ID });
    const again = await applyMessageChange({ kind: "revoke", chatId: G, messageId: ID });
    expect(again).toEqual({ analyzed: 1, archived: 1, hq: 0, mentions: 0, editsRefused: 0 });
    expect(await applyMessageChange({ kind: "revoke", chatId: G, messageId: "NOBODY123456" })).toEqual({ analyzed: 0, archived: 0, hq: 0, mentions: 0, editsRefused: 0 });
  });
});

describe("applyMessageChange: an edit", () => {
  it("replaces the text with the edited text, by its author", async () => {
    seed();
    const r = await applyMessageChange({ kind: "edit", chatId: G, messageId: ID, text: "running 10 mins late", senderJids: [`${SAM_PN}@c.us`], senderPhone: SAM_PN });
    expect(r).toEqual({ analyzed: 1, archived: 1, hq: 2, mentions: 0, editsRefused: 0 });
    expect(T.analyzedMessage.find((x) => x.waMessageId === SAM_ID)!.body).toBe("running 10 mins late");
    expect(T.groupMessage.find((x) => x.waMessageId === SAM_ID)!.body).toBe("running 10 mins late");
    expect(T.adminGroupMessage.filter((x) => !x.fromMatchTime).map((x) => x.text)).toEqual(["running 10 mins late", "running 10 mins late"]);
    // The mentions are left as they were: an edit is not re-read.
    expect(T.messageMentions).toHaveLength(1);
    expect(T.analyzedMessage.find((x) => x.waMessageId === `false_${OTHER_G}_${ID}_${SAM_PN}@c.us`)!.body).toBe("other group's words");
  });

  it("cuts HQ's copy to its 500 characters", async () => {
    seed();
    await applyMessageChange({ kind: "edit", chatId: G, messageId: ID, text: "y".repeat(800), senderJids: [`${SAM_PN}@c.us`], senderPhone: SAM_PN });
    expect((T.adminGroupMessage[0].text as string).length).toBe(500);
    expect((T.analyzedMessage[0].body as string).length).toBe(800);
  });

  it("someone else's edit never puts words in the author's mouth: the old text is removed instead", async () => {
    seed();
    const r = await applyMessageChange({ kind: "edit", chatId: G, messageId: ID, text: "I owe everyone £50", senderJids: ["447700900999@c.us"], senderPhone: "447700900999" });
    expect(r.editsRefused).toBe(4);
    expect(JSON.stringify(T)).not.toContain("£50");
    expect(JSON.stringify(T)).not.toContain("4321");
    expect(T.analyzedMessage[0].body).toBeNull();
    expect(T.groupMessage[0].body).toBe("");
    expect(T.adminGroupMessage.map((x) => x.waMessageId)).toEqual(["mt:teams:m1:1:abc"]);
  });
});

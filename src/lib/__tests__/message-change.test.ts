/**
 * EDIT OR DELETE A MESSAGE, AND MATCHTIME FORGETS THE ORIGINAL WORDS
 * (2026-11-15, `message-change.ts`, round 3).
 *
 * An edit by its author is a purge of the stored words through the very
 * path a delete takes (the tombstone, then every copy cleared), and the new
 * words are never stored. Only a DELETE cancels what MatchTime was about to
 * do because of the message (a proposal, a reminder, a draft DM); an edit
 * never does. The pure half (what the Pi's post carries, which stored ids are
 * the message, who may delete or edit it) and the store half against an
 * in-memory fake whose `$transaction` rolls back. Made-up people,
 * simulated numbers.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { failures, makeDb, row, type Row } from "./fake-message-db";
import { formNotesWin } from "../form-note-rules";

const NAMES = ["analyzedMessage", "groupMessage", "adminGroupMessage", "messageMentions", "deletedMessage", "organisation", "adminSquadProposal", "adminFeeProposal", "botJob", "formNote", "ratingAdjustment", "sentNotification", "onboardingSession", "clubConnect"];
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
  SWEEP_NEVER_MAX,
  SWEEP_RECHECK_MAX,
  SWEEP_RECHECK_MS,
  withoutDeletedQuotes,
  withoutChangedHistory,
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
const words = () => JSON.stringify([T.analyzedMessage, T.groupMessage, T.adminGroupMessage, T.messageMentions, T.formNote]);
/** A tombstone row as the table holds it (its latest change defaults to its first). */
const tomb = (f: Record<string, unknown>) => row({ changes: [], lastChangeAt: f.deletedAt, ...f });

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
  T.formNote.push(row({ orgId: "org-a", matchId: "m1", userId: "u-sam", delta: -1, reason: "code 4321", sourceMessageId: SAM_ID, createdAt: at, updatedAt: at }));
}
const analyzed = () => T.analyzedMessage.find((x) => x.waMessageId === SAM_ID)!;

describe("a delete for everyone", () => {
  it("by its author: the words leave every store, only this message's, and the delete is recorded", async () => {
    seed();
    expect(await applyMessageChange(byAuthor, NOW)).toEqual({ analyzed: 1, archived: 1, hq: 1, mentions: 1, notes: 1, refused: 0 });
    expect(analyzed()).toMatchObject({ body: null, reasoning: null, pipelineTrace: null });
    expect(T.groupMessage.find((x) => x.waMessageId === SAM_ID)!.body).toBe("");
    expect(T.adminGroupMessage.map((x) => x.waMessageId)).toEqual(["mt:teams:m1:1:abc"]);
    expect(T.messageMentions).toEqual([]);
    expect(T.formNote[0]).toMatchObject({ reason: "", delta: -1, sourceMessageId: SAM_ID });
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
    expect(await applyMessageChange({ ...byAuthor, ...ALI }, NOW)).toEqual({ analyzed: 0, archived: 0, hq: 0, mentions: 0, notes: 0, refused: 4 });
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
    expect(await applyMessageChange(byAuthor, NOW)).toEqual({ analyzed: 0, archived: 0, hq: 0, mentions: 0, notes: 0, refused: 0 });
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

describe("an edit purges the TEXT and keeps the FACTS (round 8)", () => {
  it("by its author: no original words are left anywhere, and no new words are stored; every row features read stays, with its facts", async () => {
    seed();
    expect(await applyMessageChange(editBy(SAM), NOW)).toEqual({ analyzed: 1, archived: 1, hq: 1, mentions: 0, notes: 1, refused: 0 });
    expect(words()).not.toContain("4321");
    expect(T.formNote[0]).toMatchObject({ reason: "", delta: -1 });
    // The model's reading keeps its structure (round 8), not its words.
    expect(analyzed()).toMatchObject({ body: null, reasoning: null, handledBy: "none", pipelineTrace: { v: 1, extractions: [] } });
    // The organiser line stays (sender, time, flags), its text blank: the safe-YES rule still sees that someone spoke.
    expect(T.adminGroupMessage.find((r) => r.waMessageId === `group:${SAM_ID}`)).toMatchObject({ text: "", fromMatchTime: false, hqOutcome: "hq-answered" });
    // The mentions stay: "DM the people above" still finds who this message tagged.
    expect(T.messageMentions).toHaveLength(1);
    expect(T.deletedMessage[0]).toMatchObject({ reason: "edited", byAdmin: false });
    // Idempotent: nothing left to purge the second time.
    expect(await applyMessageChange(editBy(SAM), NOW)).toEqual({ analyzed: 0, archived: 0, hq: 0, mentions: 0, notes: 0, refused: 0 });
  });

  // ── Round 11: copies of a note's words, found by WHICH MESSAGES they hold ──
  const A_BARE = "NOTEMSGA0001";
  const B_BARE = "NOTEMSGB0001";
  const A_ID = `false_${G}_${A_BARE}_${SAM_PN}@c.us`;
  const B_ID = `false_${G}_${B_BARE}_${SAM_PN}@c.us`;
  const ack = (id: string, text: string) => row({ key: `greply:org-a:${id}`, kind: "group-reply", text, createdAt: ago(5) });
  const adj = (userId: string, reason: string) => row({ matchId: "m2", userId, delta: -1, reason, confidence: 1 });

  for (const how of ["delete", "edit"] as const) {
    const change = (bare: string) => (how === "delete" ? { ...byAuthor, messageId: bare } : { ...editBy(SAM), messageId: bare });

    it(`${how}: ONE RULE: a later note replaced the reason (A, then B); a change to A clears the note's reason (B's too: over-clearing only loses words), every copy, every ack; the amount stays`, async () => {
      T.formNote.push(row({ orgId: "org-a", matchId: "m2", userId: "u-sam", delta: -1, reason: "knee", sourceMessageId: B_ID, reasonSourceMessageId: B_ID, reasonMessageIds: [A_ID, B_ID], createdAt: ago(9), updatedAt: ago(2) }));
      // Team generation copied A's reason while it stood.
      T.ratingAdjustment.push(adj("u-sam", "Form note in the chat: tired legs"));
      T.sentNotification.push(ack(A_ID, "Noted: -1 for Dan Dee (tired legs) in Tuesday's game."), ack(B_ID, "Changed: -1 for Dan Dee (knee) in Tuesday's game."), ack("false_other", "Noted: -1 for Ali (tired legs)."));
      await applyMessageChange(change(A_BARE), NOW);
      expect(T.formNote[0]).toMatchObject({ reason: "", delta: -1 });
      expect(T.ratingAdjustment[0].reason).toBe("");
      // The WHOLE ack goes, never a garbled half; another member's is untouched.
      expect(T.sentNotification.map((n) => n.text)).toEqual([null, null, "Noted: -1 for Ali (tired legs)."]);
    });

    it(`${how}: the amount was set to 0 later; changing the message that wrote the reason still clears its copy`, async () => {
      T.formNote.push(row({ orgId: "org-a", matchId: "m2", userId: "u-sam", delta: 0, reason: "ill", sourceMessageId: B_ID, reasonSourceMessageId: A_ID, reasonMessageIds: [A_ID, B_ID], createdAt: ago(9), updatedAt: ago(2) }));
      T.ratingAdjustment.push(adj("u-sam", "Form note in the chat: ill"));
      T.sentNotification.push(ack(A_ID, "Noted: -1 for Henry Hill (ill) in Tuesday's game."));
      await applyMessageChange(change(A_BARE), NOW);
      expect(T.formNote[0]).toMatchObject({ reason: "", delta: 0 });
      expect(T.ratingAdjustment[0].reason).toBe("");
      // "Henry Hill" is not garbled into "Henry H": the whole ack is blank.
      expect(T.sentNotification[0].text).toBeNull();
    });
  }

  it("a note recorded under the author's LID id, and a delete naming only their phone: matched through the stored copy's phone", async () => {
    const LID_ID = `false_${G}_${A_BARE}_${SAM_LID}@lid`;
    T.analyzedMessage.push(row({ waMessageId: LID_ID, orgId: "org-a", groupId: G, authorPhone: SAM_PN, body: "go easy, I'm tired", handledBy: "engine", createdAt: ago(9) }));
    T.formNote.push(row({ orgId: "org-a", matchId: "m2", userId: "u-sam", delta: -1, reason: "tired", sourceMessageId: LID_ID, reasonSourceMessageId: LID_ID, reasonMessageIds: [LID_ID], createdAt: ago(9), updatedAt: ago(2) }));
    await applyMessageChange({ ...byAuthor, messageId: A_BARE }, NOW);
    expect(T.formNote[0].reason).toBe("");
  });

  it("two players' notes in one club: a change to one player's message leaves the other's note and its copies untouched", async () => {
    const ALI_MSG = `false_${G}_ALINOTE00001_${ALI_PN}@c.us`;
    T.formNote.push(
      row({ orgId: "org-a", matchId: "m2", userId: "u-sam", delta: -1, reason: "tired", sourceMessageId: A_ID, reasonSourceMessageId: A_ID, reasonMessageIds: [A_ID], createdAt: ago(9), updatedAt: ago(2) }),
      row({ orgId: "org-a", matchId: "m2", userId: "u-ali", delta: 1, reason: "fresh legs", sourceMessageId: ALI_MSG, reasonSourceMessageId: ALI_MSG, reasonMessageIds: [ALI_MSG], createdAt: ago(9), updatedAt: ago(2) }),
    );
    T.ratingAdjustment.push(adj("u-sam", "Form note in the chat: tired"), adj("u-ali", "Form note in the chat: fresh legs"));
    T.sentNotification.push(ack(A_ID, "Noted: -1 for Sam (tired)."), ack(ALI_MSG, "Noted: +1 for Ali (fresh legs)."));
    await applyMessageChange({ ...byAuthor, messageId: A_BARE }, NOW);
    expect(T.formNote.map((n) => n.reason)).toEqual(["", "fresh legs"]);
    expect(T.ratingAdjustment.map((r) => r.reason)).toEqual(["", "Form note in the chat: fresh legs"]);
    expect(T.sentNotification.map((n) => n.text)).toEqual([null, "Noted: +1 for Ali (fresh legs)."]);
  });

  it("an ADMIN's delete of a message a note does not record matches no note", async () => {
    T.formNote.push(row({ orgId: "org-a", matchId: "m2", userId: "u-sam", delta: -1, reason: "tired", sourceMessageId: A_ID, reasonSourceMessageId: A_ID, reasonMessageIds: [A_ID], createdAt: ago(9), updatedAt: ago(2) }));
    T.ratingAdjustment.push(adj("u-sam", "Form note in the chat: tired"));
    await applyMessageChange({ ...byAuthor, ...ALI, byAdmin: true, messageId: "UNRELATED001" }, NOW);
    expect(T.formNote[0].reason).toBe("tired");
    expect(T.ratingAdjustment[0].reason).toBe("Form note in the chat: tired");
  });

  it("the adjuster's own row for the same player and match is left alone (only formNoteReason writes the prefix)", async () => {
    T.formNote.push(row({ orgId: "org-a", matchId: "m2", userId: "u-sam", delta: -1, reason: "tired", sourceMessageId: A_ID, reasonSourceMessageId: A_ID, reasonMessageIds: [A_ID], createdAt: ago(9), updatedAt: ago(2) }));
    T.ratingAdjustment.push(adj("u-sam", "Sam said he was tired, so a little lower"), adj("u-ali", "Form note in the chat: tired"));
    await applyMessageChange({ ...byAuthor, messageId: A_BARE }, NOW);
    expect(T.ratingAdjustment.map((r) => r.reason)).toEqual(["Sam said he was tired, so a little lower", "Form note in the chat: tired"]);
    expect(T.formNote[0].reason).toBe("");
  });

  it("THE RACE: team generation writes its copy AFTER the purge; clear-after-write and the sweep find the note by its message ids (its reason already blank) and clear it", async () => {
    T.formNote.push(row({ orgId: "org-a", matchId: "m2", userId: "u-sam", delta: -1, reason: "tired", sourceMessageId: A_ID, reasonSourceMessageId: A_ID, reasonMessageIds: [A_ID], createdAt: ago(9), updatedAt: ago(2) }));
    await applyMessageChange({ ...byAuthor, messageId: A_BARE }, ago(10));
    expect(T.formNote[0].reason).toBe("");
    // The generation that read the note before the purge writes now.
    T.ratingAdjustment.push(adj("u-sam", "Form note in the chat: tired"));
    T.sentNotification.push(ack(A_ID, "Noted: -1 for Sam Sample (tired) in Tuesday's game."));
    expect(await sweepRecentTombstones(NOW)).toMatchObject({ cleared: 1 });
    expect(T.ratingAdjustment[0].reason).toBe("");
    expect(T.sentNotification[0].text).toBeNull();
    // Idempotent.
    expect(await sweepRecentTombstones(NOW)).toMatchObject({ cleared: 0 });
  });
  it("and when the LATER message (the note's last source) is deleted, the reason goes too", async () => {
    const LATER_BARE = "LATERID00002";
    T.formNote.push(row({ orgId: "org-a", matchId: "m3", userId: "u-sam", delta: -2, reason: "tired", sourceMessageId: `false_${G}_${LATER_BARE}_${SAM_PN}@c.us`, reasonSourceMessageId: `false_${G}_EARLIER00002_${SAM_PN}@c.us`, createdAt: ago(9), updatedAt: ago(2) }));
    await applyMessageChange({ ...byAuthor, messageId: LATER_BARE }, NOW);
    expect(T.formNote[0]).toMatchObject({ reason: "" });
  });

  it("a DELETE after the edit still removes what a delete removes", async () => {
    seed();
    await applyMessageChange(editBy(SAM), NOW);
    expect(await applyMessageChange(byAuthor, NOW)).toMatchObject({ analyzed: 1, hq: 1, mentions: 1 });
    expect(analyzed()).toMatchObject({ body: null, pipelineTrace: null });
    expect(T.adminGroupMessage.map((x) => x.waMessageId)).toEqual(["mt:teams:m1:1:abc"]);
    expect(T.messageMentions).toEqual([]);
  });

  it("the model's reading keeps the refused-ask facts, and loses the raw output", async () => {
    T.analyzedMessage.push(
      row({
        waMessageId: SAM_ID,
        orgId: "org-a",
        groupId: G,
        authorPhone: SAM_PN,
        body: "@Match Time find a keeper, my code is 4321",
        reasoning: "4321",
        handledBy: "engine",
        intent: "admin",
        pipelineTrace: { v: 1, extractions: [{ extractor: "admin", facts: { kind: "admin", action: "recruit", pool: true, note: "code 4321" }, calls: [{ ms: 5, raw: "4321" }], degradations: ["4321"] }] },
        createdAt: ago(5),
      }),
    );
    await applyMessageChange(editBy(SAM), NOW);
    expect(analyzed()).toMatchObject({ body: null, reasoning: null, intent: "admin" });
    expect(analyzed().pipelineTrace).toEqual({ v: 1, extractions: [{ extractor: "admin", facts: { kind: "admin", action: "recruit", pool: true, note: "" }, calls: [{ ms: 5 }], degradations: [] }] });
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

  it("deletedAmong (the door) names only DELETED messages: a batch carrying an edited message's new content is not dropped", async () => {
    await applyMessageChange(editBy(SAM), NOW);
    expect((await deletedAmong(G, [{ id: SAM_ID }])).size).toBe(0);
    await applyMessageChange(byAuthor, NOW);
    expect([...(await deletedAmong(G, [{ id: SAM_ID }, { id: `false_${G}_OTHERID999_${SAM_PN}@c.us` }]))]).toEqual([SAM_ID]);
    expect((await deletedAmong(OTHER_G, [{ id: `false_${OTHER_G}_${ID}_${SAM_PN}@c.us` }])).size).toBe(0);
  });

  it("an edited message, either order: a stale ORIGINAL stored before the edit is purged; a copy written after it is cleared by clear-after-write", async () => {
    seed(); // the original, stored
    await applyMessageChange(editBy(SAM), NOW);
    expect(words()).not.toContain("4321");
    seed(); // a stale copy written after the edit (a replay)
    expect(await enforceDeletes(G, [SAM_ID])).toBe(1);
    expect(words()).not.toContain("4321");
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
  it("enforces a tombstone a request never cleared for, then re-checks it for 48 hours after its latest change, and not after", async () => {
    T.deletedMessage.push(tomb({ chatId: G, waMessageId: ID, byAdmin: false, reason: "deleted", senderJids: [`${SAM_PN}@c.us`], senderPhones: [SAM_PN], deletedAt: ago(10 * 60), enforcedAt: null }));
    seed(ago(9 * 60)); // written by a request that died before its own clear
    expect(await sweepRecentTombstones(NOW)).toMatchObject({ checked: 1, cleared: 1, pruned: 0 });
    expect(words()).not.toContain("4321");
    expect(T.deletedMessage[0].enforcedAt).toEqual(NOW);
    // Within 48 hours of its change: re-checked (30 hours on).
    expect(await sweepRecentTombstones(new Date(NOW.getTime() + 20 * 60 * 60 * 1000))).toMatchObject({ checked: 1 });
    // Enforced and past the 48-hour re-check window: not taken again.
    expect(await sweepRecentTombstones(new Date(NOW.getTime() + 39 * 60 * 60 * 1000))).toMatchObject({ checked: 0 });
  });

  it("a recent one is re-checked every run for late writers, even once enforced", async () => {
    await applyMessageChange(byAuthor, ago(30));
    seed(ago(20));
    expect(await sweepRecentTombstones(NOW)).toMatchObject({ checked: 1, cleared: 1 });
    expect(await sweepRecentTombstones(NOW)).toMatchObject({ checked: 1, cleared: 0 });
  });

  it("the SAME change posted again (an outbox retry, an admin re-check): a no-op for the record, so its re-check window is not moved on", async () => {
    await applyMessageChange(byAuthor, ago(49 * 60));
    await applyMessageChange(byAuthor, NOW);
    expect(T.deletedMessage[0]).toMatchObject({ lastChangeAt: ago(49 * 60) });
    expect(await sweepRecentTombstones(NOW)).toMatchObject({ checked: 0 });
  });

  it("the SAME change posted again leaves enforcedAt as it was (the upsert itself never resets it; its clear failing here shows what the upsert left)", async () => {
    await applyMessageChange(byAuthor, ago(60));
    expect(T.deletedMessage[0].enforcedAt).toEqual(ago(60));
    failures.beforeWrite = () => {
      throw new Error("the clear fails after the upsert");
    };
    seed(); // something to clear, so the clear writes (and fails)
    await expect(applyMessageChange(byAuthor, NOW)).rejects.toThrow();
    delete failures.beforeWrite;
    expect(T.deletedMessage[0].enforcedAt).toEqual(ago(60));
    // A NEW change does make it due again.
    failures.beforeWrite = () => {
      throw new Error("the clear fails after the upsert");
    };
    await expect(applyMessageChange({ ...byAuthor, ...ALI, byAdmin: true }, NOW)).rejects.toThrow();
    delete failures.beforeWrite;
    expect(T.deletedMessage[0].enforcedAt).toBeNull();
  });

  it("the sweep runs each tombstone ONCE per run, never in both its sets", async () => {
    T.deletedMessage.push(
      tomb({ chatId: G, waMessageId: "ONCE00000001", byAdmin: true, reason: "deleted", senderJids: [], senderPhones: [], deletedAt: ago(30), enforcedAt: null }),
      tomb({ chatId: G, waMessageId: "ONCE00000002", byAdmin: true, reason: "deleted", senderJids: [], senderPhones: [], deletedAt: ago(20), enforcedAt: ago(19) }),
      tomb({ chatId: G, waMessageId: "ONCE00000003", byAdmin: true, reason: "deleted", senderJids: [], senderPhones: [], deletedAt: ago(10), enforcedAt: ago(9) }),
    );
    const runs: string[] = [];
    failures.onTransaction = (label) => runs.push(label);
    try {
      expect(await sweepRecentTombstones(NOW)).toMatchObject({ checked: 3 });
    } finally {
      delete failures.onTransaction;
    }
    expect(runs).toHaveLength(3);
    // Every one is enforced at the end of its own run, and the next run takes the two recent ones again, still once each.
    expect(T.deletedMessage.every((t) => t.enforcedAt !== null)).toBe(true);
    expect(await sweepRecentTombstones(NOW)).toMatchObject({ checked: 3 });
  });

  it("late writers are re-checked for six hours after EACH change, not only the first", async () => {
    await applyMessageChange({ ...byAuthor, ...ALI }, ago(10 * 60)); // forged, ten hours ago
    await applyMessageChange(byAuthor, ago(60)); // the author's own, an hour ago
    expect(T.deletedMessage[0]).toMatchObject({ deletedAt: ago(10 * 60), lastChangeAt: ago(60) });
    seed(ago(30)); // a late writer after both
    expect(await sweepRecentTombstones(NOW)).toMatchObject({ checked: 1, cleared: 1 });
    expect(words()).not.toContain("4321");
  });

  it("a backlog of 600 never-enforced tombstones is cleared in two runs, oldest first", async () => {
    for (let i = 0; i < 600; i++) {
      const bare = `BACKLOG${String(i).padStart(6, "0")}`;
      const at = ago(24 * 60 + 600 - i);
      T.deletedMessage.push(tomb({ chatId: G, waMessageId: bare, byAdmin: true, reason: "deleted", senderJids: [], senderPhones: [], deletedAt: at, enforcedAt: null }));
      T.analyzedMessage.push(row({ waMessageId: `false_${G}_${bare}_${SAM_PN}@c.us`, orgId: "org-a", groupId: G, authorPhone: SAM_PN, body: `secret ${i}`, handledBy: "none", createdAt: at }));
    }
    expect(await sweepRecentTombstones(NOW)).toMatchObject({ cleared: 500 });
    expect(await sweepRecentTombstones(NOW)).toMatchObject({ cleared: 100 });
    expect(T.analyzedMessage.filter((r) => r.body !== null)).toEqual([]);
    expect(await sweepRecentTombstones(NOW)).toMatchObject({ cleared: 0 });
  });

  it("a backlog of never-enforced tombstones never starves the re-checks: each has its own cap, the re-checks oldest-checked first", async () => {
    // 40 enforced tombstones whose late writers need re-checking, checked at different times.
    for (let i = 0; i < 40; i++) {
      const bare = `RECHECK${String(i).padStart(5, "0")}`;
      T.deletedMessage.push(tomb({ chatId: G, waMessageId: bare, byAdmin: true, reason: "deleted", senderJids: [], senderPhones: [], deletedAt: ago(30 * 60), enforcedAt: ago(40 - i) }));
      // A late writer for each.
      T.analyzedMessage.push(row({ waMessageId: `false_${G}_${bare}_${SAM_PN}@c.us`, orgId: "org-a", groupId: G, authorPhone: SAM_PN, body: `late ${i}`, handledBy: "none", createdAt: ago(5) }));
    }
    // And a backlog far over the never-enforced cap.
    for (let i = 0; i < SWEEP_NEVER_MAX + 50; i++) {
      T.deletedMessage.push(tomb({ chatId: G, waMessageId: `NEVER${String(i).padStart(7, "0")}`, byAdmin: true, reason: "deleted", senderJids: [], senderPhones: [], deletedAt: ago(60), enforcedAt: null }));
    }
    const r = await sweepRecentTombstones(NOW);
    expect(r.checked).toBe(SWEEP_NEVER_MAX + Math.min(40, SWEEP_RECHECK_MAX));
    // The late writers were cleared, despite the backlog.
    expect(T.analyzedMessage.filter((x) => typeof x.body === "string" && x.body.startsWith("late"))).toEqual([]);
    expect(SWEEP_RECHECK_MS).toBe(48 * 60 * 60 * 1000);
  });

  it("prunes tombstones older than the retention, and never applies a change that does not apply", async () => {
    await applyMessageChange({ ...byAuthor, ...ALI }, ago(10));
    T.deletedMessage.push(tomb({ chatId: G, waMessageId: "OLDMESSAGE01", byAdmin: true, reason: "deleted", senderJids: [], senderPhones: [], deletedAt: ago((DELETED_MESSAGE_RETENTION_DAYS + 1) * 24 * 60), enforcedAt: null }));
    seed();
    expect(await sweepRecentTombstones(NOW)).toMatchObject({ checked: 1, cleared: 0, pruned: 1 });
    expect(analyzed().body).toBe("my door code is 4321");
    expect(T.deletedMessage).toHaveLength(1);
  });
});

describe("the tombstone is merged atomically", () => {
  it("two changes of one message at once (an admin's and the author's) never lose byAdmin or a sender", async () => {
    seed();
    await Promise.all([applyMessageChange({ ...byAuthor, ...ALI, byAdmin: true }, NOW), applyMessageChange(byAuthor, NOW), applyMessageChange(editBy(SAM), NOW)]);
    expect(T.deletedMessage).toHaveLength(1);
    expect(T.deletedMessage[0]).toMatchObject({ byAdmin: true, reason: "deleted" });
    expect([...(T.deletedMessage[0].senderPhones as string[])].sort()).toEqual([SAM_PN, ALI_PN].sort());
  });

  it("a group linked to no club records nothing", async () => {
    expect(await applyMessageChange({ ...byAuthor, chatId: "120363000000000777@g.us" }, NOW)).toMatchObject({ analyzed: 0 });
    expect(T.deletedMessage).toEqual([]);
  });
});

describe("the other stores a message's words reach", () => {
  it("HQ proposals made from the message are cancelled and their copied names, month seed and fee text cleared; a YES then applies nothing", async () => {
    const HQ_ID = `false_${HQ}_${ID}_${SAM_PN}@c.us`;
    T.adminSquadProposal.push(
      row({ orgId: "org-a", matchId: "m1", waMessageId: HQ_ID, proposedByUserId: "u-sam", playingUserIds: ["u1"], playingNewNames: ["Door Code Dave"], reserveUserIds: [], reserveNewNames: ["Secret Sid"], monthSeed: { names: ["Dave"] }, resolvedAt: null, outcome: null, createdAt: ago(5), expiresAt: ago(-60) }),
    );
    T.adminFeeProposal.push(row({ orgId: "org-a", matchId: "m1", waMessageId: HQ_ID, proposedByUserId: "u-sam", userIds: ["u1"], text: "£10 each, code 4321", resolvedAt: null, createdAt: ago(5), expiresAt: ago(-60) }));
    // MatchTime's own question about the list, which repeats its names.
    T.sentNotification.push(
      row({ key: `hqreply:org-a:${HQ_ID}`, kind: "admin-group-reply", waMessageId: "true_HQ_3EB0ASKED0001", text: "I read: Door Code Dave, Secret Sid. Reply YES", createdAt: ago(5) }),
      row({ key: "hqreply:org-a:false_other", kind: "admin-group-reply", waMessageId: "true_HQ_3EB0OTHER0001", text: "an unrelated reply", createdAt: ago(5) }),
    );
    T.adminGroupMessage.push(
      row({ waMessageId: "mt:list:1", orgId: "org-a", fromMatchTime: true, askRef: `list:${HQ_ID}`, text: "I read: Door Code Dave, Secret Sid. Reply YES", createdAt: ago(5) }),
      row({ waMessageId: "mt:list:2", orgId: "org-a", fromMatchTime: true, askRef: "list:false_other", text: "another list", createdAt: ago(5) }),
    );
    // The fee question's HQ line, and the month-seed draft's DM offer (round 8).
    T.adminGroupMessage.push(row({ waMessageId: "mt:fee:1", orgId: "org-a", fromMatchTime: true, askRef: `fee:${T.adminFeeProposal[0].id}`, text: "Free place for Door Code Dave? Say YES", createdAt: ago(5) }));
    T.sentNotification.push(row({ key: `org-org-a:month-seed-dm:${T.adminSquadProposal[0].id}`, kind: "month-seed-dm", text: "Your month: Door Code Dave, Secret Sid", createdAt: ago(5) }));
    await applyMessageChange({ ...byAuthor, chatId: HQ }, NOW);
    expect(T.adminSquadProposal[0]).toMatchObject({ resolvedAt: NOW, outcome: "source-deleted", playingNewNames: [], reserveNewNames: [], monthSeed: null });
    expect(T.adminFeeProposal[0]).toMatchObject({ resolvedAt: NOW, outcome: "source-deleted", text: "" });
    expect(T.sentNotification.map((n) => n.text)).toEqual([null, "an unrelated reply", null]);
    expect(T.sentNotification[0].waMessageId).toBe("true_HQ_3EB0ASKED0001");
    expect(T.adminGroupMessage.map((m) => m.text)).toEqual(["", "another list", ""]);
    expect(JSON.stringify([T.sentNotification, T.adminGroupMessage])).not.toContain("Door Code Dave");
  });

  it("a DELETE: an unsent reminder DM asked for in the message is cancelled; a SENT one, and a sent month-seed draft, keep their rows but lose their words; another message's stays", async () => {
    T.botJob.push(
      row({ orgId: "org-a", kind: "dm", phone: SAM_PN, text: "⏰ Reminder: door code 4321", aboutKey: `asked-reminder:${SAM_ID}`, sentAt: null, createdAt: ago(5) }),
      row({ orgId: "org-a", kind: "dm", phone: SAM_PN, text: "⏰ Reminder: door code 4321 (sent)", aboutKey: `asked-reminder:${SAM_ID}`, sentAt: ago(1), createdAt: ago(5) }),
      row({ orgId: "org-a", kind: "dm", phone: SAM_PN, text: "Your month: Door Code Dave", aboutKey: `month-seed-of:${SAM_ID}`, sentAt: ago(1), createdAt: ago(5) }),
      row({ orgId: "org-a", kind: "dm", phone: SAM_PN, text: "⏰ Reminder: an old one", aboutKey: `asked-reminder:false_${G}_OTHERID999_${SAM_PN}@c.us`, sentAt: null, createdAt: ago(5) }),
    );
    // Their dispatch claims (`due-posts` writes `botjob-<id>` with the DM's words), one acked, one claimed but not acked yet.
    const [unsent, sent, seedDraft, other] = T.botJob;
    T.sentNotification.push(
      row({ key: `botjob-${sent.id}`, kind: "dm", text: sent.text, waMessageId: "true_x_3EB0SENT", createdAt: ago(2) }),
      row({ key: `botjob-${seedDraft.id}`, kind: "dm", text: seedDraft.text, waMessageId: "true_x_3EB0SEED", createdAt: ago(2) }),
      row({ key: `botjob-${unsent.id}`, kind: "dm", text: unsent.text, waMessageId: null, createdAt: ago(1) }),
      row({ key: `botjob-${other.id}`, kind: "dm", text: other.text, waMessageId: null, createdAt: ago(1) }),
    );
    await applyMessageChange(byAuthor, NOW);
    expect(T.botJob.map((j) => [j.text, j.sentAt !== null])).toEqual([
      ["", true],
      ["", true],
      ["⏰ Reminder: an old one", false],
    ]);
    expect(T.sentNotification.map((n) => n.text)).toEqual([null, null, null, "⏰ Reminder: an old one"]);
    expect(JSON.stringify([T.botJob, T.sentNotification])).not.toContain("4321");
  });

  it("an EDIT leaves the reminder DMs, sent or not, as they are (MatchTime acted on what it read)", async () => {
    T.botJob.push(
      row({ orgId: "org-a", kind: "dm", phone: SAM_PN, text: "⏰ Reminder: bring the bibs", aboutKey: `asked-reminder:${SAM_ID}`, sentAt: null, createdAt: ago(5) }),
      row({ orgId: "org-a", kind: "dm", phone: SAM_PN, text: "⏰ Reminder: bring the bibs (sent)", aboutKey: `asked-reminder:${SAM_ID}`, sentAt: ago(1), createdAt: ago(5) }),
    );
    await applyMessageChange(editBy(SAM), NOW);
    expect(T.botJob.map((j) => j.text)).toEqual(["⏰ Reminder: bring the bibs", "⏰ Reminder: bring the bibs (sent)"]);
  });

  it("mention rows go only with their own author's (or an admin's) change: a member reusing another member's bare id removes nothing of theirs", async () => {
    T.messageMentions.push(row({ waMessageId: SAM_ID, orgId: "org-a", chatId: G, mentions: [{ phone: "447700900555" }], sentAt: ago(5), createdAt: ago(5) }));
    const ALI_ID = `false_${G}_${ID}_${ALI_PN}@c.us`;
    T.analyzedMessage.push(row({ waMessageId: ALI_ID, orgId: "org-a", groupId: G, authorPhone: ALI_PN, body: "Ali's own words", handledBy: "none", createdAt: ago(5) }));
    await applyMessageChange({ ...byAuthor, ...ALI }, NOW);
    expect(T.analyzedMessage.find((r) => r.waMessageId === ALI_ID)!.body).toBeNull();
    expect(T.messageMentions).toHaveLength(1);
  });

  it("an author whose copy is stored under a phone JID, deleting with only a LID: matched through the club's LID map", async () => {
    seed();
    T.clubConnect.push(row({ orgId: "org-a", userId: "u-sam", dmLid: null, participants: [{ phone: `+${SAM_PN}`, lidId: SAM_LID, pushname: "Sam" }] }));
    expect(await applyMessageChange({ ...byAuthor, senderJids: [`${SAM_LID}@lid`], senderPhone: null }, NOW)).toMatchObject({ analyzed: 1, archived: 1, mentions: 1 });
    expect(words()).not.toContain("4321");
  });

  it("without that mapping, the same LID-only delete is refused", async () => {
    seed();
    expect(await applyMessageChange({ ...byAuthor, senderJids: [`${SAM_LID}@lid`], senderPhone: null }, NOW)).toMatchObject({ analyzed: 0 });
  });
});

describe("round 5: the guards on proposals and DMs, the LID map for quotes, a sweep that never stalls", () => {
  const HQ_ID = `false_${HQ}_${ID}_${SAM_PN}@c.us`;
  const openProposals = () => {
    T.adminSquadProposal.push(
      row({ orgId: "org-a", matchId: "m1", waMessageId: HQ_ID, proposedByUserId: "u-sam", playingUserIds: ["u1"], playingNewNames: ["Door Code Dave"], reserveUserIds: [], reserveNewNames: [], monthSeed: null, resolvedAt: null, outcome: null, createdAt: ago(5), expiresAt: ago(-60) }),
    );
    T.adminFeeProposal.push(row({ orgId: "org-a", matchId: "m1", waMessageId: HQ_ID, proposedByUserId: "u-sam", userIds: ["u1"], text: "£10 each", resolvedAt: null, createdAt: ago(5), expiresAt: ago(-60) }));
    T.botJob.push(row({ orgId: "org-a", kind: "dm", phone: SAM_PN, text: "Your month draft: Dave, Sid", aboutKey: `month-seed-of:${HQ_ID}`, sentAt: null, createdAt: ago(5) }));
  };

  it("a FORGED delete or edit (neither the author nor an admin) leaves someone else's proposals open and their DMs queued, and counts them refused", async () => {
    openProposals();
    const forgedEdit = await applyMessageChange({ ...editBy(ALI), chatId: HQ }, NOW);
    const forgedDelete = await applyMessageChange({ ...byAuthor, ...ALI, chatId: HQ }, NOW);
    expect(T.adminSquadProposal[0]).toMatchObject({ resolvedAt: null, playingNewNames: ["Door Code Dave"] });
    expect(T.adminFeeProposal[0]).toMatchObject({ resolvedAt: null, text: "£10 each" });
    expect(T.botJob).toHaveLength(1);
    expect(forgedDelete.refused).toBe(3);
    // An edit never touches proposals or DMs, so it refuses none of them either.
    expect(forgedEdit.refused).toBe(0);
  });

  it("an EDIT never cancels a proposal or a DM, the author's included; the author's DELETE cancels them all, the month-seed draft DM too", async () => {
    openProposals();
    await applyMessageChange({ ...editBy(SAM), chatId: HQ }, NOW);
    expect(T.adminSquadProposal[0]).toMatchObject({ resolvedAt: null, outcome: null, playingNewNames: ["Door Code Dave"] });
    expect(T.adminFeeProposal[0]).toMatchObject({ resolvedAt: null, text: "£10 each" });
    expect(T.botJob).toHaveLength(1);
    await enforceDeletes(HQ, [HQ_ID]);
    expect(T.adminSquadProposal[0]).toMatchObject({ resolvedAt: null });
    await applyMessageChange({ ...byAuthor, chatId: HQ }, NOW);
    expect(T.adminSquadProposal[0]).toMatchObject({ resolvedAt: NOW, outcome: "source-deleted", playingNewNames: [] });
    expect(T.adminFeeProposal[0]).toMatchObject({ resolvedAt: NOW, outcome: "source-deleted", text: "" });
    expect(T.botJob).toEqual([]);
  });

  it("withoutDeletedQuotes widens the deleter through the club's LID map, as the clear does", async () => {
    T.clubConnect.push(row({ orgId: "org-a", userId: "u-sam", dmLid: null, participants: [{ phone: `+${SAM_PN}`, lidId: SAM_LID, pushname: "Sam" }] }));
    await applyMessageChange({ ...byAuthor, senderJids: [`${SAM_LID}@lid`], senderPhone: null }, NOW);
    const [out] = await withoutDeletedQuotes(G, [{ quotedMessageId: ID, quotedAuthorPhone: SAM_PN, quotedBody: "w" }], "quotedBody");
    expect(out.quotedBody).toBeUndefined();
  });

  it("an EDITED tombstone strips quotes of the message too (the author's)", async () => {
    await applyMessageChange(editBy(SAM), NOW);
    const [out] = await withoutDeletedQuotes(G, [{ quotedMessageId: ID, quotedAuthorJid: `${SAM_PN}@c.us`, quotedBody: "w" }], "quotedBody");
    expect(out.quotedBody).toBeUndefined();
  });

  it("the sweep catches per row: one tombstone whose clear fails does not stop the rest", async () => {
    T.deletedMessage.push(
      tomb({ chatId: G, waMessageId: "BROKEN000001", byAdmin: true, reason: "deleted", senderJids: [], senderPhones: [], deletedAt: ago(20 * 60), enforcedAt: null }),
      tomb({ chatId: G, waMessageId: ID, byAdmin: false, reason: "deleted", senderJids: [`${SAM_PN}@c.us`], senderPhones: [SAM_PN], deletedAt: ago(19 * 60), enforcedAt: null }),
    );
    seed(ago(18 * 60));
    T.analyzedMessage.push(row({ waMessageId: `false_${G}_BROKEN000001_${SAM_PN}@c.us`, orgId: "org-a", groupId: G, authorPhone: SAM_PN, body: "x", handledBy: "none", createdAt: ago(18 * 60) }));
    // Write 1 is the prune; write 2 is the first row's clear, which fails.
    let writes = 0;
    failures.beforeWrite = () => {
      if (++writes === 2) throw new Error("one bad row");
    };
    const r = await sweepRecentTombstones(NOW);
    expect(r.checked).toBe(2);
    expect(analyzed().body).toBeNull();
  });
});

describe("round 6: each change keeps its own sender, reason and time", () => {
  const HQ_ID = `false_${HQ}_${ID}_${SAM_PN}@c.us`;

  for (const order of ["forged delete, then the author's edit", "the author's edit, then a forged delete"]) {
    it(`${order}: never an authorised delete. The batch is not dropped (the IN counts); the text is purged`, async () => {
      const forged = { ...byAuthor, ...ALI };
      if (order.startsWith("forged")) {
        await applyMessageChange(forged, NOW);
        await applyMessageChange(editBy(SAM), NOW);
      } else {
        await applyMessageChange(editBy(SAM), NOW);
        await applyMessageChange(forged, NOW);
      }
      expect((await deletedAmong(G, [{ id: SAM_ID, authorPhone: SAM_PN }])).size).toBe(0);
      seed();
      await enforceDeletes(G, [SAM_ID]);
      expect(words()).not.toContain("4321");
      // The forged delete still drops nothing of Sam's, quotes included, beyond the edit's own purge.
      expect(T.deletedMessage[0].changes).toHaveLength(2);
    });
  }

  it("an authorised delete after an edit is a delete", async () => {
    await applyMessageChange(editBy(SAM), NOW);
    await applyMessageChange(byAuthor, NOW);
    expect([...(await deletedAmong(G, [{ id: SAM_ID }]))]).toEqual([SAM_ID]);
  });

  it("an edit never cancels anything, whenever it lands: before, between or after the proposals and DMs; only a delete does", async () => {
    const at = (m: number) => ago(m);
    T.adminSquadProposal.push(
      row({ orgId: "org-a", matchId: "m1", waMessageId: HQ_ID, proposedByUserId: "u-sam", playingUserIds: [], playingNewNames: ["Old Name"], reserveUserIds: [], reserveNewNames: [], monthSeed: null, resolvedAt: null, outcome: null, createdAt: at(10), expiresAt: ago(-60) }),
    );
    T.botJob.push(
      row({ orgId: "org-a", kind: "dm", phone: SAM_PN, text: "a draft", aboutKey: `month-seed-of:${HQ_ID}`, sentAt: null, createdAt: at(10) }),
      row({ orgId: "org-a", kind: "dm", phone: SAM_PN, text: "a reminder", aboutKey: `asked-reminder:${HQ_ID}`, sentAt: null, createdAt: at(1) }),
    );
    await applyMessageChange({ ...editBy(SAM), chatId: HQ }, at(5));
    await applyMessageChange({ ...editBy(SAM), chatId: HQ }, NOW);
    await enforceDeletes(HQ, [HQ_ID]);
    expect(await sweepRecentTombstones(NOW)).toMatchObject({ checked: 1 });
    expect(T.adminSquadProposal[0]).toMatchObject({ resolvedAt: null, playingNewNames: ["Old Name"] });
    expect(T.botJob.map((j) => j.text)).toEqual(["a draft", "a reminder"]);
    await applyMessageChange({ ...byAuthor, chatId: HQ }, NOW);
    expect(T.adminSquadProposal[0]).toMatchObject({ outcome: "source-deleted" });
    expect(T.botJob).toEqual([]);
  });

  it("the same change twice (a retry, a merged edit and its notice) is kept once whatever its time; at most 20 are kept, deletes before edits", async () => {
    await applyMessageChange(editBy(SAM), ago(3));
    await applyMessageChange(editBy(SAM), ago(2));
    await applyMessageChange(byAuthor, ago(1));
    await applyMessageChange(byAuthor, NOW);
    expect((T.deletedMessage[0].changes as Array<{ reason: string }>).map((c) => c.reason)).toEqual(["edited", "deleted"]);
    for (let i = 0; i < 25; i++) await applyMessageChange(editBy({ senderJids: [`4477009010${String(i).padStart(2, "0")}@c.us`], senderPhone: `4477009010${String(i).padStart(2, "0")}` }), NOW);
    await applyMessageChange({ ...byAuthor, ...ALI, byAdmin: true }, NOW);
    const kept = T.deletedMessage[0].changes as Array<{ reason: string; byAdmin: boolean }>;
    expect(kept).toHaveLength(20);
    expect(kept.filter((c) => c.reason === "deleted")).toHaveLength(2);
    expect(kept.some((c) => c.byAdmin)).toBe(true);
  });

  it("withoutChangedHistory (the server's safety net): a Pi recent-chat line of a deleted or EDITED message is dropped; a forged change, or a line with no id, is kept", async () => {
    await applyMessageChange(editBy(SAM), NOW);
    await applyMessageChange({ ...byAuthor, ...ALI, messageId: "OTHERID999" }, NOW);
    const lines = [
      { authorName: "Sam", body: "my door code is 4321", timestamp: ago(3).toISOString(), waMessageId: SAM_ID },
      { authorName: "Sam", body: "unrelated line", timestamp: ago(2).toISOString(), waMessageId: `false_${G}_OTHERID999_${SAM_PN}@c.us` },
      { authorName: "Old Pi", body: "no id", timestamp: ago(1).toISOString() },
    ];
    expect((await withoutChangedHistory(G, lines)).map((l) => l.body)).toEqual(["unrelated line", "no id"]);
  });
});

describe("a quote whose author the Pi did not name", () => {
  it("is tied to its author through the stored copy: the author's delete strips it, a forged one does not", async () => {
    seed();
    await applyMessageChange({ ...byAuthor, ...ALI }, NOW); // forged
    expect((await withoutDeletedQuotes(G, [{ quotedMessageId: ID, quotedBody: "w" }], "quotedBody"))[0].quotedBody).toBe("w");
    await applyMessageChange(byAuthor, NOW); // the author's (the stored copy is now cleared; the record still names him)
    expect((await withoutDeletedQuotes(G, [{ quotedMessageId: ID, quotedBody: "w" }], "quotedBody"))[0].quotedBody).toBeUndefined();
  });
});

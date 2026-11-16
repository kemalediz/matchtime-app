/**
 * EVERY READER, AFTER A DELETE OR AN EDIT (2026-11-15).
 *
 * The stores are changed by `applyMessageChange`; what matters is what a
 * later answer is SHOWN. So the same in-memory tables are changed and then
 * read back through the real readers that put stored chat in front of a
 * model or into a reply:
 *
 *   - the week of chat (`week-chat.ts`): the open answer, the unified
 *     answer and the rating adjuster, players' group and HQ;
 *   - the extractors' recent chat (`group-chat-history.ts`);
 *   - HQ's log and the players' group's organiser lines (`admin-group-log.ts`):
 *     the safe-YES rule and the router's recent lines;
 *   - the squad-from-list archive (`squad-from-list.ts`), which a model reads.
 *
 * Made-up people and simulated numbers; no model is called.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeDb, row, type Row } from "./fake-message-db";

const NAMES = ["analyzedMessage", "groupMessage", "adminGroupMessage", "messageMentions", "deletedMessage", "sentNotification", "botJob", "user", "membership", "userAlias", "organisation", "adminSquadProposal", "adminFeeProposal", "formNote", "ratingAdjustment", "onboardingSession", "clubConnect"];
const T: Record<string, Row[]> = {};
const fake = makeDb(T, NAMES, { deletedMessage: [["chatId", "waMessageId"]] });
vi.mock("@/lib/db", () => ({
  get db() {
    return fake.db;
  },
}));

import { applyMessageChange, dropExpiredHeldQuestions, enforceDeletes, sweepRecentTombstones } from "../message-change";
import { mentionsAbove } from "../group-mentions";
import { decideApproval } from "../admin-group-confirm-rules";
import { sourceQuestionAnswered } from "../ask-source-rules";
import { loadHqRecentMessages } from "../hq-squad-reader";
import { recentHqMessages } from "../organiser-pick";
import { hqWeekChat, loadWeekChat, playersWeekChat } from "../week-chat";
import { loadStoredGroupLines } from "../group-chat-history";
import { groupLogSince, hqLogSince } from "../admin-group-log";
import { loadSquadSourceMessages } from "../squad-from-list";
import { loadOpenStatsClarifications } from "../pipeline/load-awaiting-answer";
import { STATS_CLARIFICATION_INTENT } from "../pipeline/awaiting-answer";
import { latestAskFromRecords } from "../refused-ask-retry";

const NOW = new Date("2026-11-15T18:00:00.000Z");
const ago = (m: number) => new Date(NOW.getTime() - m * 60 * 1000);
const ORG = "org-a";
const G = "120363000000000111@g.us";
const HQ = "120363000000000999@g.us";
const SAM = "447700900123";
const ALI = "447700900456";
const SECRET = "my door code is 4321";
const KEEP = "see you all at 8";

const BY_SAM = { byAdmin: false, senderJids: [`${SAM}@c.us`], senderPhone: SAM };
const gid = (bare: string, phone: string, chat = G) => `false_${chat}_${bare}_${phone}@c.us`;

beforeEach(() => {
  for (const k of NAMES) T[k] = [];
  T.user.push({ id: "u-sam", name: "Sam Sample" }, { id: "u-ali", name: "Ali Example" });
  T.organisation.push({ id: ORG, whatsappGroupId: G, adminGroupId: HQ });
  // The players' group: Sam's secret, then Ali's line.
  T.analyzedMessage.push(
    row({ waMessageId: gid("SAMMSG000001", SAM), orgId: ORG, groupId: G, authorUserId: "u-sam", authorPhone: SAM, authorName: "Sam", body: SECRET, handledBy: "none", createdAt: ago(30) }),
    row({ waMessageId: gid("ALIMSG000001", ALI), orgId: ORG, groupId: G, authorUserId: "u-ali", authorPhone: ALI, authorName: "Ali", body: KEEP, handledBy: "none", createdAt: ago(20) }),
  );
  T.groupMessage.push(
    row({ waMessageId: gid("SAMMSG000001", SAM), orgId: ORG, waChatId: G, senderPhone: SAM, body: SECRET, timestamp: ago(30), createdAt: ago(30) }),
    row({ waMessageId: gid("ALIMSG000001", ALI), orgId: ORG, waChatId: G, senderPhone: ALI, body: KEEP, timestamp: ago(20), createdAt: ago(20) }),
  );
  // HQ: Sam's secret, and an organiser line of his from the players' group.
  T.adminGroupMessage.push(
    row({ waMessageId: gid("SAMHQ0000001", SAM, HQ), orgId: ORG, fromMatchTime: false, senderUserId: "u-sam", text: SECRET, askRef: null, createdAt: ago(15) }),
    row({ waMessageId: gid("ALIHQ0000001", ALI, HQ), orgId: ORG, fromMatchTime: false, senderUserId: "u-ali", text: KEEP, askRef: null, createdAt: ago(14) }),
    row({ waMessageId: `group:${gid("SAMMSG000001", SAM)}`, orgId: ORG, fromMatchTime: false, senderUserId: "u-sam", text: SECRET, askRef: null, createdAt: ago(30) }),
  );
});

async function everythingShown(): Promise<string> {
  const shown = [
    await loadWeekChat({ orgId: ORG, channel: "group", groupId: G, since: ago(7 * 24 * 60), includeMatchTime: true }),
    await loadWeekChat({ orgId: ORG, channel: "hq", since: ago(7 * 24 * 60), includeMatchTime: true }),
    await loadWeekChat({ orgId: ORG, channel: "group", since: ago(7 * 24 * 60), includeMatchTime: false }),
    await playersWeekChat({ orgId: ORG, groupId: G, now: NOW, batch: [] }),
    await hqWeekChat({ orgId: ORG, now: NOW, messageId: "none" }),
    await loadStoredGroupLines({ orgId: ORG, groupId: G, exclude: [] }),
    await hqLogSince(ORG, ago(24 * 60)),
    await groupLogSince(ORG, ago(24 * 60)),
    await loadSquadSourceMessages(ORG, ago(24 * 60)),
  ];
  return JSON.stringify(shown);
}

describe("before anything changes, every reader shows the message (the test can see it)", () => {
  it("the secret is in every reader's output", async () => {
    const all = await everythingShown();
    expect(all.split(SECRET).length - 1).toBeGreaterThanOrEqual(9);
  });
});

describe("after a delete for everyone", () => {
  it("no reader shows the deleted text; the other lines are untouched", async () => {
    await applyMessageChange({ kind: "revoke", chatId: G, messageId: "SAMMSG000001", ...BY_SAM });
    await applyMessageChange({ kind: "revoke", chatId: HQ, messageId: "SAMHQ0000001", ...BY_SAM });
    const all = await everythingShown();
    expect(all).not.toContain("4321");
    expect(all).toContain(KEEP);
  });

  it("the players' group's week keeps Ali's line and no blank line where Sam's was", async () => {
    await applyMessageChange({ kind: "revoke", chatId: G, messageId: "SAMMSG000001", ...BY_SAM });
    const lines = await playersWeekChat({ orgId: ORG, groupId: G, now: NOW, batch: [] });
    expect(lines.map((l) => l.body)).toEqual([KEEP]);
    const stored = await loadStoredGroupLines({ orgId: ORG, groupId: G, exclude: [] });
    expect(stored.map((l) => l.body)).toEqual([KEEP]);
    const archive = await loadSquadSourceMessages(ORG, ago(24 * 60));
    expect(archive.map((m) => m.body)).toEqual([KEEP]);
  });

  it("HQ's week and log no longer have the message at all", async () => {
    await applyMessageChange({ kind: "revoke", chatId: HQ, messageId: "SAMHQ0000001", ...BY_SAM });
    expect((await hqWeekChat({ orgId: ORG, now: NOW, messageId: "none" })).map((l) => l.body)).toEqual([KEEP]);
    expect((await hqLogSince(ORG, ago(24 * 60))).map((r) => r.text)).toEqual([KEEP]);
  });
});

describe("after an edit by its author (a purge)", () => {
  it("no reader shows the original words, and no new words were stored", async () => {
    const edit = { kind: "edit" as const, byAdmin: false, senderJids: [`${SAM}@c.us`], senderPhone: SAM };
    await applyMessageChange({ ...edit, chatId: G, messageId: "SAMMSG000001" });
    await applyMessageChange({ ...edit, chatId: HQ, messageId: "SAMHQ0000001" });
    const all = await everythingShown();
    expect(all).not.toContain("4321");
    expect(all).toContain(KEEP);
  });
});

describe("what a delete or an edit leaves for the follow-ups", () => {
  const RECRUIT = { v: 1, extractions: [{ extractor: "admin", facts: { kind: "admin", action: "recruit", pool: true } }] };

  it("a deleted stats question leaves no open 'who do you mean?' with an empty question", async () => {
    T.analyzedMessage.push(
      row({ waMessageId: gid("SAMQ00000001", SAM), orgId: ORG, groupId: G, authorUserId: "u-sam", authorPhone: SAM, authorName: "Sam", body: "how many goals has he scored?", intent: STATS_CLARIFICATION_INTENT, handledBy: "engine", createdAt: new Date(Date.now() - 5 * 60 * 1000) }),
    );
    expect(await loadOpenStatsClarifications(ORG)).toHaveLength(1);
    await applyMessageChange({ kind: "revoke", chatId: G, messageId: "SAMQ00000001", ...BY_SAM });
    expect(await loadOpenStatsClarifications(ORG)).toEqual([]);
  });

  it("the refused-ask retry cannot repeat a request that was DELETED", async () => {
    const at = new Date(Date.now() - 60 * 1000);
    T.analyzedMessage.push(
      row({ waMessageId: gid("SAMASK000001", SAM), orgId: ORG, groupId: G, authorPhone: SAM, body: "@Match Time find us a player", pipelineTrace: RECRUIT, handledBy: "engine", createdAt: at }),
    );
    T.adminGroupMessage.push(
      row({ waMessageId: gid("SAMASKHQ0001", SAM, HQ), orgId: ORG, fromMatchTime: false, text: "@Match Time find us a player", pipelineTrace: RECRUIT, hqOutcome: "refused", createdAt: at }),
    );
    expect(await latestAskFromRecords({ orgId: ORG, where: "group", now: new Date() })).not.toBeNull();
    expect(await latestAskFromRecords({ orgId: ORG, where: "hq", now: new Date() })).not.toBeNull();
    await applyMessageChange({ kind: "revoke", chatId: G, messageId: "SAMASK000001", ...BY_SAM });
    await applyMessageChange({ kind: "revoke", chatId: HQ, messageId: "SAMASKHQ0001", ...BY_SAM });
    expect(await latestAskFromRecords({ orgId: ORG, where: "group", now: new Date() })).toBeNull();
    expect(await latestAskFromRecords({ orgId: ORG, where: "hq", now: new Date() })).toBeNull();
  });
});

// ── Round 8: an edit purges the TEXT and keeps the FACTS ─────────────────
describe("an author's edit: MatchTime forgets the words and otherwise behaves as today (the reviewers' probes)", () => {
  const EDIT_BY_SAM = { kind: "edit" as const, ...BY_SAM };
  const RECRUIT = { v: 1, extractions: [{ extractor: "admin", facts: { kind: "admin", action: "recruit", pool: true } }] };

  it("'try again' still repeats an EDITED ask, in the players' group and in HQ", async () => {
    const at = new Date(Date.now() - 60 * 1000);
    T.analyzedMessage.push(
      row({ waMessageId: gid("SAMASK000002", SAM), orgId: ORG, groupId: G, authorPhone: SAM, body: "@Match Time find us a player", pipelineTrace: RECRUIT, handledBy: "engine", createdAt: at }),
    );
    T.adminGroupMessage.push(
      row({ waMessageId: gid("SAMASKHQ0002", SAM, HQ), orgId: ORG, fromMatchTime: false, text: "@Match Time find us a player", pipelineTrace: RECRUIT, hqOutcome: "refused", createdAt: at }),
    );
    await applyMessageChange({ ...EDIT_BY_SAM, chatId: G, messageId: "SAMASK000002" });
    await applyMessageChange({ ...EDIT_BY_SAM, chatId: HQ, messageId: "SAMASKHQ0002" });
    expect(await latestAskFromRecords({ orgId: ORG, where: "group", now: new Date() })).toMatchObject({ facts: { action: "recruit", pool: true } });
    expect(await latestAskFromRecords({ orgId: ORG, where: "hq", now: new Date() })).toMatchObject({ facts: { action: "recruit", pool: true } });
    expect(JSON.stringify([T.analyzedMessage, T.adminGroupMessage])).not.toContain("find us a player");
  });

  it("the 'who do you mean?' is KEPT open with its question (the 'Idirs' case), then the question goes once its hour is up", async () => {
    const Q = "@Match Time how many goals has Idirs scored?";
    T.analyzedMessage.push(
      row({ waMessageId: gid("SAMQ00000002", SAM), orgId: ORG, groupId: G, authorUserId: "u-sam", authorPhone: SAM, authorName: "Sam", body: Q, intent: STATS_CLARIFICATION_INTENT, handledBy: "engine", createdAt: new Date(Date.now() - 5 * 60 * 1000) }),
    );
    await applyMessageChange({ ...EDIT_BY_SAM, chatId: G, messageId: "SAMQ00000002" });
    // Only the clarification can still read the question: no reader of the chat shows it.
    expect(T.analyzedMessage.find((r) => r.waMessageId === gid("SAMQ00000002", SAM))!.body).toBeNull();
    expect(await everythingShown()).not.toContain("Idirs");
    const open = await loadOpenStatsClarifications(ORG);
    expect(open).toHaveLength(1);
    expect(open[0].questionBody).toBe(Q);
    // The hour is up: the sweep takes the held question out.
    const later = new Date(Date.now() + 61 * 60 * 1000);
    await sweepRecentTombstones(later);
    expect(JSON.stringify(T.analyzedMessage)).not.toContain("Idirs");
    expect(await loadOpenStatsClarifications(ORG, later)).toEqual([]);
  });

  it("a clarification row written LONG after its edit's tombstone was enforced: kept due, so the sweep still drops the held question after its hour", async () => {
    const Q = "@Match Time how many goals has Idirs scored?";
    const id = gid("SAMQ00000003", SAM);
    await applyMessageChange({ ...EDIT_BY_SAM, chatId: G, messageId: "SAMQ00000003" }, new Date(Date.now() - 8 * 60 * 60 * 1000));
    // The question is written now (a catch-up), and its own clear-after-write runs.
    T.analyzedMessage.push(row({ waMessageId: id, orgId: ORG, groupId: G, authorUserId: "u-sam", authorPhone: SAM, authorName: "Sam", body: Q, intent: STATS_CLARIFICATION_INTENT, handledBy: "engine", createdAt: new Date() }));
    await enforceDeletes(G, [id]);
    expect(T.deletedMessage.find((t) => t.waMessageId === "SAMQ00000003")!.enforcedAt).toBeNull();
    await sweepRecentTombstones(new Date(Date.now() + 61 * 60 * 1000));
    expect(JSON.stringify(T.analyzedMessage)).not.toContain("Idirs");
  });

  it("a held question read after its hour is up is dropped then and there", async () => {
    const id = gid("SAMQ00000004", SAM);
    T.analyzedMessage.push(
      row({ waMessageId: id, orgId: ORG, groupId: G, authorUserId: "u-sam", authorName: "Sam", body: null, intent: STATS_CLARIFICATION_INTENT, handledBy: "engine", createdAt: new Date(Date.now() - 50 * 60 * 1000), pipelineTrace: { v: 1, extractions: [], heldQuestion: { text: "Idirs?", until: new Date(Date.now() - 60 * 1000).toISOString() } } }),
    );
    expect(await loadOpenStatsClarifications(ORG)).toEqual([]);
    // Where the analyze route reads them: dropped there and then.
    expect(await dropExpiredHeldQuestions(ORG)).toBe(1);
    expect(JSON.stringify(T.analyzedMessage)).not.toContain("Idirs");
  });

  it("'DM the people above' still picks the person the EDITED message tagged, never an older message's", async () => {
    T.messageMentions.push(
      row({ waMessageId: gid("ALITAG000001", ALI), orgId: ORG, chatId: G, senderUserId: "u-ali", mentions: [{ phone: "447700900777", name: "Wrong Person" }], unidentified: 0, sentAt: ago(10), createdAt: ago(10) }),
      row({ waMessageId: gid("SAMTAG000001", SAM), orgId: ORG, chatId: G, senderUserId: "u-sam", mentions: [{ phone: "447700900888", name: "Right Person" }], unidentified: 0, sentAt: ago(5), createdAt: ago(5) }),
    );
    await applyMessageChange({ ...EDIT_BY_SAM, chatId: G, messageId: "SAMTAG000001" });
    const above = await mentionsAbove({ orgId: ORG, chatId: G, before: ago(1), excludeWaMessageIds: [] });
    expect(above?.sentAt).toEqual(ago(5));
  });

  it("HQ: an organiser's 'hold on', EDITED, still counts as somebody speaking: a bare YES then asks 'Is that YES to...?'", async () => {
    T.adminGroupMessage.push(
      row({ waMessageId: "mt:list:hold", orgId: ORG, fromMatchTime: true, askRef: "list:paste-1", text: "Adding: Zara. Say YES to apply.", createdAt: ago(4) }),
      row({ waMessageId: gid("SAMHOLD00001", SAM, HQ), orgId: ORG, fromMatchTime: false, senderUserId: "u-sam", text: "hold on, Zara can't make it", createdAt: ago(3) }),
    );
    await applyMessageChange({ ...EDIT_BY_SAM, chatId: HQ, messageId: "SAMHOLD00001" });
    const log = await hqLogSince(ORG, ago(24 * 60));
    expect(log.find((r) => r.waMessageId === gid("SAMHOLD00001", SAM, HQ))).toMatchObject({ text: "", senderUserId: "u-sam" });
    const pending = [{ ref: "list:paste-1", askedAt: ago(4) }] as unknown as Parameters<typeof decideApproval>[0]["pending"];
    expect(decideApproval({ pending, quoted: null, log, now: NOW }).kind).not.toBe("approve");
    // No blank line is shown to a model where the words were.
    expect((await hqWeekChat({ orgId: ORG, now: NOW, messageId: "none" })).map((l) => l.body)).not.toContain("");
  });

  it("no model reader of HQ is shown a blank line: the HQ squad reader and the pick reader leave out an edited line and MatchTime's cleared question", async () => {
    T.adminGroupMessage.push(
      row({ waMessageId: "mt:list:cleared", orgId: ORG, fromMatchTime: true, askRef: "list:x", text: "Adding: Zara. Say YES", createdAt: ago(4) }),
      row({ waMessageId: gid("SAMHQ0000009", SAM, HQ), orgId: ORG, fromMatchTime: false, senderUserId: "u-sam", text: "hold on", createdAt: ago(3) }),
    );
    await applyMessageChange({ ...EDIT_BY_SAM, chatId: HQ, messageId: "SAMHQ0000009" });
    T.adminGroupMessage.find((r) => r.waMessageId === "mt:list:cleared")!.text = ""; // a delete cleared MatchTime's question
    const squad = await loadHqRecentMessages(ORG, "none", NOW);
    const pick = await recentHqMessages(ORG, "u-ali", "1", NOW, []);
    for (const lines of [squad, pick]) {
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.map((l) => l.body.trim()).filter((b) => b === "")).toEqual([]);
    }
  });

  it("the players' group: an organiser line EDITED after 'who shall I ask?' still counts, so the next line is not read as the answer", async () => {
    T.adminGroupMessage.push(
      row({ waMessageId: "mt:group:ask-source:pool+partners:1", orgId: ORG, fromMatchTime: true, askRef: "ask-source:pool+partners", text: "Who shall I ask?", createdAt: ago(4) }),
      row({ waMessageId: `group:${gid("SAMTALK00001", SAM)}`, orgId: ORG, fromMatchTime: false, senderUserId: "u-sam", text: "anyone got bibs?", createdAt: ago(3) }),
    );
    const before = sourceQuestionAnswered({ quoted: null, log: await groupLogSince(ORG, ago(24 * 60)), now: NOW });
    await applyMessageChange({ ...EDIT_BY_SAM, chatId: G, messageId: "SAMTALK00001" });
    const after = sourceQuestionAnswered({ quoted: null, log: await groupLogSince(ORG, ago(24 * 60)), now: NOW });
    expect(before).toBeNull();
    expect(after).toBeNull();
    expect(JSON.stringify(T.adminGroupMessage)).not.toContain("bibs");
  });
});

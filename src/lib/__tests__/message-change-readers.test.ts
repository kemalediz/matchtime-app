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

const NAMES = ["analyzedMessage", "groupMessage", "adminGroupMessage", "messageMentions", "deletedMessage", "sentNotification", "botJob", "user", "membership", "userAlias", "organisation"];
const T: Record<string, Row[]> = {};
const fake = makeDb(T, NAMES, { deletedMessage: [["chatId", "waMessageId"]] });
vi.mock("@/lib/db", () => ({
  get db() {
    return fake.db;
  },
}));

import { applyMessageChange } from "../message-change";
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

  it("the refused-ask retry cannot repeat a request that was deleted, or edited away", async () => {
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
    await applyMessageChange({ kind: "edit", chatId: HQ, messageId: "SAMASKHQ0001", byAdmin: false, senderJids: [`${SAM}@c.us`], senderPhone: SAM });
    expect(await latestAskFromRecords({ orgId: ORG, where: "group", now: new Date() })).toBeNull();
    expect(await latestAskFromRecords({ orgId: ORG, where: "hq", now: new Date() })).toBeNull();
  });
});

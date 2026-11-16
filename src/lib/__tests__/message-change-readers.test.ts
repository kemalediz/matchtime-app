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
import { makeTable, row, type Row } from "./fake-message-db";

const T: Record<string, Row[]> = {};
const tables = () => ({
  analyzedMessage: makeTable((T.analyzedMessage ??= [])),
  groupMessage: makeTable((T.groupMessage ??= [])),
  adminGroupMessage: makeTable((T.adminGroupMessage ??= [])),
  messageMentions: makeTable((T.messageMentions ??= [])),
  sentNotification: makeTable((T.sentNotification ??= [])),
  botJob: makeTable((T.botJob ??= [])),
  user: makeTable((T.user ??= [])),
});
vi.mock("@/lib/db", () => ({
  get db() {
    return tables();
  },
}));

import { applyMessageChange } from "../message-change";
import { hqWeekChat, loadWeekChat, playersWeekChat } from "../week-chat";
import { loadStoredGroupLines } from "../group-chat-history";
import { groupLogSince, hqLogSince } from "../admin-group-log";
import { loadSquadSourceMessages } from "../squad-from-list";

const NOW = new Date("2026-11-15T18:00:00.000Z");
const ago = (m: number) => new Date(NOW.getTime() - m * 60 * 1000);
const ORG = "org-a";
const G = "120363000000000111@g.us";
const HQ = "120363000000000999@g.us";
const SAM = "447700900123";
const ALI = "447700900456";
const SECRET = "my door code is 4321";
const KEEP = "see you all at 8";

const gid = (bare: string, phone: string, chat = G) => `false_${chat}_${bare}_${phone}@c.us`;

beforeEach(() => {
  for (const k of ['analyzedMessage', 'groupMessage', 'adminGroupMessage', 'messageMentions', 'sentNotification', 'botJob', 'user']) T[k] = [];
  T.user.push({ id: "u-sam", name: "Sam Sample" }, { id: "u-ali", name: "Ali Example" });
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
    await applyMessageChange({ kind: "revoke", chatId: G, messageId: "SAMMSG000001" });
    await applyMessageChange({ kind: "revoke", chatId: HQ, messageId: "SAMHQ0000001" });
    const all = await everythingShown();
    expect(all).not.toContain("4321");
    expect(all).toContain(KEEP);
  });

  it("the players' group's week keeps Ali's line and no blank line where Sam's was", async () => {
    await applyMessageChange({ kind: "revoke", chatId: G, messageId: "SAMMSG000001" });
    const lines = await playersWeekChat({ orgId: ORG, groupId: G, now: NOW, batch: [] });
    expect(lines.map((l) => l.body)).toEqual([KEEP]);
    const stored = await loadStoredGroupLines({ orgId: ORG, groupId: G, exclude: [] });
    expect(stored.map((l) => l.body)).toEqual([KEEP]);
    const archive = await loadSquadSourceMessages(ORG, ago(24 * 60));
    expect(archive.map((m) => m.body)).toEqual([KEEP]);
  });

  it("HQ's week and log no longer have the message at all", async () => {
    await applyMessageChange({ kind: "revoke", chatId: HQ, messageId: "SAMHQ0000001" });
    expect((await hqWeekChat({ orgId: ORG, now: NOW, messageId: "none" })).map((l) => l.body)).toEqual([KEEP]);
    expect((await hqLogSince(ORG, ago(24 * 60))).map((r) => r.text)).toEqual([KEEP]);
  });
});

describe("after an edit", () => {
  it("every reader shows the edited text and never the original", async () => {
    const edit = { kind: "edit" as const, text: "running 10 mins late", senderJids: [`${SAM}@c.us`], senderPhone: SAM };
    await applyMessageChange({ ...edit, chatId: G, messageId: "SAMMSG000001" });
    await applyMessageChange({ ...edit, chatId: HQ, messageId: "SAMHQ0000001" });
    const all = await everythingShown();
    expect(all).not.toContain("4321");
    expect(all.split("running 10 mins late").length - 1).toBeGreaterThanOrEqual(9);
  });
});

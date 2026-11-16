/**
 * What the Pi does with a delete for everyone or an edit (2026-11-15,
 * `message-change.ts`): housekeeping only. It takes the words out of what
 * the Pi itself still holds, waits for a running analysis of that group to
 * finish (so the server has stored what it is about to change), and posts
 * the change. It never sends, replies or reacts: the only effects it has
 * are the ones injected here. Simulated numbers, made-up people.
 */
import { describe, it, expect, vi } from "vitest";
import type { MessageChangeEvent } from "./driver.js";
import { editIsByAuthor, handleMessageChange, isIdOfMessage, type MessageChangeDeps } from "./message-change.js";

const GROUP = "120363000000000000@g.us";
const TARGET = "3EB0AAAABBBBCCCC0001";
const SAM = "447700900123";
const SAM_LID = "158055467598020@lid";
const SAM_ID = `false_${GROUP}_${TARGET}_${SAM}@c.us`;

const revoke = (over: Partial<MessageChangeEvent> = {}): MessageChangeEvent => ({
  kind: "revoke",
  chatId: GROUP,
  isGroup: true,
  messageId: TARGET,
  senderJids: [`${SAM}@c.us`],
  senderPhone: SAM,
  fromMe: false,
  ...over,
});

function deps(over: Partial<MessageChangeDeps> = {}) {
  const order: string[] = [];
  const logs: string[] = [];
  const d: MessageChangeDeps = {
    isTrackedGroup: () => true,
    applyLocally: vi.fn(() => {
      order.push("local");
      return { buffered: 1, history: 1 };
    }),
    whenFlushIdle: vi.fn(async () => {
      order.push("idle");
      return true;
    }),
    post: vi.fn(async () => {
      order.push("post");
      return { ok: true, analyzed: 1, archived: 0, hq: 0, mentions: 0, editsRefused: 0 };
    }),
    log: (l) => logs.push(l),
    error: (l) => logs.push(`ERR ${l}`),
    ...over,
  };
  return { d, order, logs };
}

describe("isIdOfMessage / editIsByAuthor (the Pi's own copies, by id and group)", () => {
  it("a stored id names this group's message, never another group's or a longer id", () => {
    expect(isIdOfMessage(SAM_ID, GROUP, TARGET)).toBe(true);
    expect(isIdOfMessage(`false_${GROUP}_${TARGET}_${SAM_LID}`, GROUP, TARGET)).toBe(true);
    expect(isIdOfMessage(`false_120363000000000001@g.us_${TARGET}_${SAM}@c.us`, GROUP, TARGET)).toBe(false);
    expect(isIdOfMessage(`false_${GROUP}_${TARGET}X_${SAM}@c.us`, GROUP, TARGET)).toBe(false);
    expect(isIdOfMessage("synthetic:abc", GROUP, TARGET)).toBe(false);
  });

  it("an edit is the author's when the stored participant or phone is the sender's", () => {
    expect(editIsByAuthor(SAM_ID, null, { senderJids: [`${SAM}@c.us`], senderPhone: null })).toBe(true);
    expect(editIsByAuthor(`false_${GROUP}_${TARGET}_${SAM_LID}`, SAM, { senderJids: [], senderPhone: SAM })).toBe(true);
    expect(editIsByAuthor(SAM_ID, SAM, { senderJids: ["447700900999@c.us"], senderPhone: "447700900999" })).toBe(false);
  });
});

describe("handleMessageChange", () => {
  it("a group delete: the Pi's copies first, then waits for a running flush, then posts by id and group", async () => {
    const { d, order, logs } = deps();
    expect(await handleMessageChange(revoke(), d)).toBe("posted");
    expect(order).toEqual(["local", "idle", "post"]);
    expect(d.whenFlushIdle).toHaveBeenCalledWith(GROUP);
    expect(d.post).toHaveBeenCalledWith({ kind: "revoke", chatId: GROUP, messageId: TARGET });
    expect(logs.join("\n")).toMatch(/delete for everyone of 3EB0AAAABBBBCCCC0001 .*analyzed=1/);
  });

  it("an edit posts its text and sender, and the log never carries the text", async () => {
    const { d, logs } = deps();
    const change = revoke({ kind: "edit", text: "my private new words", senderJids: [SAM_LID, `${SAM}@c.us`] });
    expect(await handleMessageChange(change, d)).toBe("posted");
    expect(d.post).toHaveBeenCalledWith({
      kind: "edit",
      chatId: GROUP,
      messageId: TARGET,
      text: "my private new words",
      senderJids: [SAM_LID, `${SAM}@c.us`],
      senderPhone: SAM,
    });
    expect(logs.join("\n")).not.toContain("private");
  });

  it("a DM: nothing the server keeps for a later answer, so nothing is posted", async () => {
    const { d, logs } = deps();
    expect(await handleMessageChange(revoke({ isGroup: false, chatId: `${SAM}@c.us` }), d)).toBe("dm");
    expect(d.applyLocally).not.toHaveBeenCalled();
    expect(d.post).not.toHaveBeenCalled();
    expect(logs.join("\n")).toMatch(/DM/);
  });

  it("a group MatchTime does not read: nothing stored, nothing posted", async () => {
    const { d } = deps({ isTrackedGroup: () => false });
    expect(await handleMessageChange(revoke(), d)).toBe("untracked");
    expect(d.post).not.toHaveBeenCalled();
  });

  it("a failed or refused post is logged and never throws", async () => {
    const { d, logs } = deps({ post: vi.fn(async () => null) });
    expect(await handleMessageChange(revoke(), d)).toBe("failed");
    expect(logs.join("\n")).toMatch(/ERR .*not applied/);
    const { d: d2 } = deps({ post: vi.fn(async () => Promise.reject(new Error("boom"))) });
    await expect(handleMessageChange(revoke(), d2)).resolves.toBe("failed");
  });

  it("a flush that never ends does not hold the delete back for ever", async () => {
    const { d, logs } = deps({ whenFlushIdle: vi.fn(async () => false) });
    expect(await handleMessageChange(revoke(), d)).toBe("posted");
    expect(logs.join("\n")).toMatch(/still running/);
  });
});

/**
 * What the Pi does with a delete for everyone or an edit (2026-11-15,
 * `message-change.ts`, round 2): housekeeping only.
 *
 *   1. the Pi's own record and copies FIRST, for every group, whether or
 *      not the org list has loaded yet (after a restart it may not have);
 *   2. the change into the durable outbox, before any post;
 *   3. a running analysis of that group allowed to end (bounded);
 *   4. one post; a failure is left to the outbox's retries.
 *
 * It never sends, replies or reacts: its only effects are the injected
 * ones. Simulated numbers, made-up people.
 */
import { describe, it, expect, vi } from "vitest";
import type { MessageChangeEvent } from "./driver.js";
import {
  bareOf,
  bodyForServer,
  deleteApplies,
  handleMessageChange,
  isByAuthor,
  isIdOfMessage,
  namesMessage,
  type LocalMessageChange,
  type MessageChangeDeps,
} from "./message-change.js";
import { createMessageChangeOutbox } from "./message-change-outbox.js";

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
  byAdmin: false,
  fromMe: false,
  ...over,
});

function deps(over: Partial<MessageChangeDeps> = {}) {
  const order: string[] = [];
  const logs: string[] = [];
  const recorded: LocalMessageChange[] = [];
  const d: MessageChangeDeps = {
    applyLocally: vi.fn((c: LocalMessageChange) => {
      order.push(`local:${c.kind}`);
      return { buffered: 1, history: 1, quotes: 0 };
    }),
    record: vi.fn((c: LocalMessageChange) => {
      order.push("record");
      recorded.push(c);
      return "key-1";
    }),
    update: vi.fn((key: string, c: LocalMessageChange) => {
      order.push(`update:${key}:${c.byAdmin}${c.adminUnknown ? ":unknown" : ""}`);
    }),
    attempt: vi.fn(async () => {
      order.push("post");
      return true;
    }),
    whenFlushIdle: vi.fn(async () => {
      order.push("idle");
      return true;
    }),
    phoneForLid: vi.fn(async () => null),
    log: (l) => logs.push(l),
    error: (l) => logs.push(`ERR ${l}`),
    ...over,
  };
  return { d, order, logs, recorded };
}

describe("the Pi's own copies, by id and group, never by text", () => {
  it("isIdOfMessage / namesMessage / bareOf", () => {
    expect(isIdOfMessage(SAM_ID, GROUP, TARGET)).toBe(true);
    expect(isIdOfMessage(`false_${GROUP}_${TARGET}_${SAM_LID}`, GROUP, TARGET)).toBe(true);
    expect(isIdOfMessage(`false_120363000000000001@g.us_${TARGET}_${SAM}@c.us`, GROUP, TARGET)).toBe(false);
    expect(isIdOfMessage(`false_${GROUP}_${TARGET}X_${SAM}@c.us`, GROUP, TARGET)).toBe(false);
    expect(namesMessage(TARGET, GROUP, TARGET)).toBe(true);
    expect(namesMessage("synthetic:abc", GROUP, TARGET)).toBe(false);
    expect(bareOf(SAM_ID)).toBe(TARGET);
    expect(bareOf(TARGET)).toBe(TARGET);
    expect(bareOf("synthetic:abc")).toBeNull();
  });

  it("isByAuthor: the stored participant or phone is the sender's", () => {
    expect(isByAuthor(SAM_ID, null, { senderJids: [`${SAM}@c.us`], senderPhone: null })).toBe(true);
    expect(isByAuthor(`false_${GROUP}_${TARGET}_${SAM_LID}`, SAM, { senderJids: [], senderPhone: SAM })).toBe(true);
    expect(isByAuthor(SAM_ID, SAM, { senderJids: ["447700900999@c.us"], senderPhone: "447700900999" })).toBe(false);
  });

  it("deleteApplies: a group admin's delete always, anyone else's only their own", () => {
    const by = (who: string, byAdmin = false) => ({ kind: "revoke" as const, groupId: GROUP, messageId: TARGET, senderJids: [`${who}@c.us`], senderPhone: who, byAdmin });
    expect(deleteApplies(by(SAM), SAM_ID, SAM)).toBe(true);
    expect(deleteApplies(by("447700900999", true), SAM_ID, SAM)).toBe(true);
    expect(deleteApplies(by("447700900999"), SAM_ID, SAM)).toBe(false);
  });

  it("bodyForServer: a delete by ids, sender and admin flag; an edit by ids and sender, never words", () => {
    expect(bodyForServer({ kind: "revoke", groupId: GROUP, messageId: TARGET, senderJids: [`${SAM}@c.us`], senderPhone: SAM, byAdmin: true })).toEqual({
      kind: "revoke",
      chatId: GROUP,
      messageId: TARGET,
      byAdmin: true,
      senderJids: [`${SAM}@c.us`],
      senderPhone: SAM,
    });
    expect(bodyForServer({ kind: "edit", groupId: GROUP, messageId: TARGET, senderJids: [], senderPhone: SAM, byAdmin: false })).toEqual({
      kind: "edit",
      chatId: GROUP,
      messageId: TARGET,
      senderJids: [],
      senderPhone: SAM,
    });
  });
});

describe("handleMessageChange", () => {
  it("a group delete: the Pi's own record first, then the outbox, then waits for a running flush, then one post", async () => {
    const { d, order, logs, recorded } = deps();
    expect(await handleMessageChange(revoke(), d)).toBe("posted");
    expect(order).toEqual(["local:revoke", "record", "idle", "post"]);
    expect(recorded[0]).toEqual({ kind: "revoke", groupId: GROUP, messageId: TARGET, senderJids: [`${SAM}@c.us`], senderPhone: SAM, byAdmin: false });
    expect(d.attempt).toHaveBeenCalledWith("key-1");
    expect(logs.join("\n")).toMatch(/delete for everyone of 3EB0AAAABBBBCCCC0001 .*batch=1/);
  });

  it("there is no 'not a group MatchTime reads' early return: a group the org list has not loaded yet is recorded and posted too", async () => {
    const { d } = deps();
    expect(await handleMessageChange(revoke({ chatId: "120363000000009999@g.us" }), d)).toBe("posted");
    expect(d.applyLocally).toHaveBeenCalled();
    expect(d.record).toHaveBeenCalled();
  });

  it("an author's edit: recorded and posted (ids only), exactly as a delete is; nothing is read, replaced, held or flushed", async () => {
    const { d, order, recorded } = deps();
    expect(await handleMessageChange(revoke({ kind: "edit", byAdmin: true }), d)).toBe("posted");
    expect(order).toEqual(["local:edit", "record", "idle", "post"]);
    expect(recorded[0]).toEqual({ kind: "edit", groupId: GROUP, messageId: TARGET, senderJids: [`${SAM}@c.us`], senderPhone: SAM, byAdmin: false });
    expect(Object.keys(d).sort()).toEqual(["applyLocally", "attempt", "error", "log", "phoneForLid", "record", "update", "whenFlushIdle"]);
    expect(d.update).not.toHaveBeenCalled();
  });

  it("an edit notice with only a LID: recorded and in the outbox BEFORE the LID lookup, then widened through the Pi's LID map and the entry updated", async () => {
    let answer!: (v: string | null) => void;
    const phoneForLid = vi.fn(() => new Promise<string | null>((r) => (answer = r)));
    const { d, order, recorded } = deps({ phoneForLid });
    const running = handleMessageChange(revoke({ kind: "edit", senderJids: [SAM_LID], senderPhone: null }), d);
    await vi.waitFor(() => expect(phoneForLid).toHaveBeenCalledWith(SAM_LID));
    // A crash now loses nothing: both written as the notice named the sender.
    expect(order).toEqual(["local:edit", "record"]);
    expect(recorded[0]).toMatchObject({ senderPhone: null, senderJids: [SAM_LID] });
    answer(SAM);
    expect(await running).toBe("posted");
    expect(order).toEqual(["local:edit", "record", "local:edit", "update:key-1:false", "idle", "post"]);
    const widened = (d.update as ReturnType<typeof vi.fn>).mock.calls[0][1] as LocalMessageChange;
    expect(widened).toMatchObject({ senderPhone: SAM, senderJids: [SAM_LID, `${SAM}@c.us`] });
    expect(isByAuthor(SAM_ID, null, widened)).toBe(true);
  });

  it("the server ACCEPTED it and only the admin check is open: said at info level, never as 'not taken'", async () => {
    const { d, logs } = deps({ attempt: vi.fn(async () => "accepted" as const) });
    expect(await handleMessageChange(revoke({ adminUnknown: true }), d)).toBe("posted");
    expect(logs.some((l) => l.startsWith("ERR"))).toBe(false);
    expect(logs.join("\n")).toMatch(/taken by the server; whether the sender is a group admin is checked again/);
  });

  it("a delete whose admin status could not be read is recorded as such, for the outbox to check again", async () => {
    const { d, recorded } = deps();
    await handleMessageChange(revoke({ adminUnknown: true }), d);
    expect(recorded[0]).toMatchObject({ kind: "revoke", byAdmin: false, adminUnknown: true });
    const nulled = deps({ isGroupAdmin: vi.fn(async () => null) });
    await handleMessageChange(revoke({ adminUnknown: true }), nulled.d);
    expect(nulled.recorded[0]).toMatchObject({ byAdmin: false, adminUnknown: true });
  });

  it("the admin check runs HERE, off the driver's queue, and DURABILITY FIRST: the Pi's own record and the outbox (admin unknown) before the roster read, then the outbox entry is settled", async () => {
    let answer!: (v: boolean | null) => void;
    const isGroupAdmin = vi.fn(() => new Promise<boolean | null>((r) => (answer = r)));
    const { d, order, recorded } = deps({ isGroupAdmin });
    const running = handleMessageChange(revoke({ adminUnknown: true }), d);
    await vi.waitFor(() => expect(isGroupAdmin).toHaveBeenCalledWith(GROUP, [`${SAM}@c.us`]));
    // Both written before the read: a crash now loses nothing.
    expect(order).toEqual(["local:revoke", "record"]);
    expect(recorded[0]).toMatchObject({ kind: "revoke", byAdmin: false, adminUnknown: true });
    answer(true);
    expect(await running).toBe("posted");
    expect(order).toEqual(["local:revoke", "record", "local:revoke", "update:key-1:true", "idle", "post"]);
    // Not an admin: settled as known; a read that throws leaves it unknown, for the outbox's re-check.
    const no = deps({ isGroupAdmin: vi.fn(async () => false) });
    await handleMessageChange(revoke({ adminUnknown: true }), no.d);
    expect(no.order).toEqual(["local:revoke", "record", "update:key-1:false", "idle", "post"]);
    const boom = deps({ isGroupAdmin: vi.fn(async () => Promise.reject(new Error("rate-overlimit"))) });
    await handleMessageChange(revoke({ adminUnknown: true }), boom.d);
    expect(boom.recorded[0]).toMatchObject({ byAdmin: false, adminUnknown: true });
    expect(boom.d.update).not.toHaveBeenCalled();
    // An edit never asks: only its author may edit.
    const ed = deps({ isGroupAdmin: vi.fn(async () => true) });
    await handleMessageChange(revoke({ kind: "edit" }), ed.d);
    expect(ed.d.isGroupAdmin).not.toHaveBeenCalled();
  });

  it("a crash between the outbox write and the roster read: after the restart the change is still posted, its admin status re-checked", async () => {
    const file = { saved: null as unknown, load: () => (file.saved === null ? null : JSON.parse(JSON.stringify(file.saved))), save: (v: unknown) => (file.saved = JSON.parse(JSON.stringify(v))) };
    const posted: LocalMessageChange[] = [];
    const before = createMessageChangeOutbox({ io: file, now: () => 1_763_200_000_000, post: async () => true, log: () => {}, error: () => {} });
    // The roster read never answers: the process dies there.
    const dying = handleMessageChange(revoke({ adminUnknown: true }), {
      applyLocally: () => ({ buffered: 0, history: 0, quotes: 0 }),
      record: (c) => before.record(c),
      update: (k, c) => before.update(k, c),
      isGroupAdmin: () => new Promise<boolean | null>(() => {}),
      attempt: (k) => before.attempt(k),
      whenFlushIdle: async () => true,
      log: () => {},
      error: () => {},
    });
    void dying;
    await vi.waitFor(() => expect(JSON.stringify(file.saved)).toContain(TARGET));
    // The restart: a new outbox over the same file, with the re-check wired.
    const after = createMessageChangeOutbox({
      io: file,
      now: () => 1_763_200_060_000,
      post: async (c) => {
        posted.push(c);
        return true;
      },
      recheckAdmin: async () => true,
      log: () => {},
      error: () => {},
    });
    expect(after.load()).toEqual([expect.objectContaining({ kind: "revoke", messageId: TARGET, adminUnknown: true })]);
    expect(await after.drainDue()).toBe(1);
    expect(posted).toEqual([{ kind: "revoke", groupId: GROUP, messageId: TARGET, senderJids: [`${SAM}@c.us`], senderPhone: SAM, byAdmin: true }]);
  });

  it("a failed post is left to the outbox's retries ('queued'), and never throws", async () => {
    const { d, logs } = deps({ attempt: vi.fn(async () => false) });
    expect(await handleMessageChange(revoke(), d)).toBe("queued");
    expect(logs.join("\n")).toMatch(/queued/);
    const { d: d2 } = deps({ attempt: vi.fn(async () => Promise.reject(new Error("boom"))) });
    await expect(handleMessageChange(revoke(), d2)).resolves.toBe("queued");
  });

  it("a DM: nothing the server keeps for a later answer, so nothing is recorded or posted", async () => {
    const { d, logs } = deps();
    expect(await handleMessageChange(revoke({ isGroup: false, chatId: `${SAM}@c.us` }), d)).toBe("dm");
    expect(d.applyLocally).not.toHaveBeenCalled();
    expect(d.record).not.toHaveBeenCalled();
    expect(logs.join("\n")).toMatch(/DM/);
  });

  it("a flush that never ends does not hold the delete back for ever", async () => {
    const { d, logs } = deps({ whenFlushIdle: vi.fn(async () => false) });
    expect(await handleMessageChange(revoke(), d)).toBe("posted");
    expect(logs.join("\n")).toMatch(/still running/);
  });
});

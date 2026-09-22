/**
 * The bounded store of messages we sent, which Baileys' `getMessage` socket
 * option reads (plan §2.12).
 *
 * Two jobs, both real:
 *   1. When a recipient's phone fails to decrypt one of our messages it
 *      asks for a retry, and Baileys can only re-encrypt a message it can
 *      look up. Without the lookup the player sees "waiting for this
 *      message" forever. HomeTenant keeps 500 for exactly this.
 *   2. A poll vote arrives encrypted, and decrypting it needs the ORIGINAL
 *      poll (its messageSecret). Votes on a Man of the Match poll trickle
 *      in for a day and a half after kickoff, long after 500 ordinary
 *      sends could have pushed it out. So polls are pinned, in their own
 *      bounded pen.
 */
import { describe, it, expect } from "vitest";
import { createSentMessageStore } from "./sent-store.js";

function sent(id: string, text = `msg ${id}`) {
  return {
    key: { remoteJid: "120363000@g.us", fromMe: true, id },
    message: { conversation: text },
  };
}

function poll(id: string) {
  return {
    key: { remoteJid: "120363000@g.us", fromMe: true, id },
    message: {
      messageContextInfo: { messageSecret: new Uint8Array(32) },
      pollCreationMessageV3: { name: "MoM?", options: [{ optionName: "A" }] },
    },
  };
}

describe("createSentMessageStore", () => {
  it("gives back the message we sent, by its key", () => {
    const store = createSentMessageStore();
    store.remember(sent("A"));
    expect(store.get({ id: "A" })).toEqual({ conversation: "msg A" });
  });

  it("answers by id alone, whatever form the asker's remoteJid is in", () => {
    // A retry receipt may name the chat by LID while we sent to the phone
    // JID. Ids are random and unique enough that the id is the key.
    const store = createSentMessageStore();
    store.remember(sent("A"));
    expect(store.get({ remoteJid: "99@lid", id: "A" })).toEqual({ conversation: "msg A" });
  });

  it("returns undefined for what it never saw, and for a key with no id", () => {
    const store = createSentMessageStore();
    expect(store.get({ id: "nope" })).toBeUndefined();
    expect(store.get({})).toBeUndefined();
    expect(store.get(undefined)).toBeUndefined();
  });

  it("ignores a send result with no key id or no message, rather than storing junk", () => {
    const store = createSentMessageStore();
    store.remember(undefined);
    store.remember({ key: { id: "" }, message: { conversation: "x" } });
    store.remember({ key: { id: "B" }, message: null });
    expect(store.size()).toBe(0);
  });

  it("is bounded, and evicts the oldest first", () => {
    const store = createSentMessageStore({ max: 3 });
    for (const id of ["A", "B", "C", "D"]) store.remember(sent(id));
    expect(store.get({ id: "A" })).toBeUndefined();
    expect(store.get({ id: "B" })).toBeDefined();
    expect(store.get({ id: "D" })).toBeDefined();
    expect(store.size()).toBe(3);
  });

  it("defaults to HomeTenant's 500", () => {
    const store = createSentMessageStore();
    for (let i = 0; i < 501; i++) store.remember(sent(`M${i}`));
    expect(store.get({ id: "M0" })).toBeUndefined();
    expect(store.get({ id: "M1" })).toBeDefined();
  });

  it("keeps a pinned poll however many ordinary sends follow it", () => {
    const store = createSentMessageStore<{
      conversation?: string;
      pollCreationMessageV3?: { name?: string };
    }>({ max: 3 });
    store.remember(poll("P1"), { pin: true });
    for (let i = 0; i < 50; i++) store.remember(sent(`M${i}`));
    expect(store.get({ id: "P1" })?.pollCreationMessageV3?.name).toBe("MoM?");
  });

  it("bounds the pinned pen too, so pinning can never become a leak", () => {
    const store = createSentMessageStore({ max: 3, pinnedMax: 2 });
    for (const id of ["P1", "P2", "P3"]) store.remember(poll(id), { pin: true });
    expect(store.get({ id: "P1" })).toBeUndefined();
    expect(store.get({ id: "P2" })).toBeDefined();
    expect(store.get({ id: "P3" })).toBeDefined();
  });
});

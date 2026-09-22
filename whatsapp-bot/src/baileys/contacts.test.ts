/**
 * Names and LID-to-phone pairs, HARVESTED from what WhatsApp already sent
 * us, never fetched.
 *
 * Baileys has no `getContactById`, and the network substitute (a USync
 * directory query) is what got every linked device on HomeTenant's number
 * unlinked on 2026-09-17 (plan §2.2). So the only names the Baileys driver
 * can offer are the ones that arrived on their own: `pushName` on inbound
 * messages, and `contacts.upsert` / `contacts.update` during app-state
 * sync (plan §2.9). This module is where they are kept.
 */
import { describe, it, expect } from "vitest";
import { createContactDirectory } from "./contacts.js";

describe("names from inbound messages", () => {
  it("learns a sender's pushname under their JID, in the spelling the bot compares", () => {
    const d = createContactDirectory();
    d.learnFromMessage(
      { remoteJid: "120363@g.us", participant: "447700900123:3@s.whatsapp.net", fromMe: false },
      "  Sam  ",
    );
    expect(d.namesFor("447700900123@c.us")).toEqual({ pushname: "Sam" });
    // Either spelling finds it.
    expect(d.namesFor("447700900123@s.whatsapp.net")).toEqual({ pushname: "Sam" });
  });

  it("learns the LID and the phone as ONE person when the envelope carries both", () => {
    const d = createContactDirectory();
    d.learnFromMessage(
      {
        remoteJid: "120363@g.us",
        participant: "158055467598020@lid",
        participantAlt: "447700900123@s.whatsapp.net",
        fromMe: false,
      },
      "Sam",
    );
    expect(d.phoneForLid("158055467598020@lid")).toBe("447700900123");
    expect(d.namesFor("158055467598020@lid")).toEqual({ pushname: "Sam" });
    expect(d.namesFor("447700900123@c.us")).toEqual({ pushname: "Sam" });
  });

  it("takes a DM sender from remoteJid", () => {
    const d = createContactDirectory();
    d.learnFromMessage(
      { remoteJid: "158055467598020@lid", remoteJidAlt: "447700900123@s.whatsapp.net", fromMe: false },
      "Sam",
    );
    expect(d.phoneForLid("158055467598020@lid")).toBe("447700900123");
  });

  it("never files OUR pushname under the chat we sent to", () => {
    // On our own messages pushName is the bot's name and remoteJid is the
    // person we DMed. Learning it would rename every DM recipient "MatchTime".
    const d = createContactDirectory();
    d.learnFromMessage({ remoteJid: "447700900123@s.whatsapp.net", fromMe: true }, "MatchTime");
    expect(d.namesFor("447700900123@c.us")).toEqual({});
  });

  it("ignores a blank pushname rather than overwriting a good one", () => {
    const d = createContactDirectory();
    const key = { remoteJid: "447700900123@s.whatsapp.net", fromMe: false };
    d.learnFromMessage(key, "Sam");
    d.learnFromMessage(key, "   ");
    d.learnFromMessage(key, null);
    expect(d.namesFor("447700900123@c.us")).toEqual({ pushname: "Sam" });
  });
});

describe("names from contacts.upsert / contacts.update", () => {
  it("keeps notify as the pushname and name as the saved name, under every id given", () => {
    const d = createContactDirectory();
    d.learnContact({
      id: "158055467598020@lid",
      phoneNumber: "447700900123@s.whatsapp.net",
      notify: "Sam",
      name: "Sam Sutton FC",
      verifiedName: "Sam's Plumbing",
    });
    const want = { pushname: "Sam", name: "Sam Sutton FC", verifiedName: "Sam's Plumbing" };
    expect(d.namesFor("158055467598020@lid")).toEqual(want);
    expect(d.namesFor("447700900123@c.us")).toEqual(want);
    expect(d.phoneForLid("158055467598020@lid")).toBe("447700900123");
  });

  it("merges a partial update into what is already known", () => {
    const d = createContactDirectory();
    d.learnContact({ id: "447700900123@s.whatsapp.net", notify: "Sam" });
    d.learnContact({ id: "447700900123@s.whatsapp.net", name: "Sam S" });
    expect(d.namesFor("447700900123@c.us")).toEqual({ pushname: "Sam", name: "Sam S" });
  });

  it("takes a contact whose id is the phone and whose lid is separate", () => {
    const d = createContactDirectory();
    d.learnContact({ id: "447700900123@s.whatsapp.net", lid: "158055467598020@lid", notify: "Sam" });
    expect(d.phoneForLid("158055467598020@lid")).toBe("447700900123");
  });
});

describe("LID to phone pairs", () => {
  it("accepts a pair in either order and refuses anything that is not a LID and a phone", () => {
    const d = createContactDirectory();
    d.learnPair("447700900123@s.whatsapp.net", "158055467598020@lid");
    expect(d.phoneForLid("158055467598020@lid")).toBe("447700900123");
    d.learnPair("120363@g.us", "999@lid");
    d.learnPair("0@s.whatsapp.net", "888@lid");
    expect(d.phoneForLid("999@lid")).toBeNull();
    expect(d.phoneForLid("888@lid")).toBeNull();
  });

  it("never reads a phone out of a LID's own digits", () => {
    const d = createContactDirectory();
    expect(d.phoneForLid("447700900123@lid")).toBeNull();
    expect(d.phoneForLid("447700900123@c.us")).toBeNull();
  });

  it("finds a pair whatever device suffix the LID was written with", () => {
    const d = createContactDirectory();
    d.learnPair("158055467598020:7@lid", "447700900123:2@s.whatsapp.net");
    expect(d.phoneForLid("158055467598020@lid")).toBe("447700900123");
  });
});

describe("bounded", () => {
  it("forgets the oldest entries past its limit, so a fortnight's uptime cannot grow it for ever", () => {
    const d = createContactDirectory(3);
    for (let i = 1; i <= 5; i++) {
      d.learnFromMessage({ remoteJid: `44770090000${i}@s.whatsapp.net`, fromMe: false }, `P${i}`);
    }
    expect(d.size()).toBe(3);
    expect(d.namesFor("447700900001@c.us")).toEqual({});
    expect(d.namesFor("447700900005@c.us")).toEqual({ pushname: "P5" });
  });

  it("returns an empty record, never throws, for anything it does not know", () => {
    const d = createContactDirectory();
    expect(d.namesFor("nobody@c.us")).toEqual({});
    expect(d.namesFor("")).toEqual({});
    expect(d.namesFor(undefined as unknown as string)).toEqual({});
  });
});

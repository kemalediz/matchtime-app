/**
 * Self-join slice 5: what the DM forward adds for the connect DM (plan
 * 2.2, 5.3). The server matches the organiser's connect code against the
 * phone on the envelope, and keeps the LID so the later group add can
 * resolve a LID-only adder. Read off the message and the contact record
 * the driver already builds locally: never a directory lookup.
 */
import { describe, expect, it } from "vitest";
import { dmSenderExtras } from "./dm-identity.js";

const LID = "158055467598020";

describe("dmSenderExtras", () => {
  it("a LID-addressed DM: the LID from the chat id", () => {
    expect(dmSenderExtras(`${LID}@lid`, {})).toEqual({ senderLid: LID });
  });

  it("a phone-addressed DM whose envelope carried the LID (Baileys contact record)", () => {
    expect(dmSenderExtras("447700900123@c.us", { lid: LID })).toEqual({ senderLid: LID });
  });

  it("the alt phone, when the envelope carried one", () => {
    expect(dmSenderExtras(`${LID}@lid`, { lid: LID, altPhone: "447700900123" })).toEqual({
      senderLid: LID,
      senderAltPhone: "447700900123",
    });
  });

  it("a whatsapp-web.js contact whose id is the LID", () => {
    expect(dmSenderExtras("447700900123@c.us", { id: { _serialized: `${LID}@lid` } })).toEqual({ senderLid: LID });
  });

  it("nothing known: nothing sent (the server treats absent as unknown, as an older Pi)", () => {
    expect(dmSenderExtras("447700900123@c.us", null)).toEqual({});
    expect(dmSenderExtras("447700900123@c.us", { id: { _serialized: "447700900123@c.us" } })).toEqual({});
    expect(dmSenderExtras("447700900123@c.us", { lid: "not-a-lid", altPhone: "abc" })).toEqual({});
  });

  it("never throws on a contact whose getters throw (the broken whatsapp-web.js build)", () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("getter exploded");
        },
      },
    );
    expect(dmSenderExtras("447700900123@c.us", hostile)).toEqual({});
    expect(dmSenderExtras(`${LID}@lid`, hostile)).toEqual({ senderLid: LID });
  });
});

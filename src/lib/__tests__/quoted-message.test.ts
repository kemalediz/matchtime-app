/**
 * Which message a WhatsApp reply quotes (cross-club ask, slice S0).
 *
 * The Pi forwards a reply's quoted id as the bare stanza id ("3EB0...");
 * a post MatchTime sent is acknowledged with the serialised key
 * ("true_<group>_3EB0..." or "..._<participant>"). They are the same
 * message when the stanza ids are equal.
 */
import { describe, expect, it } from "vitest";
import { bareWhatsAppId, quotedRefOf, sameWhatsAppMessage } from "../quoted-message";

describe("bareWhatsAppId", () => {
  it("reads the stanza id out of a serialised key", () => {
    expect(bareWhatsAppId("true_120363000000009200@g.us_3EB0ABC")).toBe("3EB0ABC");
    expect(bareWhatsAppId("false_120363000000009200@g.us_3EB0ABC_447700900123@c.us")).toBe("3EB0ABC");
  });
  it("a bare id is itself", () => {
    expect(bareWhatsAppId("3EB0ABC")).toBe("3EB0ABC");
  });
  it("nothing is nothing", () => {
    expect(bareWhatsAppId(null)).toBeNull();
    expect(bareWhatsAppId("")).toBeNull();
  });
});

describe("sameWhatsAppMessage", () => {
  it("a reply's stanza id matches the post's acknowledged key", () => {
    expect(sameWhatsAppMessage("3EB0ABC", "true_120363000000009200@g.us_3EB0ABC")).toBe(true);
    expect(sameWhatsAppMessage("3EB0ABD", "true_120363000000009200@g.us_3EB0ABC")).toBe(false);
  });
  it("a missing id never matches", () => {
    expect(sameWhatsAppMessage(null, "true_g@g.us_3EB0ABC")).toBe(false);
    expect(sameWhatsAppMessage("3EB0ABC", null)).toBe(false);
  });
});

describe("quotedRefOf: what the analyze route carries on to the engine", () => {
  it("a reply with an id", () => {
    expect(quotedRefOf({ quotedMessageId: "3EB0ABC", quotedFromMatchTime: true })).toEqual({ id: "3EB0ABC", fromMatchTime: true });
    expect(quotedRefOf({ quotedMessageId: "3EB0ABC" })).toEqual({ id: "3EB0ABC", fromMatchTime: false });
  });
  it("no id (not a reply, or an older Pi): nothing", () => {
    expect(quotedRefOf({ quotedFromMatchTime: true })).toBeNull();
    expect(quotedRefOf({ quotedMessageId: "  " })).toBeNull();
    expect(quotedRefOf({ quotedMessageId: 42 as unknown as string })).toBeNull();
  });
});

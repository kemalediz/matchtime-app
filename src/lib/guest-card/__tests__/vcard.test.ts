/**
 * Reading a shared WhatsApp contact card (2026-11-17). The CONTAINER only:
 * a vCard is a file format WhatsApp renders as text, and these tests pin
 * what is read out of it (the display name and the number) and what is not
 * (anything a person typed). Made-up people, 07700 900xxx numbers.
 */
import { describe, expect, it } from "vitest";
import { CONTACT_CARD_LABEL, cardSafeText, isContactCard, readContactCards } from "../vcard";

const ANDROID = ["BEGIN:VCARD", "VERSION:3.0", "N:;Abu Ayoub;;;", "FN:Abu Ayoub", "TEL;type=CELL;type=VOICE;waid=447700900123:+44 7700 900123", "END:VCARD"].join("\n");
const IPHONE = ["BEGIN:VCARD", "VERSION:3.0", "N:Ayoub;Abu;;;", "FN:Abu Ayoub Ftbl", "item1.TEL;waid=447700900124:+44 7700 900124", "item1.X-ABLabel:Mobile", "END:VCARD"].join("\r\n");

describe("isContactCard", () => {
  it("is the envelope, whoever it names", () => {
    expect(isContactCard(ANDROID)).toBe(true);
    expect(isContactCard(`  ${IPHONE}`)).toBe(true);
    expect(isContactCard("begin:vcard\nFN:x\nend:vcard")).toBe(true);
  });
  it("words are never a card, even words about a card", () => {
    expect(isContactCard("add him for tonight")).toBe(false);
    expect(isContactCard("I'll send you BEGIN:VCARD later")).toBe(false);
    expect(isContactCard("")).toBe(false);
    expect(isContactCard(null)).toBe(false);
  });
});

describe("readContactCards", () => {
  it("an Android card: the name and the WhatsApp number", () => {
    expect(readContactCards(ANDROID)).toEqual([{ name: "Abu Ayoub", phone: "+447700900123" }]);
  });
  it("an iPhone card (CRLF, item-grouped TEL): the raw display name is kept here", () => {
    expect(readContactCards(IPHONE)).toEqual([{ name: "Abu Ayoub Ftbl", phone: "+447700900124" }]);
  });
  it("the WhatsApp id wins over the first number on the card", () => {
    const card = ["BEGIN:VCARD", "FN:Sami Kaya", "TEL;type=HOME:020 7946 0000", "TEL;waid=447700900125:+44 7700 900125", "END:VCARD"].join("\n");
    expect(readContactCards(card)).toEqual([{ name: "Sami Kaya", phone: "+447700900125" }]);
  });
  it("with no WhatsApp id, the first number that is a real number", () => {
    const card = ["BEGIN:VCARD", "FN:Sami Kaya", "TEL;type=CELL:07700 900126", "END:VCARD"].join("\n");
    expect(readContactCards(card)).toEqual([{ name: "Sami Kaya", phone: "+447700900126" }]);
  });
  it("no FN: the N line's given and family names", () => {
    const card = ["BEGIN:VCARD", "N:Kaya;Sami;;;", "TEL;waid=447700900127:+44 7700 900127", "END:VCARD"].join("\n");
    expect(readContactCards(card)).toEqual([{ name: "Sami Kaya", phone: "+447700900127" }]);
  });
  it("folded lines and escaped characters", () => {
    const card = ["BEGIN:VCARD", "FN:Abu\\, the", "  keeper", "TEL;waid=447700900128:+44 7700 900128", "END:VCARD"].join("\n");
    expect(readContactCards(card)).toEqual([{ name: "Abu, the keeper", phone: "+447700900128" }]);
  });
  it("several cards in one message (a shared list of contacts)", () => {
    const two = `${ANDROID}\n${IPHONE}`;
    expect(readContactCards(two).map((c) => c.phone)).toEqual(["+447700900123", "+447700900124"]);
  });
  it("a card cut short (no END) still reads what it has", () => {
    expect(readContactCards(["BEGIN:VCARD", "FN:Abu Ayoub", "TEL;waid=447700900123:+44 7700 900123"].join("\n"))).toEqual([{ name: "Abu Ayoub", phone: "+447700900123" }]);
  });
  it("no number: the card is read with no phone", () => {
    expect(readContactCards(["BEGIN:VCARD", "FN:Abu Ayoub", "END:VCARD"].join("\n"))).toEqual([{ name: "Abu Ayoub", phone: null }]);
  });
  it("not a card: nothing", () => {
    expect(readContactCards("add him for tonight 07700 900123")).toEqual([]);
  });
});

describe("cardSafeText: what is stored and shown to a model", () => {
  it("a card becomes its label, with no name and no number", () => {
    expect(cardSafeText(ANDROID)).toBe(CONTACT_CARD_LABEL);
    expect(CONTACT_CARD_LABEL).not.toMatch(/\d/);
  });
  it("anything else is unchanged", () => {
    expect(cardSafeText("add him for tonight")).toBe("add him for tonight");
  });
});

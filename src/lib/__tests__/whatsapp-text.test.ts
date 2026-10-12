/** WhatsApp bold for the web: `*x*` becomes a bold run, nothing else changes. */
import { describe, expect, it } from "vitest";
import { whatsappLines } from "../whatsapp-text";

describe("whatsappLines", () => {
  it("keeps every line, blank ones included", () => {
    expect(whatsappLines("Hi all\n\nSee you Tuesday")).toEqual([
      [{ text: "Hi all", bold: false }],
      [],
      [{ text: "See you Tuesday", bold: false }],
    ]);
  });

  it("bold runs lose their stars; the text round them stays, emoji included", () => {
    expect(whatsappLines("⚽ *Who's in:* say *In* or *Out*")).toEqual([
      [
        { text: "⚽ ", bold: false },
        { text: "Who's in:", bold: true },
        { text: " say ", bold: false },
        { text: "In", bold: true },
        { text: " or ", bold: false },
        { text: "Out", bold: true },
      ],
    ]);
  });

  it("a star that is not a pair, or stars round a space, are left as typed", () => {
    expect(whatsappLines("5 * 2 = 10")).toEqual([[{ text: "5 * 2 = 10", bold: false }]]);
    expect(whatsappLines("rated 4* today")).toEqual([[{ text: "rated 4* today", bold: false }]]);
    expect(whatsappLines("a * b * c")).toEqual([[{ text: "a * b * c", bold: false }]]);
  });

  it("bold never crosses a line break", () => {
    expect(whatsappLines("*one\ntwo*")).toEqual([[{ text: "*one", bold: false }], [{ text: "two*", bold: false }]]);
  });

  it("Windows line ends are line ends", () => {
    expect(whatsappLines("a\r\nb")).toEqual([[{ text: "a", bold: false }], [{ text: "b", bold: false }]]);
  });
});

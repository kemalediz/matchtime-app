/** WhatsApp bold for the web: `*x*` becomes a bold run, nothing else changes. */
import { describe, expect, it } from "vitest";
import { whatsappLines } from "../whatsapp-text";

const plain = (text: string) => [[{ text, bold: false }]];

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
    expect(whatsappLines("5 * 2 = 10")).toEqual(plain("5 * 2 = 10"));
    expect(whatsappLines("rated 4* today")).toEqual(plain("rated 4* today"));
    expect(whatsappLines("a * b * c")).toEqual(plain("a * b * c"));
  });

  it("review fix 8: stars inside a word are not bold (the opening star must start a word, the closing one end it)", () => {
    expect(whatsappLines("2*3*4")).toEqual(plain("2*3*4"));
    expect(whatsappLines("a*b*c")).toEqual(plain("a*b*c"));
    expect(whatsappLines("x*y* z")).toEqual(plain("x*y* z"));
    expect(whatsappLines("x *y*z")).toEqual(plain("x *y*z"));
    expect(whatsappLines("çay*şeker*ı")).toEqual(plain("çay*şeker*ı"));
  });

  it("punctuation round the stars is a word boundary: (*bold*), *bold*. and *bold*: are bold", () => {
    expect(whatsappLines("(*In*), *Out*. *Maybe*:")).toEqual([
      [
        { text: "(", bold: false },
        { text: "In", bold: true },
        { text: "), ", bold: false },
        { text: "Out", bold: true },
        { text: ". ", bold: false },
        { text: "Maybe", bold: true },
        { text: ":", bold: false },
      ],
    ]);
  });

  it("review fix 8: a link is never bolded, whatever stars it holds", () => {
    expect(whatsappLines("see https://x.test/*a*/b now")).toEqual(plain("see https://x.test/*a*/b now"));
    expect(whatsappLines("www.x.test/?q=*a*")).toEqual(plain("www.x.test/?q=*a*"));
    // Bold beside a link still works.
    expect(whatsappLines("*Link:* https://x.test/*a*/b")).toEqual([
      [
        { text: "Link:", bold: true },
        { text: " https://x.test/*a*/b", bold: false },
      ],
    ]);
  });

  it("bold never crosses a line break", () => {
    expect(whatsappLines("*one\ntwo*")).toEqual([[{ text: "*one", bold: false }], [{ text: "two*", bold: false }]]);
  });

  it("Windows line ends are line ends", () => {
    expect(whatsappLines("a\r\nb")).toEqual([[{ text: "a", bold: false }], [{ text: "b", bold: false }]]);
  });
});

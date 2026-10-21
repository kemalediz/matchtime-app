/**
 * The ask reference a partner club's player sends MatchTime privately
 * (cross-club ask, volunteering by DM, Kemal 2026-10-21).
 *
 * The post in the partner group carries a tap-to-DM link whose prefilled
 * text holds a short code MatchTime issued for the ask. The code is a
 * pointer the code made, read back as structured data (like the connect
 * code), never a reading of the player's words: whether the DM is an IN or
 * an OUT is still the DM resolver's decision.
 */
import { describe, expect, it } from "vitest";
import { CONNECT_CODE_ALPHABET } from "../club-connect-rules";
import { classifyDmSelfAttendance } from "../dm-self-attendance";
import { askDmLink, askDmPrefill, askRefCandidates, askRefCode, stripAskRef } from "../partner-ask-ref";

describe("askRefCode", () => {
  it("is four characters from the connect alphabet, the same for the same ask", () => {
    const a = askRefCode("cmabc123xyz");
    expect(a).toMatch(new RegExp(`^[${CONNECT_CODE_ALPHABET}]{4}$`));
    expect(askRefCode("cmabc123xyz")).toBe(a);
  });

  it("differs between asks (no collisions across a thousand ids)", () => {
    const codes = new Set(Array.from({ length: 1000 }, (_, i) => askRefCode(`cmask${i}`)));
    expect(codes.size).toBeGreaterThan(995);
  });
});

describe("askRefCandidates", () => {
  it("reads the code after 'ref', whatever the case or the brackets, last first", () => {
    expect(askRefCandidates("IN (ref K7Q2)")).toEqual(["K7Q2"]);
    expect(askRefCandidates("VARIM (ref k7q2)")).toEqual(["K7Q2"]);
    expect(askRefCandidates("ref: AB23 then ref K7Q2")).toEqual(["K7Q2", "AB23"]);
  });

  it("nothing without 'ref', or inside another word, or with characters outside the alphabet", () => {
    expect(askRefCandidates("IN")).toEqual([]);
    expect(askRefCandidates("IN for Friday")).toEqual([]);
    expect(askRefCandidates("prefer K7Q2")).toEqual([]);
    expect(askRefCandidates("ref K0Q1")).toEqual([]);
    expect(askRefCandidates("ref K7Q2X")).toEqual([]);
    expect(askRefCandidates("")).toEqual([]);
  });
});

describe("stripAskRef", () => {
  it("takes the issued reference out, so the resolver reads only what he said", () => {
    expect(stripAskRef("IN (ref K7Q2)")).toBe("IN");
    expect(stripAskRef("VARIM (ref K7Q2)")).toBe("VARIM");
    expect(stripAskRef("sorry can't make it now ref K7Q2")).toBe("sorry can't make it now");
    expect(stripAskRef("IN")).toBe("IN");
  });
});

describe("the prefilled DM and its link", () => {
  it("English and Turkish prefill: the club's IN word and the reference", () => {
    expect(askDmPrefill("en", "K7Q2")).toBe("IN (ref K7Q2)");
    expect(askDmPrefill("tr", "K7Q2")).toBe("VARIM (ref K7Q2)");
  });

  it("the prefill reads back to its own code, and to a plain IN once the code is out", () => {
    for (const lang of ["en", "tr"]) {
      const text = askDmPrefill(lang, askRefCode("ask-1"));
      expect(askRefCandidates(text)).toEqual([askRefCode("ask-1")]);
      expect(stripAskRef(text)).toBe(lang === "tr" ? "VARIM" : "IN");
      // The untouched prefill is an IN on the resolver's free fast path: no
      // model call for the common case.
      expect(classifyDmSelfAttendance(stripAskRef(text))).toBe("in");
    }
  });

  it("a wa.me link to MatchTime's number carrying the prefill; null without a number", () => {
    const link = askDmLink({ number: "447700900555", lang: "en", askId: "ask-1" });
    expect(link).toBe(`https://wa.me/447700900555?text=${encodeURIComponent(askDmPrefill("en", askRefCode("ask-1")))}`);
    expect(askDmLink({ number: null, lang: "en", askId: "ask-1" })).toBeNull();
  });
});

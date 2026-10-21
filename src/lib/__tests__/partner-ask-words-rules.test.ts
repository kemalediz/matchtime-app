/**
 * Organisers asking partner clubs in their own words (slice S6), the pure
 * rules: which partners a request means, and the ONE reply that says what
 * happened with each. `src/lib/partner-ask-words-rules.ts`.
 *
 * The club the model reports (`clubRef`, as written) is looked up against
 * the club's ACTIVE partners, the way a name is looked up against the
 * roster: no phrase is read here, only the partner names the database has.
 */
import { describe, expect, it } from "vitest";
import { composePartnerAskReply, partnerNameScore, resolvePartnerRef, type PartnerChoice } from "../partner-ask-words-rules";

const SUTTON: PartnerChoice = { partnershipId: "p-sutton", partnerOrgId: "sutton", name: "Sutton FC" };
const FRIDAY: PartnerChoice = { partnershipId: "p-friday", partnerOrgId: "friday", name: "Friday MT Community" };
const VETS: PartnerChoice = { partnershipId: "p-vets", partnerOrgId: "vets", name: "MT Vets" };

describe("resolvePartnerRef", () => {
  it("no partner clubs: one plain reply, whatever was asked", () => {
    expect(resolvePartnerRef({ clubRef: "Sutton", partners: [], askWhen: "on-request" })).toEqual({ kind: "no-partner" });
    expect(resolvePartnerRef({ clubRef: null, partners: [], askWhen: "auto" })).toEqual({ kind: "no-partner" });
  });

  it("asking switched off: one plain reply", () => {
    expect(resolvePartnerRef({ clubRef: "Sutton", partners: [SUTTON], askWhen: "off" })).toEqual({ kind: "asking-off" });
    expect(resolvePartnerRef({ clubRef: null, partners: [SUTTON], askWhen: null })).toEqual({ kind: "asking-off" });
  });

  it("no club named: EVERY active partner is asked (Kemal, 2026-10-21)", () => {
    expect(resolvePartnerRef({ clubRef: null, partners: [SUTTON, FRIDAY], askWhen: "on-request" })).toEqual({ kind: "ask", partners: [SUTTON, FRIDAY] });
    expect(resolvePartnerRef({ clubRef: "  ", partners: [SUTTON, FRIDAY, VETS], askWhen: "auto" })).toEqual({ kind: "ask", partners: [SUTTON, FRIDAY, VETS] });
  });

  it("no club named, one partner: that partner", () => {
    expect(resolvePartnerRef({ clubRef: "", partners: [SUTTON], askWhen: "on-request" })).toEqual({ kind: "ask", partners: [SUTTON] });
  });

  it("a named club resolves to that partner only", () => {
    expect(resolvePartnerRef({ clubRef: "Sutton", partners: [SUTTON, FRIDAY], askWhen: "on-request" })).toEqual({ kind: "ask", partners: [SUTTON] });
    expect(resolvePartnerRef({ clubRef: "Friday MT Community", partners: [SUTTON, FRIDAY], askWhen: "on-request" })).toEqual({ kind: "ask", partners: [FRIDAY] });
    expect(resolvePartnerRef({ clubRef: "the Friday lot", partners: [SUTTON, FRIDAY], askWhen: "on-request" })).toEqual({ kind: "ask", partners: [FRIDAY] });
  });

  it("a named club no partner matches: no-match, with the partners to name", () => {
    expect(resolvePartnerRef({ clubRef: "Croydon", partners: [SUTTON, FRIDAY], askWhen: "on-request" })).toEqual({
      kind: "no-match",
      ref: "Croydon",
      partners: [SUTTON, FRIDAY],
    });
  });

  it("a name two partners share equally: ambiguous, never both asked", () => {
    expect(resolvePartnerRef({ clubRef: "MT", partners: [FRIDAY, VETS], askWhen: "on-request" })).toEqual({
      kind: "ambiguous",
      ref: "MT",
      candidates: [FRIDAY, VETS],
    });
  });

  it("the better match wins over a partial one", () => {
    expect(resolvePartnerRef({ clubRef: "MT Vets", partners: [FRIDAY, VETS], askWhen: "on-request" })).toEqual({ kind: "ask", partners: [VETS] });
  });
});

describe("partnerNameScore: a club name as written against a partner's name", () => {
  it("case, accents and the Turkish case ending do not matter", () => {
    expect(partnerNameScore("sutton", "Sutton FC")).toBeGreaterThan(0);
    expect(partnerNameScore("Sutton'a", "Sutton FC")).toBeGreaterThan(0);
    expect(partnerNameScore("Sutton’dan", "Sutton FC")).toBeGreaterThan(0);
    expect(partnerNameScore("Suttona", "Sutton FC")).toBeGreaterThan(0);
    expect(partnerNameScore("İSTANBUL", "Istanbul Spor")).toBeGreaterThan(0);
    expect(partnerNameScore("Kadıköy", "Kadikoy Halisaha")).toBeGreaterThan(0);
  });

  it("a short word counts only when it is the whole word", () => {
    expect(partnerNameScore("FC", "Sutton FC")).toBeGreaterThan(0);
    expect(partnerNameScore("F", "Sutton FC")).toBe(0);
    expect(partnerNameScore("Sut", "Sutton FC")).toBeGreaterThan(0);
  });

  it("an unrelated name scores nothing", () => {
    expect(partnerNameScore("Croydon", "Sutton FC")).toBe(0);
    expect(partnerNameScore("", "Sutton FC")).toBe(0);
  });
});

describe("composePartnerAskReply: one reply for every partner asked", () => {
  it("one partner, waiting for their organisers", () => {
    const text = composePartnerAskReply("en", [{ partnerName: "Sutton FC", result: "awaiting" }], { cutoffHours: 4 });
    expect(text).toBe("I've asked *Sutton FC*'s organisers. Once they say yes, I'll post in their group, and anyone who replies IN goes on your bench.");
  });

  it("one partner, posted at once (standing permission)", () => {
    const text = composePartnerAskReply("en", [{ partnerName: "Sutton FC", result: "posted" }], { cutoffHours: 4 });
    expect(text).toBe("I've posted in *Sutton FC*'s group. Anyone who replies IN goes on your bench.");
  });

  it("one partner refused: the reason in plain words, never the page's 'reload'", () => {
    expect(composePartnerAskReply("en", [{ partnerName: "Sutton FC", result: "already-open" }], { cutoffHours: 4 })).toBe(
      "There's already an ask to Sutton FC open for this game.",
    );
    expect(composePartnerAskReply("en", [{ partnerName: "Sutton FC", result: "not-next-match" }], { cutoffHours: 4 })).not.toMatch(/reload/i);
  });

  it("several partners: ONE reply with a line each", () => {
    const text = composePartnerAskReply(
      "en",
      [
        { partnerName: "Sutton FC", result: "posted" },
        { partnerName: "Friday MT Community", result: "awaiting" },
        { partnerName: "MT Vets", result: "partner-muted" },
      ],
      { cutoffHours: 4 },
    );
    expect(text).toBe(
      [
        "I've asked your partner clubs:",
        "• *Sutton FC*: posted in their group.",
        "• *Friday MT Community*: waiting for their organisers to say yes.",
        "• *MT Vets*: their group can't be asked right now.",
        "Anyone who replies IN goes on your bench.",
      ].join("\n"),
    );
  });

  it("several partners, all refused for the same game reason: no bench line", () => {
    const text = composePartnerAskReply(
      "en",
      [
        { partnerName: "Sutton FC", result: "no-places" },
        { partnerName: "MT Vets", result: "no-places" },
      ],
      { cutoffHours: 4 },
    );
    expect(text).not.toContain("bench");
    expect(text).toContain("*Sutton FC*: no place is open in this game.");
  });

  it("Turkish, every shape, with yedek and never a dash", () => {
    const one = composePartnerAskReply("tr", [{ partnerName: "Sutton FC", result: "awaiting" }], { cutoffHours: 4 });
    expect(one).toContain("Sutton FC");
    expect(one).toContain("yedek");
    const many = composePartnerAskReply(
      "tr",
      [
        { partnerName: "Sutton FC", result: "posted" },
        { partnerName: "MT Vets", result: "too-late" },
      ],
      { cutoffHours: 4 },
    );
    expect(many.split("\n")[0]).toBe("Partner kulüplerinize sordum:");
    for (const s of [one, many]) expect(s).not.toMatch(/[—–]/);
  });
});

/**
 * Asking in words after P4 (partner discovery, 2026-10-22). Plan:
 * MDs/partner-discovery-plan-2026-10-21.md, section 4 (D-7) and 2.1.
 *
 *   - a words ask still asks for EVERY open place, and its reply says how
 *     many ("asked for 3 players");
 *   - a paused partner (dormant or billing-paused) is skipped and the reply
 *     says which, in English and Turkish.
 */
import { describe, expect, it } from "vitest";
import { composePartnerAskReply } from "../partner-ask-words-rules";

describe("composePartnerAskReply: how many, and who is paused", () => {
  it("several partners, one paused: the paused one is named as paused, and the number asked for is said", () => {
    const text = composePartnerAskReply(
      "en",
      [
        { partnerName: "Sutton FC", result: "posted" },
        { partnerName: "Cheam", result: "partner-dormant" },
      ],
      { cutoffHours: 4, places: 3 },
    );
    expect(text).toContain("• *Sutton FC*: posted in their group.");
    expect(text).toContain("• *Cheam*: paused on MatchTime, so I didn't ask them.");
    expect(text).toContain("I asked for 3 players.");
  });

  it("one partner, asked for 1: the number is said", () => {
    expect(composePartnerAskReply("en", [{ partnerName: "Sutton FC", result: "posted" }], { cutoffHours: 4, places: 1 })).toBe(
      "I've posted in *Sutton FC*'s group. Anyone who replies IN goes on your bench.\nI asked for 1 player.",
    );
  });

  it("one partner, billing-paused: one plain sentence", () => {
    expect(composePartnerAskReply("en", [{ partnerName: "Cheam", result: "partner-paused" }], { cutoffHours: 4, places: 2 })).toBe(
      "Cheam is paused on MatchTime, so I can't ask them now.",
    );
  });

  it("Turkish", () => {
    const text = composePartnerAskReply(
      "tr",
      [
        { partnerName: "Sutton FC", result: "awaiting" },
        { partnerName: "Cheam", result: "partner-paused" },
      ],
      { cutoffHours: 4, places: 2 },
    );
    expect(text).toContain("• *Cheam*: MatchTime'da duraklatıldı, bu yüzden sormadım.");
    expect(text).toContain("2 oyuncu istedim.");
  });

  it("nothing asked: no number line", () => {
    const text = composePartnerAskReply("en", [{ partnerName: "Cheam", result: "partner-paused" }, { partnerName: "Sutton FC", result: "daily-cap" }], { cutoffHours: 4, places: 2 });
    expect(text).not.toContain("I asked for");
  });

  it("without a number (callers that never passed one): exactly as before", () => {
    expect(composePartnerAskReply("en", [{ partnerName: "Sutton FC", result: "posted" }], { cutoffHours: 4 })).toBe(
      "I've posted in *Sutton FC*'s group. Anyone who replies IN goes on your bench.",
    );
  });
});

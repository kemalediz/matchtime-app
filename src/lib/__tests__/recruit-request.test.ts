/**
 * Recruit-request plumbing — the two pure pieces of the 2026-09-01 fix.
 *
 * The incident: the owner wrote "Najib is out. We need one more player.
 * Can someone pls come forward". `looksLikeRecruitRequest` matched the
 * SECOND sentence, the recruit fast path peeled the whole message off the
 * LLM batch, and the third-party OUT was never analysed. Najib stayed in,
 * the recruit action saw 10/10, and MatchTime replied "the squad is
 * already full" one line after the owner said a player was out.
 *
 * Recruit is now an extracted verdict FACT (`recruitRequest`), so the
 * regex is gone and both halves of the message survive. What is left to
 * pin here is the pure part: exactly one reply goes out, and the tag
 * decision is a single visible switch.
 */
import { describe, it, expect } from "vitest";
import {
  mergeRecruitReply,
  RECRUIT_COMMAND_IMPLIES_ADDRESSED,
} from "../recruit-request";

describe("mergeRecruitReply — one outbound message, never two", () => {
  it("joins the LLM reply and the server's recruit line into one string", () => {
    expect(
      mergeRecruitReply("Najib's out — squad is 9/10.", "📣 On it — DM'd 4 recent players."),
    ).toBe("Najib's out — squad is 9/10.\n\n📣 On it — DM'd 4 recent players.");
  });

  it("returns the recruit line alone when the LLM said nothing", () => {
    expect(mergeRecruitReply(null, "📣 On it.")).toBe("📣 On it.");
  });

  it("returns the LLM reply alone when the recruit produced no line", () => {
    expect(mergeRecruitReply("Najib's out.", null)).toBe("Najib's out.");
  });

  it("returns null when neither spoke", () => {
    expect(mergeRecruitReply(null, null)).toBeNull();
    expect(mergeRecruitReply(undefined, undefined)).toBeNull();
  });

  it("treats whitespace-only as silence", () => {
    expect(mergeRecruitReply("   \n ", "📣 On it.")).toBe("📣 On it.");
    expect(mergeRecruitReply("Najib's out.", "\t\n")).toBe("Najib's out.");
    expect(mergeRecruitReply("  ", "  ")).toBeNull();
  });

  it("never says the same thing twice", () => {
    expect(mergeRecruitReply("Same line", "Same line")).toBe("Same line");
  });

  it("always returns ONE string — never an array, never two sends", () => {
    const merged = mergeRecruitReply("a", "b");
    expect(typeof merged).toBe("string");
    expect(merged!.split("\n\n")).toHaveLength(2); // one message, two paragraphs
  });
});

describe("RECRUIT_COMMAND_IMPLIES_ADDRESSED", () => {
  it("is a single boolean switch, so the contract widening is revertible on one line", () => {
    expect(typeof RECRUIT_COMMAND_IMPLIES_ADDRESSED).toBe("boolean");
  });
});

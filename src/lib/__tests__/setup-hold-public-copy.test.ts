/**
 * The public pages' words about getting connected (landing page and the
 * organiser guide), and the one sentence that appears only once the
 * approval hold is switched on.
 */
import { describe, expect, it } from "vitest";
import { CONNECT_HOW_LONG, holdHowItWorksSentence } from "../setup-hold-public-copy";

describe("the public copy about the approval hold", () => {
  it("how long connecting takes is said one way, the way the DMs say it", () => {
    expect(CONNECT_HOW_LONG).toBe("usually within a day");
  });

  it("hold off (today): no extra sentence, so the public pages read as they do now", () => {
    expect(holdHowItWorksSentence(false)).toBeNull();
  });

  it("hold on: after approval MatchTime shows what it read and waits for GO before it speaks", () => {
    expect(holdHowItWorksSentence(true)).toBe(
      "Once your club is approved, MatchTime shows you how it has read your group and waits for you to say GO before it speaks in the group.",
    );
  });
});

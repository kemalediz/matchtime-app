/**
 * The extractor stub (a TEST-ONLY seam) finds the message body after the
 * "THE MESSAGE (from …):" header. A sender MatchTime does not know is shown
 * as "(unknown)", whose own brackets used to end the header early, so the
 * stub answered nothing for them (found 2026-10-16, the admin group's
 * "anyone can ask" e2e).
 */
import { describe, expect, it } from "vitest";
import { messageBodyOf } from "../extractor-stub";

describe("messageBodyOf", () => {
  it("a named sender", () => {
    expect(messageBodyOf("context\n\nTHE MESSAGE (from Pat Player, who tagged the bot):\nwho's on the bench?")).toBe("who's on the bench?");
  });

  it("an unknown sender", () => {
    expect(messageBodyOf("context\n\nTHE MESSAGE (from (unknown), who tagged the bot):\nwho's on the bench?")).toBe("who's on the bench?");
    expect(messageBodyOf("THE MESSAGE (from (unknown)):\nwho's on the bench?")).toBe("who's on the bench?");
  });
});

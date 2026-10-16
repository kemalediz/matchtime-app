/**
 * The organisers' pick list labels a guest with his club (cross-club ask,
 * slice S3, plan 3.7): "Ali K (Sutton FC)". The rating beside it is THIS
 * club's (empty for a new guest), never his club's.
 */
import { describe, expect, it } from "vitest";
import { buildPickListBlock } from "../organiser-pick-rules";

describe("pick list guest label", () => {
  it("a guest carries his club's name; a member is unlabelled", () => {
    const block = buildPickListBlock("en", [
      { name: "Ali K", position: "MID", rating: null, fromClub: "Sutton FC" },
      { name: "Bilal", position: null, rating: 6.8 },
    ]);
    expect(block).toContain("Ali K (Sutton FC)");
    expect(block).toContain("Bilal");
    expect(block).toContain("2. Bilal (no position, 6.8)");
  });
});

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

describe("pick list: a POOL guest (local player pool, L5a)", () => {
  it("is labelled (MatchTime player pool) exactly as a partner guest gets his club", () => {
    const block = buildPickListBlock("en", [{ name: "Ali K", position: "MID", rating: null, fromPool: true }]);
    expect(block).toContain("1. Ali K (MatchTime player pool) (MID, new)");
  });
  it("in Turkish", () => {
    const block = buildPickListBlock("tr", [{ name: "Ali K", position: "MID", rating: null, fromPool: true }]);
    expect(block).toContain("1. Ali K (MatchTime oyuncu havuzu) (MID, yeni)");
  });
});

describe("pick list guest standing at his own club (2026-10-22)", () => {
  it("the band beside his club, and his club's number only when it shares", () => {
    const block = buildPickListBlock("en", [
      { name: "Ali K", position: "MID", rating: null, fromClub: "Sutton FC", fromStanding: { band: "top", rating: null } },
      { name: "Cem", position: null, rating: null, fromClub: "FMC", fromStanding: { band: "middle", rating: 6.84 } },
    ]);
    expect(block).toContain("1. Ali K (Sutton FC, top third there) (MID, new)");
    expect(block).toContain("2. Cem (FMC, middle third there, rated 6.8) (no position, new)");
  });

  it("in Turkish", () => {
    const block = buildPickListBlock("tr", [{ name: "Ali K", position: "MID", rating: null, fromClub: "Sutton FC", fromStanding: { band: "unrated", rating: null } }]);
    expect(block).toContain("1. Ali K (Sutton FC, orada henüz puanı yok) (MID, yeni)");
  });
});

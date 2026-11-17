/**
 * The guest's game as the DM answer is shown it (2026-11-17): facts only,
 * from the club's data, never a number.
 */
import { describe, expect, it } from "vitest";
import { formatGuestGameBlock } from "../context";

const f = {
  club: "Riverside FC",
  kickoff: new Date("2026-11-17T20:00:00Z"),
  format: "Football 7-a-side",
  venue: "Powerleague Shoreditch",
  address: "12 Whiston Road, London E2 8BN",
  mapUrl: "https://www.google.com/maps/search/?api=1&query=51.5229%2C-0.0757",
  fee: { kind: "amount" as const, amount: "£6" },
  monthly: false,
};

describe("formatGuestGameBlock", () => {
  it("the game, the venue and address, the map, the fee and his place", () => {
    expect(formatGuestGameBlock(f, "CONFIRMED")).toBe(
      [
        "THE ASKER IS A GUEST of the club, booked for this one game. He is not in the club's WhatsApp group, so he asks MatchTime here. His game:",
        "- When: Tuesday 17 November at 20:00 (London)",
        "- Format: Football 7-a-side",
        "- Venue: Powerleague Shoreditch, 12 Whiston Road, London E2 8BN",
        "- Map: https://www.google.com/maps/search/?api=1&query=51.5229%2C-0.0757",
        "- Fee: £6 a player",
        "- His place: in the squad",
        "- To drop out he replies OUT here.",
      ].join("\n"),
    );
  });
  it("what the club has not set says so or is left out; the bench is said", () => {
    const text = formatGuestGameBlock({ ...f, venue: null, address: null, mapUrl: null, format: null, fee: null }, "BENCH");
    expect(text).toContain("- Venue: not set");
    expect(text).not.toContain("- Map:");
    expect(text).not.toContain("- Fee:");
    expect(text).toContain("- His place: on the bench");
  });
});

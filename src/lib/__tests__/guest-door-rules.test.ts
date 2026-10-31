/**
 * May MatchTime bring this person into this club's games as a guest?
 * (Kemal, 2026-10-31.) The one rule both doors read: the player pool's
 * offer candidates (`pool/candidate-rows.ts`) and a friend link booking
 * (`friend-link/book.ts`).
 */
import { describe, expect, it } from "vitest";
import { guestDoorShut, removedByOrganiser, type GuestDoorMembership } from "../guest-door-rules";

const T = new Date("2026-10-30T10:00:00Z");
const mem = (o: Partial<GuestDoorMembership> = {}): GuestDoorMembership => ({
  leftAt: null,
  removedByOrganiserAt: null,
  guestMatchId: null,
  guestFromOrgId: null,
  guestVia: null,
  ...o,
});

describe("removedByOrganiser", () => {
  it("no membership, or one nobody removed: no", () => {
    expect(removedByOrganiser(null)).toBe(false);
    expect(removedByOrganiser(undefined)).toBe(false);
    expect(removedByOrganiser(mem())).toBe(false);
  });

  it("he left the group himself (leftAt only): no, he can come back as a guest as today", () => {
    expect(removedByOrganiser(mem({ leftAt: T }))).toBe(false);
  });

  it("an organiser removed him: yes", () => {
    expect(removedByOrganiser(mem({ leftAt: T, removedByOrganiserAt: T }))).toBe(true);
  });

  it("he is a live ordinary member again (the club has him back): no, the guest doors are not his", () => {
    expect(removedByOrganiser(mem({ leftAt: null, removedByOrganiserAt: T }))).toBe(false);
  });

  it("a guest row of the club (live or past) still carrying the mark: yes", () => {
    expect(removedByOrganiser(mem({ removedByOrganiserAt: T, guestVia: "pool", guestMatchId: "m1" }))).toBe(true);
    expect(removedByOrganiser(mem({ leftAt: T, removedByOrganiserAt: T, guestVia: "pool", guestMatchId: "m1" }))).toBe(true);
  });
});

describe("guestDoorShut", () => {
  it("open for a stranger, and for somebody who left the group himself", () => {
    expect(guestDoorShut({ blocked: false, membership: null })).toBe(false);
    expect(guestDoorShut({ blocked: false, membership: mem({ leftAt: T }) })).toBe(false);
  });

  it("shut by a block, as before", () => {
    expect(guestDoorShut({ blocked: true, membership: null })).toBe(true);
  });

  it("shut for somebody an organiser removed from this club", () => {
    expect(guestDoorShut({ blocked: false, membership: mem({ leftAt: T, removedByOrganiserAt: T }) })).toBe(true);
  });
});

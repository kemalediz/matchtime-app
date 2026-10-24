import { describe, expect, it } from "vitest";
import { GUEST_MEMBER_WHERE, ORDINARY_MEMBER_WHERE, guestSourceOf, isGuestMembership, partnerHomeClubOf } from "../guest-membership";

const member = { guestVia: null, guestFromOrgId: null, guestMatchId: null };
const partner = { guestVia: "partner", guestFromOrgId: "org-home", guestMatchId: "m1" };
const legacyPartner = { guestVia: null, guestFromOrgId: "org-home", guestMatchId: "m1" };
const pool = { guestVia: "pool", guestFromOrgId: null, guestMatchId: "m1" };

describe("guest-membership: one definition of a guest", () => {
  it("the where fragments read guestMatchId, never guestFromOrgId", () => {
    expect(ORDINARY_MEMBER_WHERE).toEqual({ guestMatchId: null });
    expect(GUEST_MEMBER_WHERE).toEqual({ guestMatchId: { not: null } });
  });

  it("an ordinary member is not a guest", () => {
    expect(isGuestMembership(member)).toBe(false);
    expect(guestSourceOf(member)).toBeNull();
    expect(isGuestMembership(null)).toBe(false);
    expect(guestSourceOf(undefined)).toBeNull();
  });

  it("a partner guest, with or without guestVia, is a partner guest", () => {
    for (const m of [partner, legacyPartner]) {
      expect(isGuestMembership(m)).toBe(true);
      expect(guestSourceOf(m)).toBe("partner");
    }
  });

  it("a pool guest (no home club) is a guest, and a pool one", () => {
    expect(isGuestMembership(pool)).toBe(true);
    expect(guestSourceOf(pool)).toBe("pool");
    // A caller that selected only guestMatchId still gets it right.
    expect(isGuestMembership({ guestMatchId: "m1" })).toBe(true);
    expect(guestSourceOf({ guestMatchId: "m1" })).toBe("pool");
  });

  it("a past pool guest (leftAt set) is still a guest row", () => {
    expect(isGuestMembership({ ...pool, leftAt: new Date() } as typeof pool)).toBe(true);
  });

  it("only a partner guest has a home club", () => {
    expect(partnerHomeClubOf(partner)).toBe("org-home");
    expect(partnerHomeClubOf(legacyPartner)).toBe("org-home");
    expect(partnerHomeClubOf(pool)).toBeNull();
    expect(partnerHomeClubOf(member)).toBeNull();
    expect(partnerHomeClubOf(null)).toBeNull();
  });
});

/**
 * Cross-club phone link (FNF incident 2026-10-18): the pure rules.
 *
 * An admin of club A types a phone number on one of A's players, and the
 * number already belongs to a MatchTime user who is NOT a member of A.
 * These rules decide whether MatchTime may offer to link the two (A's row
 * merged INTO the existing account) and what the admin may be shown.
 */
import { describe, expect, it } from "vitest";
import {
  decideCrossClubLink,
  firstNameOf,
  isPlaceholderEmail,
  type CrossClubLinkFacts,
} from "../cross-club-link-rules";

const A = "club-a";

function facts(over: {
  drop?: Partial<CrossClubLinkFacts["drop"]>;
  keep?: Partial<NonNullable<CrossClubLinkFacts["keep"]>> | null;
} = {}): CrossClubLinkFacts {
  return {
    orgId: A,
    drop: {
      id: "drop",
      membershipInOrg: { guestFromOrgId: null },
      otherClubMemberships: 0,
      rowsOutsideOrg: 0,
      hasOwnSignIn: false,
      ...over.drop,
    },
    keep:
      over.keep === null
        ? null
        : {
            id: "keep",
            name: "Habib Rahman",
            isSuperadmin: false,
            hasMembershipInOrg: false,
            clubNames: ["Sutton Football Club"],
            ...over.keep,
          },
  };
}

describe("decideCrossClubLink", () => {
  it("offers the link for a plain placeholder of club A and a member of another club only", () => {
    const v = decideCrossClubLink(facts());
    expect(v).toEqual({
      kind: "offer",
      firstName: "Habib",
      clubNames: ["Sutton Football Club"],
    });
  });

  it("is not a cross-club case when the number's owner is already in club A (same-club paths apply)", () => {
    expect(decideCrossClubLink(facts({ keep: { hasMembershipInOrg: true } }))).toEqual({ kind: "not-cross-club" });
  });

  it("is not a cross-club case when the number's owner belongs to no club at all", () => {
    expect(decideCrossClubLink(facts({ keep: { clubNames: [] } }))).toEqual({ kind: "not-cross-club" });
  });

  it("refuses when nobody holds the number any more", () => {
    expect(decideCrossClubLink(facts({ keep: null }))).toEqual({ kind: "refuse", reason: "keep_missing" });
  });

  it("refuses when both ids are the same user", () => {
    expect(decideCrossClubLink(facts({ keep: { id: "drop" } }))).toEqual({ kind: "refuse", reason: "same_user" });
  });

  it("refuses when club A's player is not a member of club A", () => {
    expect(decideCrossClubLink(facts({ drop: { membershipInOrg: null } }))).toEqual({
      kind: "refuse",
      reason: "drop_not_member",
    });
  });

  it("refuses a partner club's guest", () => {
    expect(decideCrossClubLink(facts({ drop: { membershipInOrg: { guestFromOrgId: "other" } } }))).toEqual({
      kind: "refuse",
      reason: "drop_guest",
    });
  });

  it("refuses when club A's player also belongs to another club (the merge would write that club)", () => {
    expect(decideCrossClubLink(facts({ drop: { otherClubMemberships: 1 } }))).toEqual({
      kind: "refuse",
      reason: "drop_other_clubs",
    });
  });

  it("refuses when club A's player has rows in another club's matches", () => {
    expect(decideCrossClubLink(facts({ drop: { rowsOutsideOrg: 3 } }))).toEqual({
      kind: "refuse",
      reason: "drop_other_clubs",
    });
  });

  it("refuses when club A's player has a sign in of their own (never graft a login onto another account)", () => {
    expect(decideCrossClubLink(facts({ drop: { hasOwnSignIn: true } }))).toEqual({
      kind: "refuse",
      reason: "drop_has_sign_in",
    });
  });

  it("refuses a platform superadmin's account", () => {
    expect(decideCrossClubLink(facts({ keep: { isSuperadmin: true } }))).toEqual({
      kind: "refuse",
      reason: "keep_superadmin",
    });
  });

  it("allows an existing account that is an admin of its own club (its role there is never touched)", () => {
    // Role is not an input at all: nothing about the kept account's other
    // club is read beyond the club's name.
    expect(decideCrossClubLink(facts()).kind).toBe("offer");
  });

  it("allows a different name, because the admin confirms explicitly", () => {
    const v = decideCrossClubLink(facts({ keep: { name: "Mohammed Habib" } }));
    expect(v).toEqual({ kind: "offer", firstName: "Mohammed", clubNames: ["Sutton Football Club"] });
  });

  it("dedupes club names and keeps their order", () => {
    const v = decideCrossClubLink(facts({ keep: { clubNames: ["B", "C", "B"] } }));
    expect(v.kind === "offer" && v.clubNames).toEqual(["B", "C"]);
  });
});

describe("firstNameOf", () => {
  it("shows only the first word of the name", () => {
    expect(firstNameOf("Habib Rahman")).toBe("Habib");
    expect(firstNameOf("  Ali   Veli ")).toBe("Ali");
  });
  it("is null for an empty name", () => {
    expect(firstNameOf(null)).toBeNull();
    expect(firstNameOf("   ")).toBeNull();
  });
});

describe("isPlaceholderEmail", () => {
  it("knows MatchTime's synthetic addresses", () => {
    expect(isPlaceholderEmail("manual-abc-123@placeholder.matchtime")).toBe(true);
    expect(isPlaceholderEmail("wa-447700900001@placeholder.matchtime")).toBe(true);
    expect(isPlaceholderEmail("wa-sync+player-x@matchtime.local")).toBe(true);
    expect(isPlaceholderEmail("provisional+habib-x@matchtime.local")).toBe(true);
    expect(isPlaceholderEmail(null)).toBe(true);
  });
  it("treats a real address as a real sign in", () => {
    expect(isPlaceholderEmail("habib@gmail.com")).toBe(false);
  });
});

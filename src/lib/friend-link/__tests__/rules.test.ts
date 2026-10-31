/**
 * THE FRIEND LINK'S PURE RULES (2026-10-31, MDs/friend-link-plan-2026-10-31.md).
 */
import { describe, expect, it } from "vitest";
import {
  FRIEND_LINK,
  decideThirdPartyIn,
  existingProfileOutcome,
  friendBookingRefusal,
  friendCodeExpiry,
  friendLinkState,
  friendShortName,
  newLinksAllowed,
  type ThirdPartyInFacts,
} from "../rules";

const base: ThirdPartyInFacts = {
  polarity: "in",
  personKind: "placeholder",
  personRef: "+1",
  resolution: "not-a-person",
  writtenInMessage: true,
  rawDigits: false,
  senderKnown: true,
  senderIsAdmin: false,
  attendanceOn: true,
  hasActiveMatch: true,
};
const d = (f: Partial<ThirdPartyInFacts>) => decideThirdPartyIn({ ...base, ...f });

describe("decideThirdPartyIn: who gets a friend link", () => {
  it("an unnamed friend from a player: a link with no name", () => {
    expect(d({})).toMatchObject({ kind: "friend_link", friendName: null });
    expect(d({ personKind: "relation", personRef: "my brother" })).toMatchObject({ kind: "friend_link", friendName: null });
  });
  it("a named friend nobody knows, written in the message: a link with his name", () => {
    expect(d({ personKind: "named", personRef: " Ali ", resolution: "unknown" })).toMatchObject({ kind: "friend_link", friendName: "Ali" });
  });
  it("a named friend the model invented (not written): today's path, which provisions nobody", () => {
    expect(d({ personKind: "named", personRef: "Ali", resolution: "unknown", writtenInMessage: false }).kind).toBe("today");
  });
  it("a member on the roster, or an ambiguous name: today's path", () => {
    expect(d({ personKind: "named", personRef: "Ali", resolution: "resolved" }).kind).toBe("today");
    expect(d({ personKind: "named", personRef: "Ali", resolution: "ambiguous" }).kind).toBe("today");
  });
  it("a group, a raw-digit mention, an OUT or a bench: today's path", () => {
    expect(d({ personKind: "group", personRef: "everyone" }).kind).toBe("today");
    expect(d({ rawDigits: true, personRef: "252012071493723" }).kind).toBe("today");
    expect(d({ polarity: "out" }).kind).toBe("today");
    expect(d({ polarity: "bench" }).kind).toBe("today");
  });
  it("an organiser keeps today's behaviour (D1)", () => {
    expect(d({ senderIsAdmin: true }).kind).toBe("today");
    expect(d({ senderIsAdmin: true, personKind: "named", personRef: "Ali", resolution: "unknown" }).kind).toBe("today");
  });
  it("no resolved sender, attendance off, or no match: nothing to link", () => {
    expect(d({ senderKnown: false }).kind).toBe("none");
    expect(d({ attendanceOn: false }).kind).toBe("none");
    expect(d({ hasActiveMatch: false }).kind).toBe("none");
  });
  it("every decision says why", () => {
    for (const f of [{}, { senderIsAdmin: true }, { hasActiveMatch: false }]) expect(d(f).reason).toMatch(/\S/);
  });
});

describe("friendLinkState", () => {
  const now = new Date("2026-11-02T18:00:00Z");
  const kickoff = new Date("2026-11-02T20:00:00Z");
  const s = (f: Partial<Parameters<typeof friendLinkState>[0]>) =>
    friendLinkState({ used: false, matchStatus: "UPCOMING", isHistorical: false, kickoff, now, ...f });
  it("open before kick-off on a live match", () => {
    expect(s({})).toBe("open");
    expect(s({ matchStatus: "TEAMS_GENERATED" })).toBe("open");
    expect(s({ matchStatus: "TEAMS_PUBLISHED" })).toBe("open");
  });
  it("used beats everything else", () => {
    expect(s({ used: true, matchStatus: "CANCELLED" })).toBe("used");
  });
  it("called off", () => {
    expect(s({ matchStatus: "CANCELLED" })).toBe("called-off");
  });
  it("started at exactly kick-off, after it, completed or historical", () => {
    expect(s({ now: kickoff })).toBe("started");
    expect(s({ now: new Date(kickoff.getTime() + 1) })).toBe("started");
    expect(s({ matchStatus: "COMPLETED" })).toBe("started");
    expect(s({ isHistorical: true })).toBe("started");
  });
  it("a moved match: the current kick-off decides", () => {
    expect(s({ kickoff: new Date("2026-11-03T20:00:00Z"), now: new Date("2026-11-02T21:00:00Z") })).toBe("open");
  });
});

describe("friendBookingRefusal", () => {
  const ok = { linkState: "open" as const, isIssuer: false, alreadyOnMatch: false, blocked: false, guestElsewhere: false };
  it("null when he may be booked", () => expect(friendBookingRefusal(ok)).toBeNull());
  it("the link's own state first", () => {
    expect(friendBookingRefusal({ ...ok, linkState: "used", isIssuer: true })).toBe("used");
    expect(friendBookingRefusal({ ...ok, linkState: "started" })).toBe("started");
    expect(friendBookingRefusal({ ...ok, linkState: "called-off" })).toBe("called-off");
  });
  it("then the member himself, already on the list, blocked, guest elsewhere", () => {
    expect(friendBookingRefusal({ ...ok, isIssuer: true })).toBe("issuer");
    expect(friendBookingRefusal({ ...ok, alreadyOnMatch: true })).toBe("already-on-match");
    expect(friendBookingRefusal({ ...ok, blocked: true })).toBe("blocked");
    expect(friendBookingRefusal({ ...ok, guestElsewhere: true })).toBe("elsewhere");
  });
});

describe("existingProfileOutcome (D6)", () => {
  it("active: booked, nothing changes", () => expect(existingProfileOutcome({ status: "active", pausedReason: null })).toEqual({ book: true, reactivate: false }));
  it("stopped: his code is fresh consent, booked and active again", () =>
    expect(existingProfileOutcome({ status: "stopped", pausedReason: null })).toEqual({ book: true, reactivate: true }));
  it("paused by himself, for ignoring offers or for no-shows: booked, pause kept", () => {
    for (const r of ["self", "ignored", "no-shows"]) expect(existingProfileOutcome({ status: "paused", pausedReason: r })).toEqual({ book: true, reactivate: false });
  });
  it("paused for reports or by the MatchTime team: not booked", () => {
    for (const r of ["reports", "admin"]) expect(existingProfileOutcome({ status: "paused", pausedReason: r })).toEqual({ book: false, reactivate: false });
  });
});

describe("caps, expiry and names", () => {
  it("three unused links per member per match (D3)", () => {
    expect(FRIEND_LINK.openLinksPerMemberPerMatch).toBe(3);
    expect(newLinksAllowed({ unusedOpen: 0, wanted: 2 })).toBe(2);
    expect(newLinksAllowed({ unusedOpen: 2, wanted: 2 })).toBe(1);
    expect(newLinksAllowed({ unusedOpen: 3, wanted: 1 })).toBe(0);
    expect(newLinksAllowed({ unusedOpen: 5, wanted: 1 })).toBe(0);
  });
  it("the code expires at kick-off when that is sooner than three days", () => {
    const now = new Date("2026-11-01T10:00:00Z");
    expect(friendCodeExpiry(now, new Date("2026-11-02T20:00:00Z")).toISOString()).toBe("2026-11-02T20:00:00.000Z");
    expect(friendCodeExpiry(now, new Date("2026-11-20T20:00:00Z")).toISOString()).toBe("2026-11-04T10:00:00.000Z");
  });
  it("first name and surname initial with a full stop", () => {
    expect(friendShortName("Ali Yilmaz")).toBe("Ali Y.");
    expect(friendShortName("Ali Y.")).toBe("Ali Y.");
    expect(friendShortName("Ali")).toBe("Ali");
    expect(friendShortName("  ali   veli yılmaz ")).toBe("ali Y.");
  });
});

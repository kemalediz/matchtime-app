/**
 * COMMUNITY GROUPS AND THE STRONGER ADD (2026-10-15): the PURE rules.
 *
 * The FNF incident (prod, 2026-10-15 18:31 UTC). The organiser's main chat
 * sits inside a WhatsApp community. Joining it put MatchTime into the
 * community's PARENT group and its ANNOUNCEMENTS group too, and the three
 * bot-added posts raced. The parent group's post (adder: MatchTime's OWN
 * number, the organiser in its roster) reached the server first and was
 * linked as "other-organiser-present"; the organiser's own add of the main
 * chat then lost the race. These rules are what stops each step of that.
 */
import { describe, expect, it } from "vitest";
import {
  UPGRADE_WINDOW_MS,
  communityRoleOf,
  decideWeakLinkUpgrade,
  ownerLinkCorrectionDmText,
  type AddEvidence,
  type UpgradeCandidate,
} from "../group-add-rules";

const NOW = new Date("2026-10-15T18:31:30Z");
const mins = (m: number) => new Date(NOW.getTime() + m * 60_000);

const MAIN = "447700900001-1596025435@g.us";
const PARENT = "120363700000000101@g.us";
const ORGANISER = "447700900970";
const ORGANISER_LID = "156345466617992";

const ev = (over: Partial<AddEvidence> = {}): AddEvidence => ({
  addedByPhone: ORGANISER,
  addedByLid: ORGANISER_LID,
  participants: [{ phone: ORGANISER, lid: null }],
  discovered: false,
  ...over,
});

const weak = (over: Partial<UpgradeCandidate> = {}): UpgradeCandidate => ({
  id: "cc-fnf",
  groupId: PARENT,
  status: "group_linked",
  botRemovedAt: null,
  adderMatch: "other-organiser-present",
  phone: ORGANISER,
  dmLid: ORGANISER_LID,
  orgApprovalStatus: "pending",
  linkedAt: mins(-0.1),
  ...over,
});

describe("communityRoleOf: what the Pi read of the group", () => {
  it("a community's parent group", () => {
    expect(communityRoleOf({ community: { isCommunity: true, isCommunityAnnounce: false, linkedParent: null } })).toBe("parent");
  });

  it("a community's announcements group, from the community facts or from the postability reading", () => {
    expect(communityRoleOf({ community: { isCommunity: false, isCommunityAnnounce: true, linkedParent: PARENT } })).toBe(
      "announce",
    );
    expect(
      communityRoleOf({ postability: { announce: true, communityAnnounce: true, botIsAdmin: false } }),
    ).toBe("announce");
    // MatchTime being an admin there does not make it a club's group.
    expect(communityRoleOf({ postability: { announce: true, communityAnnounce: true, botIsAdmin: true } })).toBe(
      "announce",
    );
  });

  it("a group inside a community (it has a parent) is an ordinary group", () => {
    expect(communityRoleOf({ community: { isCommunity: false, isCommunityAnnounce: false, linkedParent: PARENT } })).toBe(
      null,
    );
    expect(communityRoleOf({ postability: { announce: true, communityAnnounce: false, botIsAdmin: false } })).toBe(null);
  });

  it("no reading, or a malformed one, is no community role", () => {
    expect(communityRoleOf({})).toBe(null);
    expect(communityRoleOf({ community: "yes" })).toBe(null);
    expect(communityRoleOf({ community: { isCommunity: "true" } })).toBe(null);
    expect(communityRoleOf({ community: null, postability: { announce: true } })).toBe(null);
  });
});

describe("decideWeakLinkUpgrade: the organiser's own add beats a weaker link that arrived first", () => {
  it("THE FNF CASE: linked to the parent group as other-organiser-present, then the organiser's add of the main chat", () => {
    expect(decideWeakLinkUpgrade(ev(), MAIN, [weak()], NOW)).toEqual({
      upgrade: true,
      connectId: "cc-fnf",
      fromGroupId: PARENT,
      adderMatch: "phone",
    });
  });

  it("matched by the connect DM's LID when no phone came with the add", () => {
    expect(decideWeakLinkUpgrade(ev({ addedByPhone: null }), MAIN, [weak()], NOW)).toMatchObject({
      upgrade: true,
      adderMatch: "lid",
    });
  });

  it("an 'unknown' link is weak too", () => {
    expect(decideWeakLinkUpgrade(ev(), MAIN, [weak({ adderMatch: "unknown" })], NOW)).toMatchObject({ upgrade: true });
  });

  it("never moves a link the organiser made themselves (phone or LID)", () => {
    expect(decideWeakLinkUpgrade(ev(), MAIN, [weak({ adderMatch: "phone" })], NOW)).toEqual({
      upgrade: false,
      reason: "no-weak-link",
    });
    expect(decideWeakLinkUpgrade(ev(), MAIN, [weak({ adderMatch: "lid" })], NOW)).toEqual({
      upgrade: false,
      reason: "no-weak-link",
    });
  });

  it("only the organiser's add moves it: anybody else, no adder, or the reconnect sweep never do", () => {
    const stranger = ev({ addedByPhone: "447700900999", addedByLid: "158055467500999" });
    expect(decideWeakLinkUpgrade(stranger, MAIN, [weak()], NOW)).toEqual({ upgrade: false, reason: "adder-not-organiser" });
    expect(decideWeakLinkUpgrade(ev({ addedByPhone: null, addedByLid: null }), MAIN, [weak()], NOW)).toEqual({
      upgrade: false,
      reason: "adder-not-organiser",
    });
    expect(decideWeakLinkUpgrade(ev({ discovered: true }), MAIN, [weak()], NOW)).toEqual({
      upgrade: false,
      reason: "adder-not-organiser",
    });
  });

  it("only while the club waits: approved, rejected or draft clubs are never moved", () => {
    for (const s of ["approved", "rejected", "suspended", "draft"]) {
      expect(decideWeakLinkUpgrade(ev(), MAIN, [weak({ orgApprovalStatus: s })], NOW)).toEqual({
        upgrade: false,
        reason: "club-not-pending",
      });
    }
  });

  it("a link MatchTime was removed from, a closed request, or the same group is not upgraded", () => {
    expect(decideWeakLinkUpgrade(ev(), MAIN, [weak({ botRemovedAt: mins(-1) })], NOW).upgrade).toBe(false);
    expect(decideWeakLinkUpgrade(ev(), MAIN, [weak({ status: "closed" })], NOW).upgrade).toBe(false);
    expect(decideWeakLinkUpgrade(ev(), PARENT, [weak()], NOW).upgrade).toBe(false);
  });

  it("only inside the window after the weak link", () => {
    const old = weak({ linkedAt: new Date(NOW.getTime() - UPGRADE_WINDOW_MS) });
    expect(decideWeakLinkUpgrade(ev(), MAIN, [old], NOW)).toEqual({ upgrade: false, reason: "outside-window" });
    const recent = weak({ linkedAt: new Date(NOW.getTime() - UPGRADE_WINDOW_MS + 60_000) });
    expect(decideWeakLinkUpgrade(ev(), MAIN, [recent], NOW).upgrade).toBe(true);
  });

  it("of two weak links of the organiser, the newest", () => {
    const older = weak({ id: "cc-old", linkedAt: mins(-30) });
    const newer = weak({ id: "cc-new", linkedAt: mins(-1) });
    expect(decideWeakLinkUpgrade(ev(), MAIN, [older, newer], NOW)).toMatchObject({ connectId: "cc-new" });
  });
});

describe("ownerLinkCorrectionDmText: the owner never approves the wrong group", () => {
  it("names the club, the ref, the group now linked and the one it replaces, and how to answer", () => {
    const text = ownerLinkCorrectionDmText({
      club: "FNF",
      code: "UYS5",
      groupSubject: "Friday Night Football 🏟",
      memberCount: 49,
      previousSubject: "FNF ⚽️",
      previousMemberCount: 8,
      adderMatch: "phone",
    });
    expect(text).toBe(
      [
        `Correction: *FNF* (ref UYS5) is now linked to "Friday Night Football 🏟", 49 members.`,
        `It replaces "FNF ⚽️", 8 members, from my earlier message: that was not the club's group.`,
        "Added by: the organiser (matched by phone)",
        "Reply APPROVE UYS5 or REJECT UYS5, or use matchtime.ai/admin/clubs",
      ].join("\n"),
    );
    expect(text).not.toMatch(/[–—]/);
  });

  it("copes with a group with no name and no member list", () => {
    const text = ownerLinkCorrectionDmText({
      club: "FNF",
      code: "UYS5",
      groupSubject: null,
      memberCount: 0,
      previousSubject: null,
      previousMemberCount: null,
      adderMatch: "lid",
    });
    expect(text).toContain(`is now linked to (no name), member list not read.`);
    expect(text).toContain(`It replaces (no name), from my earlier message`);
    expect(text).toContain("matched by WhatsApp id");
  });
});

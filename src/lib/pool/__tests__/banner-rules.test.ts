/**
 * The one-line player pool banner on every signed-in page (2026-10-28):
 * which banner, if any. Every gate: the page, the club pool (platform AND
 * club flag), his pool status, his two dismissals (and their columns not
 * being there yet), the share link, and the admin line.
 */
import { describe, expect, it } from "vitest";
import { poolBannerFor, poolBannerPathShown, type PoolBannerFacts } from "../banner-rules";

const base: PoolBannerFacts = {
  dismissalsReadable: true,
  memberOfOpenClub: true,
  poolStatus: null,
  joinDismissedAt: null,
  shareDismissedAt: null,
  hasShareLink: false,
  adminOfOpenClubNotShared: false,
};
const at = new Date("2026-10-28T10:00:00Z");

describe("which banner", () => {
  it("a member of a club with the pool open, not in the pool: join", () => {
    expect(poolBannerFor(base)).toEqual({ kind: "join", adminLine: false });
  });

  it("a sign-up still waiting for its WhatsApp message counts as not in the pool yet", () => {
    expect(poolBannerFor({ ...base, poolStatus: "pending-verify" })).toEqual({ kind: "join", adminLine: false });
  });

  it("in the pool (active or paused) with a link: share", () => {
    for (const poolStatus of ["active", "paused"] as const) {
      expect(poolBannerFor({ ...base, poolStatus, hasShareLink: true })).toEqual({ kind: "share", adminLine: false });
    }
  });

  it("in the pool but no link could be made: nothing", () => {
    expect(poolBannerFor({ ...base, poolStatus: "active", hasShareLink: false })).toBeNull();
  });

  it("he left the pool (stopped): nothing, he is never asked again from here", () => {
    expect(poolBannerFor({ ...base, poolStatus: "stopped", hasShareLink: true })).toBeNull();
  });
});

describe("who never sees it", () => {
  it("not a member of any club with the pool open (pool off for his club, the platform off, a guest, a pool-only profile)", () => {
    expect(poolBannerFor({ ...base, memberOfOpenClub: false })).toBeNull();
    expect(poolBannerFor({ ...base, memberOfOpenClub: false, poolStatus: "active", hasShareLink: true })).toBeNull();
    expect(poolBannerFor({ ...base, memberOfOpenClub: false, adminOfOpenClubNotShared: true })).toBeNull();
  });

  it("the dismissal columns are not there yet (migration not applied): nothing", () => {
    expect(poolBannerFor({ ...base, dismissalsReadable: false })).toBeNull();
    expect(poolBannerFor({ ...base, dismissalsReadable: false, poolStatus: "active", hasShareLink: true })).toBeNull();
  });
});

describe("Not interested", () => {
  it("dismissing join hides join for good", () => {
    expect(poolBannerFor({ ...base, joinDismissedAt: at })).toBeNull();
  });

  it("dismissing join, then joining, still shows the share banner once", () => {
    expect(poolBannerFor({ ...base, joinDismissedAt: at, poolStatus: "active", hasShareLink: true })).toEqual({ kind: "share", adminLine: false });
  });

  it("dismissing share hides share for good", () => {
    expect(poolBannerFor({ ...base, shareDismissedAt: at, poolStatus: "active", hasShareLink: true })).toBeNull();
  });

  it("dismissing share does not hide join (he left and is pending again)", () => {
    expect(poolBannerFor({ ...base, shareDismissedAt: at, poolStatus: "pending-verify" })).toEqual({ kind: "join", adminLine: false });
  });
});

describe("the admin line", () => {
  it("an owner or admin of an open club that has not sent the post: the line rides on either banner", () => {
    expect(poolBannerFor({ ...base, adminOfOpenClubNotShared: true })).toEqual({ kind: "join", adminLine: true });
    expect(poolBannerFor({ ...base, adminOfOpenClubNotShared: true, poolStatus: "active", hasShareLink: true })).toEqual({ kind: "share", adminLine: true });
  });

  it("goes with the banner it rides on", () => {
    expect(poolBannerFor({ ...base, adminOfOpenClubNotShared: true, joinDismissedAt: at })).toBeNull();
  });
});

describe("which pages", () => {
  it("the signed-in app pages", () => {
    for (const p of ["/", "/profile", "/profile/stats", "/matches", "/matches/abc", "/admin", "/admin/settings", "/admin/players", "/month", "/partner-asks"]) {
      expect(poolBannerPathShown(p), p).toBe(true);
    }
  });

  it("never the public, pool, sign-in or setup pages", () => {
    for (const p of [
      null,
      "/play",
      "/play/manage",
      "/play/invitations",
      "/privacy",
      "/players",
      "/pricing",
      "/help",
      "/help/organisers",
      "/login",
      "/signup",
      "/verify-email",
      "/claim",
      "/welcome",
      "/r/abc",
      "/join/abc",
      "/onboarding",
      "/onboarding/x",
      "/create-org",
      "/finish-setup",
      "/pay/abc",
      "/collect/abc",
    ]) {
      expect(poolBannerPathShown(p), String(p)).toBe(false);
    }
  });
});

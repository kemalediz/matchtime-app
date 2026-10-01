/**
 * Unit tests for org LIFECYCLE — "does this club still exist?" — and the
 * fixture-generation rule that depends on it.
 *
 * The bug (2026-09-09): `/api/cron/generate-matches` filtered on
 * `Activity.isActive` and never looked at the organisation, so a club
 * that churned kept generating weekly fixtures forever. Sutton Lads
 * churned in June 2026 (MatchTime removed from the group after an
 * incident, org dormant, data retained on purpose) and was still being
 * handed a Thursday fixture in September — one surfaced in a status
 * report three months later.
 *
 * The signal is the EXPLICIT `Organisation.dormantAt` timestamp, not
 * `whatsappBotEnabled`. That flag is a MUTE switch: Kemal muted the very
 * much alive Sutton FC with it twice in the week before this fix while
 * doing engineering work, and fixtures kept generating — correctly.
 * Gating generation on it would mean a one-hour mute silently costs a
 * live club its next squad. `dormantAt` is set once, deliberately, by a
 * human who knows the club is gone; nothing else touches it.
 *
 * `Activity.isActive` is a DIFFERENT axis and keeps working exactly as
 * before: it is the per-fixture switch (a format switch leaves the old
 * format's Activity active on purpose — see match-slot.ts), while
 * `dormantAt` is the per-club one. Both are checked, because either
 * alone is wrong.
 *
 * Pure logic — no DB, no LLM, no clock. The route loads candidates and
 * delegates the decision here.
 */
import { describe, it, expect } from "vitest";
import {
  isOrgDormant,
  isOrgLive,
  LIVE_ORG_WHERE,
  fixtureSkipReason,
  partitionGeneratable,
  type FixtureCandidate,
} from "@/lib/org-lifecycle";

const CHURNED = new Date("2026-06-18T12:00:00Z"); // the day Sutton Lads went

const candidate = (over: Partial<FixtureCandidate> = {}): FixtureCandidate => ({
  isActive: true,
  org: { dormantAt: null, approvalStatus: "approved", billingStatus: "exempt" },
  ...over,
});

describe("isOrgDormant / isOrgLive", () => {
  it("a null dormantAt is a live club", () => {
    expect(isOrgDormant({ dormantAt: null })).toBe(false);
    expect(isOrgLive({ dormantAt: null })).toBe(true);
  });

  it("any dormantAt timestamp is a dormant club", () => {
    expect(isOrgDormant({ dormantAt: CHURNED })).toBe(true);
    expect(isOrgLive({ dormantAt: CHURNED })).toBe(false);
  });

  it("a future-dated dormantAt still counts as dormant — presence, not comparison", () => {
    // Deliberate: the field records THAT a human declared the club gone.
    // A clock comparison would add a second way to be wrong (server tz,
    // a typo'd year) for no gain — nothing schedules dormancy ahead.
    expect(isOrgDormant({ dormantAt: new Date("2099-01-01T00:00:00Z") })).toBe(true);
  });

  it("LIVE_ORG_WHERE is the one prisma fragment for 'the club still exists'", () => {
    expect(LIVE_ORG_WHERE).toEqual({ dormantAt: null });
  });
});

describe("fixtureSkipReason", () => {
  it("a live org's active activity generates", () => {
    expect(fixtureSkipReason(candidate())).toBeNull();
  });

  it("a dormant org's active activity does NOT generate", () => {
    expect(fixtureSkipReason(candidate({ org: { dormantAt: CHURNED, approvalStatus: "approved", billingStatus: "exempt" } }))).toBe("org-dormant");
  });

  it("a MUTED but live org still generates — muting is not churn", () => {
    // The regression that matters most. Mute is `whatsappBotEnabled`,
    // which this rule deliberately cannot see; the only way to be
    // skipped is `dormantAt`.
    expect(fixtureSkipReason(candidate({ org: { dormantAt: null, approvalStatus: "approved", billingStatus: "exempt" } }))).toBeNull();
  });

  it("an inactive activity in a live org does NOT generate — unchanged behaviour", () => {
    expect(fixtureSkipReason(candidate({ isActive: false }))).toBe("activity-inactive");
  });

  it("an unapproved club's active activity does NOT generate (self-join slice 1)", () => {
    for (const approvalStatus of ["draft", "pending", "rejected", "suspended"]) {
      expect(fixtureSkipReason(candidate({ org: { dormantAt: null, approvalStatus, billingStatus: "exempt" } }))).toBe("org-not-approved");
    }
  });

  it("Sutton FC's shape (approved by the migration default, live) still generates", () => {
    expect(fixtureSkipReason(candidate({ org: { dormantAt: null, approvalStatus: "approved", billingStatus: "exempt" } }))).toBeNull();
  });

  it("dormancy is reported before approval: the club being gone is the bigger fact", () => {
    expect(fixtureSkipReason(candidate({ org: { dormantAt: CHURNED, approvalStatus: "suspended", billingStatus: "exempt" } }))).toBe(
      "org-dormant",
    );
  });

  it("reports the org, not the activity, when both are off", () => {
    // The club being gone is the bigger fact and the one worth counting.
    expect(
      fixtureSkipReason(candidate({ isActive: false, org: { dormantAt: CHURNED, approvalStatus: "approved", billingStatus: "exempt" } })),
    ).toBe("org-dormant");
  });
});

describe("partitionGeneratable", () => {
  const live = { id: "sutton-fc", ...candidate() };
  const muted = { id: "sutton-fc-muted", ...candidate() };
  const dormant = { id: "sutton-lads", ...candidate({ org: { dormantAt: CHURNED, approvalStatus: "approved", billingStatus: "exempt" } }) };
  const inactive = { id: "old-7aside-format", ...candidate({ isActive: false }) };

  it("splits generatable from skipped and keeps the reason for each skip", () => {
    const out = partitionGeneratable([live, dormant, inactive, muted]);
    expect(out.generate.map((a) => a.id)).toEqual(["sutton-fc", "sutton-fc-muted"]);
    expect(out.skipped).toEqual([
      { item: dormant, reason: "org-dormant" },
      { item: inactive, reason: "activity-inactive" },
    ]);
  });

  it("counts dormant-org skips separately so the cron can report them", () => {
    const out = partitionGeneratable([live, dormant, dormant, inactive]);
    expect(out.skippedDormantOrgs).toBe(2);
  });

  it("counts unapproved-org skips separately too", () => {
    const pending = { id: "self-join-pending", ...candidate({ org: { dormantAt: null, approvalStatus: "pending", billingStatus: "exempt" } }) };
    const out = partitionGeneratable([live, pending, dormant]);
    expect(out.generate.map((a) => a.id)).toEqual(["sutton-fc"]);
    expect(out.skippedNotApprovedOrgs).toBe(1);
    expect(out.skippedDormantOrgs).toBe(1);
  });

  it("an empty list is not an error", () => {
    const out = partitionGeneratable([]);
    expect(out.generate).toEqual([]);
    expect(out.skipped).toEqual([]);
    expect(out.skippedDormantOrgs).toBe(0);
  });
});

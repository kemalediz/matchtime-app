/**
 * THE FREE PERIOD GROWS FOR CLUBS ALREADY IN IT (Kemal, 2026-10-28: "make
 * the trial 3 months everywhere").
 *
 * `ClubBilling.trialEndsAt` is STORED when a free period starts, so a club
 * that started on the two month length keeps two months unless its row is
 * moved. `extendedFreePeriodEnd` decides, for one club, the new end: the
 * current length (`FREE_PERIOD_MONTHS`) counted from the same start, and
 * only for a club still inside its free period that was never billed.
 * Never earlier, never for a free period that is over, never for a club
 * that has a billing month.
 */
import { describe, expect, it } from "vitest";
import { FREE_PERIOD_MONTHS, extendedFreePeriodEnd, freePeriodEnd } from "../club-billing-rules";

// FNF's real row (prod, read 2026-10-28): live 15 Oct 21:12 UTC, two months to 15 Dec 22:12 UTC.
const START = new Date("2026-10-15T21:12:40.497Z");
const TWO_MONTH_END = new Date("2026-12-15T22:12:40.497Z");
const NOW = new Date("2026-10-28T12:00:00Z");

const club = (over: Partial<Parameters<typeof extendedFreePeriodEnd>[0]> = {}) => ({
  trialStartedAt: START,
  trialEndsAt: TWO_MONTH_END,
  billingMonths: 0,
  ...over,
});

describe("extendedFreePeriodEnd", () => {
  it("the stored two month end is what freePeriodEnd gave for two months", () => {
    expect(freePeriodEnd(START, 2)).toEqual(TWO_MONTH_END);
  });

  it("a club inside its two month free period gets three months from the same start", () => {
    expect(FREE_PERIOD_MONTHS).toBe(3);
    const to = extendedFreePeriodEnd(club(), NOW);
    expect(to).toEqual(freePeriodEnd(START, 3));
    // 22:12 BST on 15 Oct to 22:12 GMT on 15 Jan.
    expect(to!.toISOString()).toBe("2027-01-15T22:12:40.497Z");
  });

  it("the other two prod clubs: Friday MT Community and MT Test", () => {
    expect(
      extendedFreePeriodEnd(
        club({ trialStartedAt: new Date("2026-10-14T09:33:39.200Z"), trialEndsAt: new Date("2026-12-14T10:33:39.200Z") }),
        NOW,
      )!.toISOString(),
    ).toBe("2027-01-14T10:33:39.200Z");
    expect(
      extendedFreePeriodEnd(
        club({ trialStartedAt: new Date("2026-10-21T06:46:26.151Z"), trialEndsAt: new Date("2026-12-21T07:46:26.151Z") }),
        NOW,
      )!.toISOString(),
    ).toBe("2027-01-21T07:46:26.151Z");
  });

  it("one millisecond before the old end: still extended", () => {
    expect(extendedFreePeriodEnd(club(), new Date(TWO_MONTH_END.getTime() - 1))).not.toBeNull();
  });

  it("a free period that is over (at or after its end) is left alone", () => {
    expect(extendedFreePeriodEnd(club(), TWO_MONTH_END)).toBeNull();
    expect(extendedFreePeriodEnd(club(), new Date("2027-01-01T00:00:00Z"))).toBeNull();
  });

  it("a club with any billing month is left alone (it has been billed, or a month is open)", () => {
    expect(extendedFreePeriodEnd(club({ billingMonths: 1 }), NOW)).toBeNull();
  });

  it("a club already on three months (or longer) is left alone: never moved, never shortened", () => {
    expect(extendedFreePeriodEnd(club({ trialEndsAt: freePeriodEnd(START, 3) }), NOW)).toBeNull();
    expect(extendedFreePeriodEnd(club({ trialEndsAt: freePeriodEnd(START, 4) }), NOW)).toBeNull();
  });

  it("is idempotent: the extended row needs nothing more", () => {
    const to = extendedFreePeriodEnd(club(), NOW)!;
    expect(extendedFreePeriodEnd(club({ trialEndsAt: to }), NOW)).toBeNull();
  });
});

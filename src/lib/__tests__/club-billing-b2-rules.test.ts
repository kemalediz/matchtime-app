/**
 * CLUB FEE BILLING, slice B2: the pure rules behind the pages.
 * Plan: MDs/club-fee-billing-plan-2026-10-01.md, sections 4.5, 7.2, 8.3, 15 (9, 13, 15, 16).
 *
 *   - `clubFeeTip`: the club fee tip's numbers (7.2 table, rounding up to
 *     the next 5p, 4 games per weekly slot, the example fee).
 *   - `parsePlanChoice`: the platform owner's plan control (Standard,
 *     Free, Custom GBP 1.00 to GBP 9.99).
 *   - `billingAccessRole`: who may open /billing/[orgId] and as what.
 *
 * No database, no clock, no model.
 */
import { describe, expect, it } from "vitest";
import {
  CUSTOM_PRICE_MAX_PENCE,
  CUSTOM_PRICE_MIN_PENCE,
  EXAMPLE_FEE_PENCE,
  STANDARD_PRICE_PENCE,
  billingAccessRole,
  billingTotals,
  clubFeeTip,
  parsePlanChoice,
  planPricePence,
  startTrialRefusal,
  type BillingAccessInput,
  type TipActivity,
} from "@/lib/club-billing-rules";

function act(over: Partial<TipActivity> = {}): TipActivity {
  return {
    dayOfWeek: 2,
    time: "20:00",
    playersPerTeam: 5,
    feePerPlayer: null,
    feeSplitTotal: false,
    latestMatchFee: null,
    ...over,
  };
}

const billed = { status: "trial", plan: "standard", pricePence: null } as const;

describe("planPricePence", () => {
  it("Standard is GBP 9.99, Custom its own price, Free nothing", () => {
    expect(STANDARD_PRICE_PENCE).toBe(999);
    expect(planPricePence("standard", null)).toBe(999);
    expect(planPricePence("custom", 500)).toBe(500);
    expect(planPricePence("free", null)).toBeNull();
    // A custom row without a price cannot exist (CHECK), but never guess one.
    expect(planPricePence("custom", null)).toBeNull();
  });
});

describe("clubFeeTip: the numbers (7.2)", () => {
  it("5-a-side, GBP 9.99: 10 players, 4 games, 24.98p rounds up to 25p; GBP 8 example charges GBP 8.25", () => {
    const tip = clubFeeTip({ ...billed, activities: [act({ playersPerTeam: 5 })] });
    expect(tip).toMatchObject({
      pricePence: 999,
      perSide: 5,
      players: 10,
      games: 4,
      sharePence: 25,
      feePence: 800,
      feePlusPence: 825,
      feeSource: "example",
      split: false,
    });
  });

  it("7-a-side, GBP 9.99: 14 players, 17.84p rounds up to 20p", () => {
    const tip = clubFeeTip({ ...billed, activities: [act({ playersPerTeam: 7, feePerPlayer: 7 })] });
    expect(tip).toMatchObject({ players: 14, games: 4, sharePence: 20, feePence: 700, feePlusPence: 720, feeSource: "own" });
  });

  it("8-a-side, GBP 9.99: 16 players, 15.6p rounds up to 20p", () => {
    const tip = clubFeeTip({ ...billed, activities: [act({ playersPerTeam: 8 })] });
    expect(tip).toMatchObject({ players: 16, sharePence: 20 });
  });

  it("9-a-side, GBP 9.99: 18 players, 13.88p rounds up to 15p; GBP 6 game charges GBP 6.15", () => {
    const tip = clubFeeTip({ ...billed, activities: [act({ playersPerTeam: 9, feePerPlayer: 6 })] });
    expect(tip).toMatchObject({ players: 18, sharePence: 15, feePence: 600, feePlusPence: 615 });
  });

  it("Custom GBP 5 on a 5-a-side: 12.5p rounds up to 15p; GBP 8 charges GBP 8.15", () => {
    const tip = clubFeeTip({ status: "trial", plan: "custom", pricePence: 500, activities: [act()] });
    expect(tip).toMatchObject({ pricePence: 500, sharePence: 15, feePlusPence: 815 });
  });

  it("an exact multiple of 5p is not rounded past itself (GBP 10 over 40 player-games is 25p)", () => {
    const tip = clubFeeTip({ status: "trial", plan: "custom", pricePence: 999, activities: [act()] });
    expect(tip?.sharePence).toBe(25);
    // 600p over 4 x 2 x 15 = 120 player-games is exactly 5p.
    const big = clubFeeTip({ status: "trial", plan: "custom", pricePence: 600, activities: [act({ playersPerTeam: 15 })] });
    expect(big?.sharePence).toBe(5);
  });

  it("never below 5p, however many players", () => {
    const tip = clubFeeTip({
      status: "trial",
      plan: "custom",
      pricePence: 100,
      activities: [act({ playersPerTeam: 11 }), act({ dayOfWeek: 4, playersPerTeam: 11 })],
    });
    expect(tip?.sharePence).toBe(5);
  });

  it("two weekly games are summed: Tue 5-a-side and Thu 7-a-side is 4 x 10 + 4 x 14 = 96 player-games", () => {
    const tip = clubFeeTip({
      ...billed,
      activities: [act({ dayOfWeek: 2, playersPerTeam: 5 }), act({ dayOfWeek: 4, playersPerTeam: 7 })],
    });
    // 999 / 96 = 10.4p, up to 15p.
    expect(tip).toMatchObject({ games: 8, sharePence: 15 });
  });

  it("a format-switch pair on the same evening (within 90 minutes) counts once", () => {
    const tip = clubFeeTip({
      ...billed,
      activities: [act({ time: "20:00", playersPerTeam: 7 }), act({ time: "21:00", playersPerTeam: 5 })],
    });
    expect(tip).toMatchObject({ games: 4 });
  });

  it("two games on the same day far apart are two slots", () => {
    const tip = clubFeeTip({ ...billed, activities: [act({ time: "10:00" }), act({ time: "20:00" })] });
    expect(tip).toMatchObject({ games: 8 });
  });

  it("no active activity still reads as 4 games, using the fallback players per side", () => {
    expect(clubFeeTip({ ...billed, activities: [] })).toMatchObject({ games: 4, players: 10, perSide: 5 });
    expect(clubFeeTip({ ...billed, activities: [], fallbackPlayersPerTeam: 7 })).toMatchObject({ players: 14 });
  });

  it("example fee: own fee, else the latest match fee, else GBP 8", () => {
    expect(EXAMPLE_FEE_PENCE).toBe(800);
    expect(clubFeeTip({ ...billed, activities: [act({ feePerPlayer: 6.5, latestMatchFee: 9 })] })).toMatchObject({
      feePence: 650,
      feeSource: "own",
    });
    expect(clubFeeTip({ ...billed, activities: [act({ latestMatchFee: 9 })] })).toMatchObject({
      feePence: 900,
      feeSource: "latest-match",
    });
    expect(clubFeeTip({ ...billed, activities: [act()] })).toMatchObject({ feePence: 800, feeSource: "example" });
  });

  it("a club that splits the pitch cost gets the split wording flag", () => {
    expect(clubFeeTip({ ...billed, activities: [act({ feeSplitTotal: true })] })).toMatchObject({ split: true });
  });

  it("no tip for Free or exempt (nothing to cover)", () => {
    expect(clubFeeTip({ status: "exempt", plan: "standard", pricePence: null, activities: [act()] })).toBeNull();
    expect(clubFeeTip({ status: "exempt", plan: "free", pricePence: null, activities: [act()] })).toBeNull();
  });

  it("a tip in every billed state", () => {
    for (const status of ["trial", "grace", "subscribed", "past_due", "paused"]) {
      expect(clubFeeTip({ status, plan: "standard", pricePence: null, activities: [act()] })).not.toBeNull();
    }
  });
});

describe("parsePlanChoice: the platform owner's plan control", () => {
  it("Standard and Free carry no price", () => {
    expect(parsePlanChoice({ plan: "standard" })).toEqual({ ok: true, plan: "standard", pricePence: null });
    expect(parsePlanChoice({ plan: "free", price: "5" })).toEqual({ ok: true, plan: "free", pricePence: null });
  });

  it("Custom takes pounds and pence, GBP 1.00 to GBP 9.99", () => {
    expect(CUSTOM_PRICE_MIN_PENCE).toBe(100);
    expect(CUSTOM_PRICE_MAX_PENCE).toBe(999);
    expect(parsePlanChoice({ plan: "custom", price: "5" })).toEqual({ ok: true, plan: "custom", pricePence: 500 });
    expect(parsePlanChoice({ plan: "custom", price: "£5.50" })).toEqual({ ok: true, plan: "custom", pricePence: 550 });
    expect(parsePlanChoice({ plan: "custom", price: " 1.00 " })).toEqual({ ok: true, plan: "custom", pricePence: 100 });
    expect(parsePlanChoice({ plan: "custom", price: "9.99" })).toEqual({ ok: true, plan: "custom", pricePence: 999 });
  });

  it("Custom outside the range, or not a price, is refused", () => {
    for (const price of ["0.99", "10", "10.00", "0", "-5", "abc", "", "5.555", "5.5.5", undefined]) {
      expect(parsePlanChoice({ plan: "custom", price })).toMatchObject({ ok: false });
    }
  });

  it("an unknown plan is refused", () => {
    expect(parsePlanChoice({ plan: "gold" })).toMatchObject({ ok: false });
  });
});

describe("billingAccessRole: who opens /billing/[orgId] (4.5)", () => {
  const base: BillingAccessInput = {
    userId: "u1",
    flagOn: true,
    status: "trial",
    isSuperadmin: false,
    membership: { role: "PLAYER", leftAt: null },
    contactUserId: null,
    cardHolderUserId: null,
  };
  const role = (over: Partial<BillingAccessInput>) => billingAccessRole({ ...base, ...over });

  it("the billing contact (a PLAYER collector) gets the full page", () => {
    expect(role({ contactUserId: "u1" })).toBe("contact");
  });

  it("the contact who is also the card holder is the contact", () => {
    expect(role({ contactUserId: "u1", cardHolderUserId: "u1" })).toBe("contact");
  });

  it("an old card holder who is no longer the contact gets the remove-my-card view", () => {
    expect(role({ contactUserId: "u2", cardHolderUserId: "u1" })).toBe("card-holder");
  });

  it("an OWNER or ADMIN who is not the contact reads only", () => {
    expect(role({ contactUserId: "u2", membership: { role: "OWNER", leftAt: null } })).toBe("viewer");
    expect(role({ contactUserId: "u2", membership: { role: "ADMIN", leftAt: null } })).toBe("viewer");
  });

  it("the platform superadmin reads only", () => {
    expect(role({ contactUserId: "u2", isSuperadmin: true, membership: null })).toBe("viewer");
  });

  it("a plain player who is neither is refused", () => {
    expect(role({ contactUserId: "u2" })).toBeNull();
  });

  it("a non-member is refused", () => {
    expect(role({ contactUserId: "u2", membership: null })).toBeNull();
  });

  it("a former admin is refused", () => {
    expect(role({ contactUserId: "u2", membership: { role: "ADMIN", leftAt: new Date() } })).toBeNull();
  });

  it("flag off: nobody, not even the contact or the superadmin", () => {
    expect(role({ flagOn: false, contactUserId: "u1" })).toBeNull();
    expect(role({ flagOn: false, isSuperadmin: true })).toBeNull();
    expect(role({ flagOn: false, status: "exempt", membership: { role: "OWNER", leftAt: null } })).toBeNull();
  });

  it("an exempt club (Sutton FC's shape): only the owner sees the exempt label, nobody gets a billing view", () => {
    expect(role({ status: "exempt", membership: { role: "OWNER", leftAt: null } })).toBe("exempt-owner");
    expect(role({ status: "exempt", isSuperadmin: true, membership: null })).toBe("exempt-owner");
    expect(role({ status: "exempt", membership: { role: "ADMIN", leftAt: null } })).toBeNull();
    // The money collector of an exempt club (Elvin at Sutton) sees nothing.
    expect(role({ status: "exempt", contactUserId: "u1" })).toBeNull();
    expect(role({ status: "exempt", membership: { role: "OWNER", leftAt: new Date() } })).toBeNull();
  });
});

describe("startTrialRefusal", () => {
  const ok = { approvedAt: new Date(), billingStatus: "exempt", billingPlan: "standard", hadFreeMonth: false };
  const on = { BILLING_ENABLED: "1" };
  it("an exempt self-join club with no free month, flag on: allowed", () => {
    expect(startTrialRefusal(ok, on)).toBeNull();
  });
  it("each refusal", () => {
    expect(startTrialRefusal({ ...ok, approvedAt: null }, on)).toBe("not-self-join");
    expect(startTrialRefusal(ok, {})).toBe("flag-off");
    expect(startTrialRefusal({ ...ok, billingStatus: "trial" }, on)).toBe("not-exempt");
    expect(startTrialRefusal({ ...ok, hadFreeMonth: true }, on)).toBe("had-free-month");
    expect(startTrialRefusal({ ...ok, billingPlan: "free" }, on)).toBe("plan-free");
  });
});

describe("billingTotals: the owner page's totals line", () => {
  it("paying clubs and their monthly total at current prices; the other states counted", () => {
    expect(
      billingTotals([
        { status: "subscribed", plan: "standard", pricePence: null },
        { status: "subscribed", plan: "custom", pricePence: 500 },
        { status: "trial", plan: "standard", pricePence: null },
        { status: "grace", plan: "standard", pricePence: null },
        { status: "past_due", plan: "standard", pricePence: null },
        { status: "paused", plan: "standard", pricePence: null },
        { status: "exempt", plan: "free", pricePence: null },
      ]),
    ).toEqual({ paying: 2, monthlyPence: 1499, trial: 1, grace: 1, pastDue: 1, paused: 1 });
  });
});

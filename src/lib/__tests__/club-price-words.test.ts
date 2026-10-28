/**
 * THE STANDARD PRICE, IN WORDS (Kemal, 2026-10-28: "Reduce the price to
 * 4.99"). Every page and message that states the price, or a number worked
 * out from it, reads club-price-words.ts, which reads STANDARD_PRICE_PENCE.
 * A page that types the price itself fails `no-stale-price-copy.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { STANDARD_PRICE_PENCE } from "../club-billing-rules";
import {
  CUSTOM_PRICE_RANGE_LABEL,
  STANDARD_PER_GAME_MAX_LABEL,
  STANDARD_PRICE_LABEL,
  moneyLabel,
  standardMonthSharedLabel,
  standardPerPlayerPerGameLabel,
  standardWeeksPlayedLabel,
} from "../club-price-words";
import { moneyLabel as viewMoneyLabel } from "../club-billing-view";

describe("the standard price, in words", () => {
  it("is GBP 4.99", () => {
    expect(STANDARD_PRICE_PENCE).toBe(499);
    expect(STANDARD_PRICE_LABEL).toBe("£4.99");
  });

  it("the custom range the owner may type: GBP 1.00 up to the standard price", () => {
    expect(CUSTOM_PRICE_RANGE_LABEL).toBe("between £1.00 and £4.99");
  });

  it("3 weeks out of 4 is GBP 3.74 (the month fee, floored to the penny)", () => {
    expect(standardWeeksPlayedLabel(3, 4)).toBe("£3.74");
    expect(standardWeeksPlayedLabel(4, 4)).toBe("£4.99");
  });

  it("a game played costs the club at most GBP 1.25 (GBP 4.99 over four weeks, rounded up)", () => {
    expect(STANDARD_PER_GAME_MAX_LABEL).toBe("£1.25");
  });

  it("with 10 players that is at most 13p a player per game; a month shared by 20 is about 25p", () => {
    expect(standardPerPlayerPerGameLabel(10)).toBe("13p");
    expect(standardMonthSharedLabel(20)).toBe("25p");
  });

  it("moneyLabel is the one the billing views use", () => {
    expect(viewMoneyLabel).toBe(moneyLabel);
    expect(moneyLabel(499)).toBe("£4.99");
    expect(moneyLabel(500)).toBe("£5");
  });
});

import { describe, it, expect, afterEach } from "vitest";
import { aiAllowanceUsd, isAiCapDisabled, UNCAPPED_USD, NEW_CLUB_CAP_USD } from "../ai-budget";

const now = new Date("2026-09-30T12:00:00Z");
const live = {
  createdAt: new Date("2026-09-30T10:00:00Z"),
  aiDailyCapUsd: null,
  aiWindowStartAt: null,
  whatsappBotEnabled: true,
  whatsappGroupId: "123@g.us",
  approvalStatus: "approved",
  approvedAt: null,
};

afterEach(() => {
  delete process.env.AI_DAILY_CAP_DISABLED;
});

describe("AI_DAILY_CAP_DISABLED (Kemal, 2026-09-30)", () => {
  it("reads the switch", () => {
    expect(isAiCapDisabled({ AI_DAILY_CAP_DISABLED: "1" })).toBe(true);
    expect(isAiCapDisabled({})).toBe(false);
  });
  it("off by default: a new club keeps its 25p", () => {
    expect(aiAllowanceUsd(live as never, now)).toBe(NEW_CLUB_CAP_USD);
  });
  it("on: a live club and pre-club setup spend without a daily limit, even with an override", () => {
    process.env.AI_DAILY_CAP_DISABLED = "1";
    expect(aiAllowanceUsd(live as never, now)).toBe(UNCAPPED_USD);
    expect(aiAllowanceUsd({ ...live, aiDailyCapUsd: 1.5 } as never, now)).toBe(UNCAPPED_USD);
    expect(aiAllowanceUsd(null, now)).toBe(UNCAPPED_USD);
  });
  it("on: the anti-abuse $0 rules still hold", () => {
    process.env.AI_DAILY_CAP_DISABLED = "1";
    expect(aiAllowanceUsd({ ...live, approvalStatus: "pending" } as never, now)).toBe(0);
    expect(aiAllowanceUsd({ ...live, whatsappBotEnabled: false } as never, now)).toBe(0);
  });
});

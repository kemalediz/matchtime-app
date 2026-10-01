/**
 * The unpaid follow-ups, pure (2026-10-01): the unpaid computation the
 * 17:00 tail has always used, lifted out so the admin unpaid list (U1 of
 * MDs/friday-group-features-plan-2026-09-30.md, 2.12) and the standalone
 * group reminder for weekly-deadline clubs use exactly the same rule, and
 * the time window both of them share.
 */
import { describe, it, expect, vi } from "vitest";

// The lookback constant lives in the scheduler, which imports Prisma.
vi.mock("@/lib/db", () => ({ db: {} }));
import {
  summariseUnpaid,
  unpaidFollowUpAt,
  unpaidFollowUpDue,
  UNPAID_FOLLOW_UP_RETRY_DAYS,
} from "../unpaid-rules";
import { POST_MATCH_LOOKBACK_DAYS } from "../bot-scheduler";

const row = (userId: string, paid: boolean, name: string | null = userId) => ({
  userId,
  paidAt: paid ? new Date("2027-01-15T22:00:00.000Z") : null,
  name,
});

describe("summariseUnpaid: the group tail's rule", () => {
  it("counts the unpaid, the paid and everyone, and names the unpaid in order", () => {
    const s = summariseUnpaid({
      confirmed: [row("a", true), row("b", false, "Bea"), row("c", true), row("d", false, "Dan")],
      payerId: null,
      creditCount: 0,
    });
    expect(s).toEqual({ n: 4, paid: 2, unpaid: 2, unpaidNames: ["Bea", "Dan"] });
  });

  it("leaves the payment holder out: he collects, he does not owe", () => {
    const s = summariseUnpaid({
      confirmed: [row("holder", false), row("b", false, "Bea"), row("c", true)],
      payerId: "holder",
      creditCount: 0,
    });
    expect(s).toEqual({ n: 2, paid: 1, unpaid: 1, unpaidNames: ["Bea"] });
  });

  it("subtracts bulk credits from the unpaid count", () => {
    const s = summariseUnpaid({
      confirmed: [row("a", true), row("b", false), row("c", false), row("d", false)],
      payerId: null,
      creditCount: 2,
    });
    expect(s?.unpaid).toBe(1);
    expect(s?.paid).toBe(3);
    expect(s?.n).toBe(4);
  });

  it("no signal (nobody paid, no credit): null, silence over false precision", () => {
    expect(
      summariseUnpaid({ confirmed: [row("a", false), row("b", false)], payerId: null, creditCount: 0 }),
    ).toBeNull();
  });

  it("everyone paid, or credits cover the rest: null", () => {
    expect(summariseUnpaid({ confirmed: [row("a", true), row("b", true)], payerId: null, creditCount: 0 })).toBeNull();
    expect(summariseUnpaid({ confirmed: [row("a", true), row("b", false)], payerId: null, creditCount: 3 })).toBeNull();
  });

  it("credits alone are a signal", () => {
    const s = summariseUnpaid({
      confirmed: [row("a", false), row("b", false), row("c", false)],
      payerId: null,
      creditCount: 1,
    });
    expect(s).toMatchObject({ unpaid: 2, paid: 1, n: 3 });
  });
});

describe("the follow-up time: 10:00 London two days after the match", () => {
  it("a Friday 20:30 GMT match: Sunday 10:00 GMT", () => {
    expect(unpaidFollowUpAt(new Date("2027-01-15T20:30:00.000Z")).toISOString()).toBe("2027-01-17T10:00:00.000Z");
  });

  it("BST: a Friday 20:30 London match is Sunday 09:00 UTC", () => {
    expect(unpaidFollowUpAt(new Date("2026-10-09T19:30:00.000Z")).toISOString()).toBe("2026-10-11T09:00:00.000Z");
  });

  it("a match just after midnight London counts from its London date, not its UTC date", () => {
    // 8 Oct 2026 23:30 UTC is Fri 9 Oct 00:30 in London (BST): the 9th
    // counts, so the follow-up is Sun 11 Oct, not Sat 10 Oct.
    expect(unpaidFollowUpAt(new Date("2026-10-08T23:30:00.000Z")).toISOString()).toBe("2026-10-11T09:00:00.000Z");
  });

  it("due from 10:00, not before", () => {
    const kickoff = new Date("2027-01-15T20:30:00.000Z");
    expect(unpaidFollowUpDue(new Date("2027-01-17T09:59:00.000Z"), kickoff)).toBe(false);
    expect(unpaidFollowUpDue(new Date("2027-01-17T10:05:00.000Z"), kickoff)).toBe(true);
  });

  it("civil hours only: never 21:00 to 09:59, and retried on the following days", () => {
    const kickoff = new Date("2027-01-15T20:30:00.000Z");
    expect(unpaidFollowUpDue(new Date("2027-01-17T20:59:00.000Z"), kickoff)).toBe(true);
    expect(unpaidFollowUpDue(new Date("2027-01-17T21:00:00.000Z"), kickoff)).toBe(false);
    expect(unpaidFollowUpDue(new Date("2027-01-18T08:00:00.000Z"), kickoff)).toBe(false);
    expect(unpaidFollowUpDue(new Date("2027-01-18T10:00:00.000Z"), kickoff)).toBe(true);
  });

  it(`gives up after ${UNPAID_FOLLOW_UP_RETRY_DAYS} days of retry`, () => {
    const kickoff = new Date("2027-01-15T20:30:00.000Z");
    const last = new Date(unpaidFollowUpAt(kickoff).getTime() + (UNPAID_FOLLOW_UP_RETRY_DAYS - 1) * 86_400_000);
    expect(unpaidFollowUpDue(last, kickoff)).toBe(true);
    expect(unpaidFollowUpDue(new Date(last.getTime() + 86_400_000), kickoff)).toBe(false);
  });

  it("the whole window lies inside the scheduler's lookback, so the match is still loaded", () => {
    // 2 days to the first try, plus the retry days, plus the day itself.
    expect(2 + UNPAID_FOLLOW_UP_RETRY_DAYS + 1).toBeLessThan(POST_MATCH_LOOKBACK_DAYS);
  });
});

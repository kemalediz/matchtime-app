/**
 * "Add a player" on /admin/months in a month under way, "The whole month,
 * already paid" (review of #611, round 3, item 4): the coverage is checked
 * FIRST, so a refused one writes nothing at all (no sign-up, no says-paid
 * claim). Allowed: the sign-up, then the claim, then the coverage (round
 * 2, item 2). auth, db, org and the writers are mocked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  auth: vi.fn(async () => ({ user: { id: "u-admin" } })),
  requireOrgAdmin: vi.fn(async () => undefined),
  monthFindFirst: vi.fn(async () => ({ id: "mo1" })),
  applySignup: vi.fn(async () => ({ ok: true, changed: true, locked: false, outcome: "regular", unknownDays: [] })),
  check: vi.fn(async (): Promise<{ ok: true } | { ok: false; error: string }> => ({ ok: true })),
  setCoverage: vi.fn(async () => ({ ok: true, changed: true })),
  claim: vi.fn(async () => true),
  reconcileLeavers: vi.fn(async () => undefined),
}));
vi.mock("@/lib/auth", () => ({ auth: m.auth }));
vi.mock("@/lib/org", () => ({ requireOrgAdmin: m.requireOrgAdmin }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { squadMonth: { findFirst: m.monthFindFirst } } }));
vi.mock("@/lib/month-signup", () => ({ applySignup: m.applySignup }));
vi.mock("@/lib/month-member-coverage", () => ({ checkMonthMemberCoverage: m.check, setMonthMemberCoverage: m.setCoverage }));
vi.mock("@/lib/month-payment", () => ({ claimMonthPaid: m.claim }));
vi.mock("@/lib/month-close", () => ({ reconcileLeavers: m.reconcileLeavers }));

import { setMonthMember } from "@/app/actions/month-signup";

beforeEach(() => vi.clearAllMocks());

describe("Add a player, the whole month, already paid", () => {
  it("a refused coverage (a returning row) writes nothing: no sign-up, no claim, no coverage", async () => {
    m.check.mockResolvedValueOnce({ ok: false, error: "below-credits" });
    const r = await setMonthMember("org1", "mo1", "u-back", "regular", "whole");
    expect(r).toEqual({ ok: false, error: "below-credits" });
    expect(m.check).toHaveBeenCalledWith(expect.objectContaining({ squadMonthId: "mo1", userId: "u-back", coverage: "whole" }));
    expect(m.applySignup).not.toHaveBeenCalled();
    expect(m.claim).not.toHaveBeenCalled();
    expect(m.setCoverage).not.toHaveBeenCalled();
  });

  it("allowed: the sign-up, then the says-paid claim, then the coverage", async () => {
    const r = await setMonthMember("org1", "mo1", "u-new", "regular", "whole");
    expect(r).toMatchObject({ ok: true, outcome: "regular" });
    const order = [m.check, m.applySignup, m.claim, m.setCoverage].map((f) => f.mock.invocationCallOrder[0]);
    expect(order.every((x) => typeof x === "number")).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("the games left: checked, no claim", async () => {
    await setMonthMember("org1", "mo1", "u-new", "regular", "left");
    expect(m.check).toHaveBeenCalled();
    expect(m.claim).not.toHaveBeenCalled();
    expect(m.setCoverage).toHaveBeenCalledWith(expect.objectContaining({ coverage: "left" }));
  });

  it("no coverage (pay as you go, or a month not under way): nothing checked, as before", async () => {
    await setMonthMember("org1", "mo1", "u-new", "payg");
    expect(m.check).not.toHaveBeenCalled();
    expect(m.applySignup).toHaveBeenCalled();
  });
});

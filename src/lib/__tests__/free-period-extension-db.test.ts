/**
 * `extendFreePeriods`: the one-off move of stored free period ends to the
 * current length (Kemal, 2026-10-28). Dry run by default; with `apply`, a
 * compare-and-set on the old end inside a transaction that re-checks there
 * is no billing month, plus an audit row. In-memory db; nothing messaged.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Billing = { orgId: string; trialStartedAt: Date; trialEndsAt: Date; name: string; status: string; months: number };

const h = vi.hoisted(() => {
  const state = { rows: [] as Billing[], events: [] as Array<{ id: string; type: string; orgId: string }> };
  const tx = {
    clubBillingMonth: { count: vi.fn(async ({ where }: { where: { orgId: string } }) => state.rows.find((r) => r.orgId === where.orgId)!.months) },
    clubBilling: {
      updateMany: vi.fn(async ({ where, data }: { where: { orgId: string; trialEndsAt: Date }; data: { trialEndsAt: Date } }) => {
        const r = state.rows.find((x) => x.orgId === where.orgId && x.trialEndsAt.getTime() === where.trialEndsAt.getTime());
        if (!r) return { count: 0 };
        r.trialEndsAt = data.trialEndsAt;
        return { count: 1 };
      }),
    },
    billingEvent: { create: vi.fn(async ({ data }: { data: { id: string; type: string; orgId: string } }) => void state.events.push(data)) },
  };
  const m = {
    clubBilling: {
      findMany: vi.fn(async ({ where }: { where: { trialEndsAt: { gt: Date } } }) =>
        state.rows
          .filter((r) => r.trialEndsAt.getTime() > where.trialEndsAt.gt.getTime())
          .map((r) => ({
            orgId: r.orgId,
            trialStartedAt: r.trialStartedAt,
            trialEndsAt: r.trialEndsAt,
            org: { name: r.name, billingStatus: r.status, _count: { billingMonths: r.months } },
          })),
      ),
    },
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  return { state, m, tx };
});
vi.mock("@/lib/db", () => ({ db: h.m }));
vi.mock("../db", () => ({ db: h.m }));

import { FREE_PERIOD_EXTENDED_EVENT_TYPE, extendFreePeriods } from "../club-billing";

const NOW = new Date("2026-10-28T12:00:00Z");
// The three prod clubs on 2026-10-28, and two that must not move.
const rows = (): Billing[] => [
  { orgId: "fnf", name: "FNF", status: "trial", months: 0, trialStartedAt: new Date("2026-10-15T21:12:40.497Z"), trialEndsAt: new Date("2026-12-15T22:12:40.497Z") },
  { orgId: "fri", name: "Friday MT Community", status: "trial", months: 0, trialStartedAt: new Date("2026-10-14T09:33:39.200Z"), trialEndsAt: new Date("2026-12-14T10:33:39.200Z") },
  { orgId: "mtt", name: "MT Test", status: "trial", months: 0, trialStartedAt: new Date("2026-10-21T06:46:26.151Z"), trialEndsAt: new Date("2026-12-21T07:46:26.151Z") },
  { orgId: "over", name: "Over", status: "grace", months: 0, trialStartedAt: new Date("2026-08-01T10:00:00Z"), trialEndsAt: new Date("2026-10-01T10:00:00Z") },
  { orgId: "billed", name: "Billed", status: "subscribed", months: 1, trialStartedAt: new Date("2026-09-20T10:00:00Z"), trialEndsAt: new Date("2026-11-20T11:00:00Z") },
];

beforeEach(() => {
  vi.clearAllMocks();
  h.state.rows = rows();
  h.state.events = [];
});

describe("extendFreePeriods", () => {
  it("dry run: lists the three clubs still in their free period with their new end, and writes nothing", async () => {
    const r = await extendFreePeriods({ apply: false, now: NOW });
    const got = r.map((x) => [x.orgId, x.from.toISOString(), x.to.toISOString(), x.written]).sort((a, b) => String(a[1]).localeCompare(String(b[1])));
    expect(got).toEqual([
      ["fri", "2026-12-14T10:33:39.200Z", "2027-01-14T10:33:39.200Z", false],
      ["fnf", "2026-12-15T22:12:40.497Z", "2027-01-15T22:12:40.497Z", false],
      ["mtt", "2026-12-21T07:46:26.151Z", "2027-01-21T07:46:26.151Z", false],
    ]);
    expect(h.m.$transaction).not.toHaveBeenCalled();
    expect(h.state.rows.find((x) => x.orgId === "fnf")!.trialEndsAt.toISOString()).toBe("2026-12-15T22:12:40.497Z");
  });

  it("apply: moves exactly those three, with an audit row each; a second run changes nothing", async () => {
    const r = await extendFreePeriods({ apply: true, now: NOW });
    expect(r.filter((x) => x.written).map((x) => x.orgId).sort()).toEqual(["fnf", "fri", "mtt"]);
    expect(h.state.rows.find((x) => x.orgId === "fnf")!.trialEndsAt.toISOString()).toBe("2027-01-15T22:12:40.497Z");
    expect(h.state.rows.find((x) => x.orgId === "over")!.trialEndsAt.toISOString()).toBe("2026-10-01T10:00:00.000Z");
    expect(h.state.rows.find((x) => x.orgId === "billed")!.trialEndsAt.toISOString()).toBe("2026-11-20T11:00:00.000Z");
    expect(h.state.events.map((e) => [e.orgId, e.type])).toEqual(
      expect.arrayContaining([["fnf", FREE_PERIOD_EXTENDED_EVENT_TYPE], ["fri", FREE_PERIOD_EXTENDED_EVENT_TYPE], ["mtt", FREE_PERIOD_EXTENDED_EVENT_TYPE]]),
    );
    expect(h.state.events).toHaveLength(3);
    expect(await extendFreePeriods({ apply: true, now: NOW })).toEqual([]);
    expect(h.state.events).toHaveLength(3);
  });

  it("a billing month that appears between the read and the write: not moved", async () => {
    h.tx.clubBillingMonth.count.mockResolvedValueOnce(1);
    const r = await extendFreePeriods({ apply: true, now: NOW });
    expect(r.filter((x) => !x.written)).toHaveLength(1);
    expect(h.state.events).toHaveLength(2);
  });
});

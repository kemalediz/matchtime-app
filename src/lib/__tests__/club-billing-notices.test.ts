/**
 * Club fee billing, review fixes 9 and 10: a billing DM is never lost.
 *
 *   - `queueBillingDm` claims the BillingNotice row first (so a re-run
 *     never sends twice) and RELEASES the claim when queueing throws, so the
 *     retry sends it;
 *   - a PENDING notice (a row written with no platformJobId, by the same
 *     transaction as the state change) is picked up and sent by the next
 *     call for it;
 *   - a recipient who cannot be messaged is marked skipped, not retried.
 *
 * db and the platform channel are mocked; nothing is sent.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Notice = { id: string; orgId: string; kind: string; cycleKey: string; platformJobId: string | null };

const h = vi.hoisted(() => {
  const state = { notices: [] as Notice[], seq: 0, phone: "+447700900001" as string | null };
  const key = (n: { orgId: string; kind: string; cycleKey: string }) => `${n.orgId}|${n.kind}|${n.cycleKey}`;
  const db = {
    billingNotice: {
      create: vi.fn(async ({ data }: { data: Omit<Notice, "id"> }) => {
        if (state.notices.some((n) => key(n) === key(data))) throw Object.assign(new Error("unique"), { code: "P2002" });
        const row = { id: `n${++state.seq}`, ...data, platformJobId: data.platformJobId ?? null };
        state.notices.push(row);
        return row;
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Partial<Notice>; data: Partial<Notice> }) => {
        const rows = state.notices.filter((n) => Object.entries(where).every(([k, v]) => n[k as keyof Notice] === v));
        rows.forEach((r) => Object.assign(r, data));
        return { count: rows.length };
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Notice> }) => {
        const r = state.notices.find((n) => n.id === where.id)!;
        Object.assign(r, data);
        return r;
      }),
    },
    user: { findUnique: vi.fn(async () => ({ name: "Colin", phoneNumber: state.phone })) },
  };
  return { state, db, queue: vi.fn() };
});
vi.mock("../db", () => ({ db: h.db }));
vi.mock("../platform-jobs", () => ({
  queuePlatformDm: h.queue,
  PlatformDmRefused: class PlatformDmRefused extends Error {
    constructor(readonly reason: string) {
      super(reason);
    }
  },
}));

import { queueBillingDm } from "../club-billing";

const args = { orgId: "org1", kind: "card-added" as const, cycleKey: "sub_1", userId: "colin", text: () => "Thanks Colin" };

beforeEach(() => {
  h.state.notices = [];
  h.state.phone = "+447700900001";
  vi.clearAllMocks();
  h.queue.mockResolvedValue({ id: "job_1" });
});

describe("queueBillingDm", () => {
  it("claims, queues once, records the job; a second call is 'already'", async () => {
    expect(await queueBillingDm(args)).toBe("queued");
    expect(h.state.notices[0].platformJobId).toBe("job_1");
    expect(await queueBillingDm(args)).toBe("already");
    expect(h.queue).toHaveBeenCalledTimes(1);
  });

  it("fix 9: queueing THROWS: the claim is released, so the retry sends it", async () => {
    h.queue.mockRejectedValueOnce(new Error("db hiccup"));
    await expect(queueBillingDm(args)).rejects.toThrow("db hiccup");
    expect(h.state.notices[0].platformJobId).toBeNull();
    expect(await queueBillingDm(args)).toBe("queued");
    expect(h.queue).toHaveBeenCalledTimes(2);
  });

  it("fix 10: a PENDING notice (written by the state change's transaction) is sent by the next call, once", async () => {
    h.state.notices.push({ id: "p1", orgId: "org1", kind: "plan-billed", cycleKey: "2026-11-01T00:00:00.000Z", platformJobId: null });
    const pending = { ...args, kind: "plan-billed" as const, cycleKey: "2026-11-01T00:00:00.000Z" };
    expect(await queueBillingDm(pending)).toBe("queued");
    expect(await queueBillingDm(pending)).toBe("already");
    expect(h.queue).toHaveBeenCalledTimes(1);
  });

  it("no phone: marked skipped, never retried", async () => {
    h.state.phone = null;
    expect(await queueBillingDm(args)).toBe("no-phone");
    expect(h.state.notices[0].platformJobId).toBe("skipped:no-phone");
    expect(await queueBillingDm(args)).toBe("already");
  });
});

/**
 * `setQuietHours` (club settings): saving new quiet hours also re-times the
 * club's unsent messages those hours were holding, in the same transaction
 * as the settings update (Kemal, 2026-10-28). The rule is
 * `retimeQuietHoursHolds`; this pins the adapter: the club scope, the
 * unsent and still-held filter, and the guarded per-job update.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const tx = {
    organisation: { findUnique: vi.fn(), update: vi.fn() },
    botJob: { findMany: vi.fn(), updateMany: vi.fn() },
  };
  return {
    tx,
    auth: vi.fn(),
    requireOrgAdmin: vi.fn(),
    revalidatePath: vi.fn(),
    transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
});
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/org", () => ({ requireOrgAdmin: h.requireOrgAdmin }));
vi.mock("@/lib/db", () => ({ db: { $transaction: h.transaction, organisation: h.tx.organisation } }));

import { setQuietHours } from "../quiet-hours";

const at = (iso: string) => new Date(iso);
const OLD = { quietHoursEnabled: true, quietHoursFrom: "23:00", quietHoursTo: "09:00" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(at("2026-12-02T06:00:00Z"));
  h.auth.mockResolvedValue({ user: { id: "kemal" } });
  h.requireOrgAdmin.mockResolvedValue(undefined);
  h.tx.organisation.findUnique.mockResolvedValue(OLD);
  h.tx.organisation.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ ...OLD, ...data }));
  h.tx.botJob.findMany.mockResolvedValue([]);
  h.tx.botJob.updateMany.mockResolvedValue({ count: 1 });
});

describe("setQuietHours re-times held messages", () => {
  it("earlier hours: a quiet hours hold moves to the new end; other jobs are untouched", async () => {
    h.tx.botJob.findMany.mockResolvedValue([
      { id: "held", createdAt: at("2026-12-02T01:15:00Z"), sendAfter: at("2026-12-02T09:00:00Z") },
      { id: "reminder", createdAt: at("2026-12-01T15:00:00Z"), sendAfter: at("2026-12-02T09:00:00Z") },
    ]);
    const res = await setQuietHours("org1", { enabled: true, from: "23:00", to: "07:00" });
    expect(res).toEqual({ ok: true, value: { enabled: true, from: "23:00", to: "07:00" } });

    expect(h.transaction).toHaveBeenCalledTimes(1);
    // only this club's unsent jobs still held past now
    expect(h.tx.botJob.findMany).toHaveBeenCalledWith({
      where: { orgId: "org1", sentAt: null, sendAfter: { gt: at("2026-12-02T06:00:00Z") } },
      select: { id: true, createdAt: true, sendAfter: true },
    });
    expect(h.tx.botJob.updateMany).toHaveBeenCalledTimes(1);
    // guarded: still this club's, still unsent, still the time we read
    expect(h.tx.botJob.updateMany).toHaveBeenCalledWith({
      where: { id: "held", orgId: "org1", sentAt: null, sendAfter: at("2026-12-02T09:00:00Z") },
      data: { sendAfter: at("2026-12-02T07:00:00Z") },
    });
  });

  it("switched off: the hold is released at once", async () => {
    h.tx.botJob.findMany.mockResolvedValue([
      { id: "held", createdAt: at("2026-12-02T01:15:00Z"), sendAfter: at("2026-12-02T09:00:00Z") },
    ]);
    await setQuietHours("org1", { enabled: false });
    expect(h.tx.botJob.updateMany).toHaveBeenCalledWith({
      where: { id: "held", orgId: "org1", sentAt: null, sendAfter: at("2026-12-02T09:00:00Z") },
      data: { sendAfter: null },
    });
  });

  it("the old hours are read inside the transaction, before the update", async () => {
    await setQuietHours("org1", { enabled: true, from: "22:00", to: "08:00" });
    const readOrder = h.tx.organisation.findUnique.mock.invocationCallOrder[0];
    const writeOrder = h.tx.organisation.update.mock.invocationCallOrder[0];
    expect(readOrder).toBeLessThan(writeOrder);
    expect(h.tx.organisation.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "org1" } }));
  });

  it("a bad time writes nothing", async () => {
    expect(await setQuietHours("org1", { enabled: true, from: "25:00", to: "07:00" })).toEqual({ ok: false, error: "bad-time" });
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it("a non-admin is refused before anything is read", async () => {
    h.requireOrgAdmin.mockRejectedValue(new Error("Forbidden"));
    await expect(setQuietHours("org1", { enabled: false })).rejects.toThrow("Forbidden");
    expect(h.transaction).not.toHaveBeenCalled();
  });
});

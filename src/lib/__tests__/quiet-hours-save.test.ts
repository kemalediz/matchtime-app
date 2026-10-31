/**
 * `saveQuietHours` (2026-10-31): the one core that saves a club's quiet
 * hours and re-times the messages the OLD hours were holding, in one
 * transaction. Used by the settings page's server action and by an
 * organiser tagging MatchTime in WhatsApp ("@Match Time turn off quiet
 * hours now", MT Test 31 Oct). The re-timing rule is
 * `retimeQuietHoursHolds`; this pins the adapter and what it reports back:
 * how many held messages now go out at once.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const tx = {
    organisation: { findUnique: vi.fn(), update: vi.fn() },
    botJob: { findMany: vi.fn(), updateMany: vi.fn() },
  };
  return { tx, transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
});
vi.mock("@/lib/db", () => ({ db: { $transaction: h.transaction, organisation: h.tx.organisation } }));

import { saveQuietHours } from "../quiet-hours-save";

const at = (iso: string) => new Date(iso);
const NOW = at("2026-12-02T06:00:00Z");
const OLD = { quietHoursEnabled: true, quietHoursFrom: "23:00", quietHoursTo: "09:00" };
// Queued at 01:15 London inside 23:00 to 09:00: held to 09:00.
const HELD = { id: "held", createdAt: at("2026-12-02T01:15:00Z"), sendAfter: at("2026-12-02T09:00:00Z") };
const HELD_2 = { id: "held-2", createdAt: at("2026-12-02T02:40:00Z"), sendAfter: at("2026-12-02T09:00:00Z") };
// A deliberate schedule made in the daytime for 09:00: never a hold.
const SCHEDULED = { id: "reminder", createdAt: at("2026-12-01T15:00:00Z"), sendAfter: at("2026-12-02T09:00:00Z") };

beforeEach(() => {
  vi.clearAllMocks();
  h.tx.organisation.findUnique.mockResolvedValue(OLD);
  h.tx.organisation.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ ...OLD, ...data }));
  h.tx.botJob.findMany.mockResolvedValue([]);
  h.tx.botJob.updateMany.mockResolvedValue({ count: 1 });
});

describe("saveQuietHours", () => {
  it("off: every quiet hours hold is released at once and counted; a deliberate schedule is untouched", async () => {
    h.tx.botJob.findMany.mockResolvedValue([HELD, HELD_2, SCHEDULED]);
    const r = await saveQuietHours({ orgId: "org1", input: { enabled: false }, now: NOW });
    expect(r).toEqual({
      ok: true,
      before: { enabled: true, from: "23:00", to: "09:00" },
      value: { enabled: false, from: "23:00", to: "09:00" },
      released: 2,
      retimed: ["held", "held-2"],
    });
    expect(h.tx.organisation.update).toHaveBeenCalledWith({ where: { id: "org1" }, data: { quietHoursEnabled: false }, select: expect.any(Object) });
    expect(h.tx.botJob.updateMany).toHaveBeenCalledTimes(2);
    expect(h.tx.botJob.updateMany).toHaveBeenCalledWith({
      where: { id: "held", orgId: "org1", sentAt: null, sendAfter: at("2026-12-02T09:00:00Z") },
      data: { sendAfter: null },
    });
  });

  it("only this club's unsent jobs still held past now are read", async () => {
    await saveQuietHours({ orgId: "org1", input: { enabled: false }, now: NOW });
    expect(h.tx.botJob.findMany).toHaveBeenCalledWith({
      where: { orgId: "org1", sentAt: null, sendAfter: { gt: NOW } },
      select: { id: true, createdAt: true, sendAfter: true },
    });
  });

  it("a job the Pi sent meanwhile is not counted (the guarded update changed nothing)", async () => {
    h.tx.botJob.findMany.mockResolvedValue([HELD, HELD_2]);
    h.tx.botJob.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });
    const r = await saveQuietHours({ orgId: "org1", input: { enabled: false }, now: NOW });
    expect(r).toMatchObject({ ok: true, released: 1, retimed: ["held-2"] });
  });

  it("on with new times: saved; a hold moves to the new, earlier end and is NOT counted as released", async () => {
    h.tx.botJob.findMany.mockResolvedValue([HELD]);
    const r = await saveQuietHours({ orgId: "org1", input: { enabled: true, from: "22:00", to: "07:00" }, now: NOW });
    expect(r).toMatchObject({ ok: true, value: { enabled: true, from: "22:00", to: "07:00" }, released: 0, retimed: ["held"] });
    expect(h.tx.organisation.update).toHaveBeenCalledWith({
      where: { id: "org1" },
      data: { quietHoursEnabled: true, quietHoursFrom: "22:00", quietHoursTo: "07:00" },
      select: expect.any(Object),
    });
    expect(h.tx.botJob.updateMany).toHaveBeenCalledWith({
      where: { id: "held", orgId: "org1", sentAt: null, sendAfter: at("2026-12-02T09:00:00Z") },
      data: { sendAfter: at("2026-12-02T07:00:00Z") },
    });
  });

  it("on with hours that end before now: the hold goes out at once and is counted", async () => {
    h.tx.botJob.findMany.mockResolvedValue([HELD]);
    const r = await saveQuietHours({ orgId: "org1", input: { enabled: true, from: "23:00", to: "05:00" }, now: NOW });
    expect(r).toMatchObject({ ok: true, released: 1 });
  });

  it.each([
    [{ enabled: true, from: "25:00", to: "08:00" }, "bad-time"],
    [{ enabled: true, from: "22:00" }, "bad-time"],
    [{ enabled: true, from: "22:00", to: "22:00" }, "same-time"],
  ] as const)("invalid times %o are refused (%s): nothing read, nothing written", async (input, error) => {
    const r = await saveQuietHours({ orgId: "org1", input, now: NOW });
    expect(r).toEqual({ ok: false, error });
    expect(h.transaction).not.toHaveBeenCalled();
    expect(h.tx.organisation.update).not.toHaveBeenCalled();
  });
});

/**
 * The list a format switch queues (Vets, 2026-11-16, review of #615):
 *   - a job already handed to the Pi (its `botjob-<id>` claim row exists) is
 *     never rendered again: no re-read, no text update, no bookkeeping;
 *   - of two unsent lists for one match only the newest goes out; the older
 *     is closed (`sentAt` set) and never emitted.
 *
 * db is mocked; nothing is sent.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const db = {
    sentNotification: { findUnique: vi.fn(), create: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
    match: { findUnique: vi.fn() },
    attendance: { findMany: vi.fn() },
    botJob: { findFirst: vi.fn(), updateMany: vi.fn() },
  };
  return { db };
});

vi.mock("../db", () => ({ db: h.db }));

import { formatListJobSuperseded, freshFormatListText } from "../format-resize";
import { formatListAboutKey } from "../flex-format-rules";

const now = new Date("2026-11-16T18:54:00Z");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("freshFormatListText: a job already handed to the Pi", () => {
  it("goes out exactly as handed out: no re-render, no update, no bookkeeping", async () => {
    h.db.sentNotification.findUnique.mockResolvedValue({ key: "botjob-j1" });
    const text = await freshFormatListText({ id: "j1", text: "queued list", matchId: "m1" }, now);
    expect(text).toBe("queued list");
    expect(h.db.sentNotification.findUnique).toHaveBeenCalledWith({ where: { key: "botjob-j1" }, select: { key: true } });
    expect(h.db.match.findUnique).not.toHaveBeenCalled();
    expect(h.db.botJob.updateMany).not.toHaveBeenCalled();
    expect(h.db.sentNotification.create).not.toHaveBeenCalled();
    expect(h.db.sentNotification.upsert).not.toHaveBeenCalled();
  });
});

describe("formatListJobSuperseded: two unsent lists for one match", () => {
  const aboutKey = formatListAboutKey("m1");
  const older = { id: "old", orgId: "o1", createdAt: new Date("2026-11-16T18:53:00Z"), aboutKey };
  const newer = { id: "new", orgId: "o1", createdAt: new Date("2026-11-16T18:53:30Z"), aboutKey };

  it("closes the older one and sends only the newest", async () => {
    h.db.sentNotification.findUnique.mockResolvedValue(null);
    h.db.botJob.updateMany.mockResolvedValue({ count: 1 });
    h.db.botJob.findFirst.mockImplementation(async ({ where }: { where: { createdAt: { gt: Date } } }) =>
      where.createdAt.gt.getTime() < newer.createdAt.getTime() ? { id: newer.id } : null,
    );

    expect(await formatListJobSuperseded(older, now)).toBe(true);
    expect(h.db.botJob.updateMany).toHaveBeenCalledWith({
      where: { id: "old", sentAt: null },
      data: { sentAt: now, aboutKey: `${aboutKey}:superseded` },
    });

    h.db.botJob.updateMany.mockClear();
    expect(await formatListJobSuperseded(newer, now)).toBe(false);
    expect(h.db.botJob.updateMany).not.toHaveBeenCalled();
  });
});

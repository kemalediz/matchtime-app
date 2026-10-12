/**
 * A setup message the Pi claimed and never reported on
 * (src/lib/club-setup-stale-claims.ts). db and the ops events are mocked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({ platformJob: { findMany: vi.fn(), updateMany: vi.fn(), create: vi.fn() } }));
vi.mock("@/lib/db", () => ({ db: dbMock }));
vi.mock("../db", () => ({ db: dbMock }));

const recordOpsEvent = vi.hoisted(() => vi.fn());
vi.mock("../ops-alerts", () => ({ SETUP_ALERT_KIND: "club-setup", recordOpsEvent }));

import { STALE_CLAIM_AFTER_MS, STALE_CLAIM_REASON, flagStaleSetupDmClaims } from "../club-setup-stale-claims";

const NOW = new Date("2026-10-13T12:00:00Z");
const job = (over: Record<string, unknown> = {}) => ({
  id: "pj-1",
  purpose: "setup-ask",
  refId: "org-harbour:setup-ask",
  claimedAt: new Date(NOW.getTime() - 20 * 60_000),
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.platformJob.findMany.mockResolvedValue([]);
  recordOpsEvent.mockResolvedValue(true);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("flagStaleSetupDmClaims", () => {
  it("the rule: 15 minutes, and the reason code the owner sees", () => {
    expect(STALE_CLAIM_AFTER_MS).toBe(15 * 60 * 1000);
    expect(STALE_CLAIM_REASON).toBe("setup-dm-claim-stale");
  });

  it("looks only at SETUP messages that are still claimed after 15 minutes: never a sign-up code, a billing notice or a reply", async () => {
    await flagStaleSetupDmClaims(NOW);
    const where = dbMock.platformJob.findMany.mock.calls[0][0].where;
    expect(where.kind).toBe("dm");
    expect(where.status).toBe("claimed");
    expect([...where.purpose.in].sort()).toEqual(["setup-admin-code", "setup-ask", "setup-owner-live", "setup-reminder", "setup-removed"]);
    expect(where.claimedAt).toEqual({ lte: new Date(NOW.getTime() - 15 * 60_000) });
  });

  it("with nothing stale it is one query and records nothing", async () => {
    expect(await flagStaleSetupDmClaims(NOW)).toEqual({ considered: 0, recorded: 0 });
    expect(dbMock.platformJob.findMany).toHaveBeenCalledTimes(1);
    expect(recordOpsEvent).not.toHaveBeenCalled();
  });

  it("a stale setup DM: ONE event for the owner, on the club, keyed on the job so it is recorded once", async () => {
    dbMock.platformJob.findMany.mockResolvedValue([job()]);
    expect(await flagStaleSetupDmClaims(NOW)).toEqual({ considered: 1, recorded: 1 });
    expect(recordOpsEvent).toHaveBeenCalledTimes(1);
    const event = recordOpsEvent.mock.calls[0][0];
    expect(event).toMatchObject({
      orgId: "org-harbour",
      kind: "club-setup",
      severity: "warning",
      dedupeKey: "setup-dm-claim-stale:pj-1",
      now: NOW,
    });
    expect(event.detail).toContain("setup-dm-claim-stale");
    expect(event.detail).toContain("setup message");
    expect(event.detail).toContain("NOT sent again");
  });

  it("the next run finds the same job and records nothing more (the ops event de-duplicates)", async () => {
    dbMock.platformJob.findMany.mockResolvedValue([job()]);
    recordOpsEvent.mockResolvedValue(false);
    expect(await flagStaleSetupDmClaims(NOW)).toEqual({ considered: 1, recorded: 0 });
  });

  it("NEVER RESENDS: the job is not touched, re-queued or copied", async () => {
    dbMock.platformJob.findMany.mockResolvedValue([job(), job({ id: "pj-2", purpose: "setup-reminder", refId: "org-harbour:setup-reminder" })]);
    await flagStaleSetupDmClaims(NOW);
    expect(dbMock.platformJob.updateMany).not.toHaveBeenCalled();
    expect(dbMock.platformJob.create).not.toHaveBeenCalled();
  });

  it("each kind of setup message is named for the owner", async () => {
    dbMock.platformJob.findMany.mockResolvedValue([
      job({ id: "a", purpose: "setup-reminder", refId: "o1:setup-reminder" }),
      job({ id: "b", purpose: "setup-admin-code", refId: "o1:setup-admin-code" }),
      job({ id: "c", purpose: "setup-removed", refId: "o1:setup-removed" }),
      job({ id: "d", purpose: "setup-owner-live", refId: "o1:setup-owner-live" }),
    ]);
    await flagStaleSetupDmClaims(NOW);
    const details = recordOpsEvent.mock.calls.map((c) => c[0].detail as string);
    expect(details[0]).toContain("setup reminder");
    expect(details[1]).toContain("admin group command");
    expect(details[2]).toContain("removed-from-group message");
    expect(details[3]).toContain("started-for-you message");
  });

  it("a job with no club in its refId is skipped, not guessed at", async () => {
    dbMock.platformJob.findMany.mockResolvedValue([job({ refId: null }), job({ id: "x", refId: "no-colon" })]);
    expect(await flagStaleSetupDmClaims(NOW)).toEqual({ considered: 2, recorded: 0 });
    expect(recordOpsEvent).not.toHaveBeenCalled();
  });
});

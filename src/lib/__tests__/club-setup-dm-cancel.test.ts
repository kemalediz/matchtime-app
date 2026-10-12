/**
 * PR #235 review fix 3: cancelling a club's unsent setup DM.
 *
 * A setup DM queued at night waits for 09:00 London. If the club is
 * suspended, removed or goes live before then, it must not go out.
 * `cancelSetupDm` marks the club's QUEUED job as failed with a reason; a
 * job the Pi has already claimed is left alone and counted, because it may
 * already be on its way. Against a mocked database; the real claim is
 * exercised in e2e/helpers/setup-hold-lib-tests.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Job = { id: string; kind: string; purpose: string; refId: string; status: string; failReason?: string | null; failedAt?: Date | null };
const state = vi.hoisted(() => ({ jobs: [] as Job[] }));

const matches = (j: Job, where: Record<string, unknown>) =>
  Object.entries(where).every(([k, v]) => (j as unknown as Record<string, unknown>)[k] === v);

const dbMock = vi.hoisted(() => ({
  platformJob: {
    updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Partial<Job> }) => {
      const hit = state.jobs.filter((j) => matches(j, where));
      for (const j of hit) Object.assign(j, data);
      return { count: hit.length };
    }),
    count: vi.fn(async ({ where }: { where: Record<string, unknown> }) => state.jobs.filter((j) => matches(j, where)).length),
  },
}));
vi.mock("@/lib/db", () => ({ db: dbMock }));

import { cancelSetupDm } from "../club-setup-dm-cancel";
import { cancelQueuedPlatformDms } from "../platform-jobs";

const NOW = new Date("2026-10-13T00:10:00Z");
const job = (over: Partial<Job> = {}): Job => ({
  id: "pj-1",
  kind: "dm",
  purpose: "setup-ask",
  refId: "org-riverside:setup-ask",
  status: "queued",
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  state.jobs = [];
});

describe("cancelSetupDm", () => {
  it("a queued setup DM is marked failed, with why, and will never be handed to the Pi", async () => {
    state.jobs = [job()];
    expect(await cancelSetupDm("org-riverside", "suspended", NOW)).toEqual({ cancelled: 1, alreadyClaimed: 0 });
    expect(state.jobs[0]).toMatchObject({ status: "failed", failedAt: NOW, failReason: "cancelled: suspended" });
  });

  it("the write is a compare-and-set on 'queued': the same test the Pi's claim uses, so exactly one of them wins", async () => {
    state.jobs = [job()];
    await cancelSetupDm("org-riverside", "removed", NOW);
    expect(dbMock.platformJob.updateMany).toHaveBeenCalledWith({
      where: { kind: "dm", purpose: "setup-ask", refId: "org-riverside:setup-ask", status: "queued" },
      data: { status: "failed", failedAt: NOW, failReason: "cancelled: removed" },
    });
  });

  it("a job the Pi has ALREADY CLAIMED is left alone, and the caller is told", async () => {
    state.jobs = [job({ status: "claimed" })];
    expect(await cancelSetupDm("org-riverside", "suspended", NOW)).toEqual({ cancelled: 0, alreadyClaimed: 1 });
    expect(state.jobs[0]).toMatchObject({ status: "claimed" });
    expect(state.jobs[0].failReason).toBeUndefined();
  });

  it("a job already sent, or no job at all: nothing to do", async () => {
    state.jobs = [job({ status: "sent" })];
    expect(await cancelSetupDm("org-riverside", "went-live", NOW)).toEqual({ cancelled: 0, alreadyClaimed: 0 });
    expect(state.jobs[0].status).toBe("sent");
    state.jobs = [];
    expect(await cancelSetupDm("org-riverside", "went-live", NOW)).toEqual({ cancelled: 0, alreadyClaimed: 0 });
  });

  it("only this club's setup DM: another club's, and this club's other DMs, are untouched", async () => {
    state.jobs = [
      job(),
      job({ id: "pj-2", refId: "org-other:setup-ask" }),
      job({ id: "pj-3", purpose: "organiser-decision", refId: "org-riverside:setup-ask" }),
      job({ id: "pj-4", kind: "leave-group" }),
    ];
    expect(await cancelSetupDm("org-riverside", "suspended", NOW)).toEqual({ cancelled: 1, alreadyClaimed: 0 });
    expect(state.jobs.map((j) => j.status)).toEqual(["failed", "queued", "queued", "queued"]);
  });
});

describe("cancelQueuedPlatformDms (the platform channel's half)", () => {
  it("refuses to cancel sign-up codes and the owner's DMs by purpose", async () => {
    for (const purpose of ["otp", "owner-approval", "owner-ack"]) {
      await expect(cancelQueuedPlatformDms({ purpose: purpose as never, refId: "x", reason: "y", now: NOW })).rejects.toThrow(/cannot be cancelled/);
    }
    expect(dbMock.platformJob.updateMany).not.toHaveBeenCalled();
  });
});

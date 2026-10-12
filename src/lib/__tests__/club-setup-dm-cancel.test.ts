/**
 * PR #235 review fix 3, and the pacing gap closed at the merge with the
 * go-live slice: cancelling a club's setup DM that has not gone yet.
 *
 * A setup DM queued at night waits for 09:00 London. If the club is
 * suspended, removed or goes live before then, it must not go out.
 * `cancelSetupDm` is ONE statement: a QUEUED job becomes failed; a job the
 * Pi has already CLAIMED keeps its status (it may be on its way) and is
 * MARKED, so that if the Pi releases it for pacing it is failed, not put
 * back in the queue. Against a mocked database that models that one
 * statement; the real statement, the real claim and the real release are
 * exercised in e2e/helpers/setup-hold-lib-tests.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Job = { id: string; kind: string; purpose: string; refId: string; status: string; failReason?: string | null; failedAt?: Date | null; claimedAt?: Date | null };
const state = vi.hoisted(() => ({ jobs: [] as Job[], sql: [] as string[] }));

const matches = (j: Job, where: Record<string, unknown>): boolean =>
  Object.entries(where).every(([k, v]) => {
    const have = (j as unknown as Record<string, unknown>)[k] ?? null;
    if (k === "OR") return (v as Array<Record<string, unknown>>).some((w) => matches(j, w));
    if (k === "NOT") return !matches(j, v as Record<string, unknown>);
    if (v && typeof v === "object" && "startsWith" in (v as object)) {
      return typeof have === "string" && have.startsWith((v as { startsWith: string }).startsWith);
    }
    return have === v;
  });

const dbMock = vi.hoisted(() => ({
  platformJob: {
    updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Partial<Job> }) => {
      const hit = state.jobs.filter((j) => matches(j, where));
      for (const j of hit) Object.assign(j, data);
      return { count: hit.length };
    }),
  },
  // The cancel's one UPDATE ... RETURNING: values are (now, reason, now, purposes, refIds).
  $queryRaw: vi.fn(async (q: TemplateStringsArray, ...values: unknown[]) => {
    state.sql.push(q.join("?"));
    const [now, reason, , purposes, refIds] = values as [Date, string, Date, string[], string[]];
    const out: Array<{ status: string }> = [];
    for (const j of state.jobs) {
      if (j.kind !== "dm" || !purposes.includes(j.purpose) || !refIds.includes(j.refId)) continue;
      if (j.status !== "queued" && j.status !== "claimed") continue;
      if (j.status === "queued") {
        j.status = "failed";
        j.failedAt = now;
      }
      j.failReason = reason;
      out.push({ status: j.status });
    }
    return out;
  }),
}));
vi.mock("@/lib/db", () => ({ db: dbMock }));

import { cancelSetupDm } from "../club-setup-dm-cancel";
import { CANCELLED_REASON_PREFIX, cancelQueuedPlatformDms, recordPlatformJobOutcome } from "../platform-jobs";

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
  state.sql = [];
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("cancelSetupDm", () => {
  it("a queued setup DM is marked failed, with why, and will never be handed to the Pi", async () => {
    state.jobs = [job()];
    expect(await cancelSetupDm("org-riverside", "suspended", NOW)).toEqual({ cancelled: 1, alreadyClaimed: 0 });
    expect(state.jobs[0]).toMatchObject({ status: "failed", failedAt: NOW, failReason: "cancelled: suspended" });
  });

  it("it is ONE statement over queued and claimed jobs, so it cannot interleave with the Pi's claim or release", async () => {
    state.jobs = [job()];
    await cancelSetupDm("org-riverside", "removed", NOW);
    expect(dbMock.$queryRaw).toHaveBeenCalledTimes(1);
    expect(dbMock.platformJob.updateMany).not.toHaveBeenCalled();
    expect(state.sql[0]).toMatch(/UPDATE "PlatformJob" SET[\s\S]*CASE WHEN "status" = 'queued' THEN 'failed' ELSE "status" END/);
    expect(state.sql[0]).toMatch(/"status" IN \('queued', 'claimed'\)[\s\S]*RETURNING "status"/);
    expect(state.sql[0]).toMatch(/"purpose" = ANY\(\?\) AND "refId" = ANY\(\?\)/);
    expect(dbMock.$queryRaw.mock.calls[0].slice(1)).toEqual([
      NOW,
      "cancelled: removed",
      NOW,
      ["setup-ask", "setup-admin-code", "setup-reminder"],
      ["org-riverside:setup-ask", "org-riverside:setup-admin-code", "org-riverside:setup-reminder"],
    ]);
  });

  it("slices S6 and S7: the admin group command and the reminder are cancelled WITH the setup DM, in that one statement", async () => {
    state.jobs = [
      job(),
      job({ id: "pj-code", purpose: "setup-admin-code", refId: "org-riverside:setup-admin-code" }),
      job({ id: "pj-rem", purpose: "setup-reminder", refId: "org-riverside:setup-reminder" }),
    ];
    expect(await cancelSetupDm("org-riverside", "went-live", NOW)).toEqual({ cancelled: 3, alreadyClaimed: 0 });
    expect(dbMock.$queryRaw).toHaveBeenCalledTimes(1);
    for (const j of state.jobs) expect(j).toMatchObject({ status: "failed", failReason: "cancelled: went-live" });
  });

  it("a reminder queued at night for 09:00, alone (the setup DM went yesterday): cancelled when the club goes live", async () => {
    state.jobs = [
      job({ status: "sent" }),
      job({ id: "pj-code", purpose: "setup-admin-code", refId: "org-riverside:setup-admin-code", status: "sent" }),
      job({ id: "pj-rem", purpose: "setup-reminder", refId: "org-riverside:setup-reminder" }),
    ];
    expect(await cancelSetupDm("org-riverside", "went-live", NOW)).toEqual({ cancelled: 1, alreadyClaimed: 0 });
    expect(state.jobs.map((j) => j.status)).toEqual(["sent", "sent", "failed"]);
  });

  it("a reminder the Pi has ALREADY CLAIMED keeps its status and is marked, like the setup DM", async () => {
    state.jobs = [job({ id: "pj-rem", purpose: "setup-reminder", refId: "org-riverside:setup-reminder", status: "claimed" })];
    expect(await cancelSetupDm("org-riverside", "suspended", NOW)).toEqual({ cancelled: 0, alreadyClaimed: 1 });
    expect(state.jobs[0]).toMatchObject({ status: "claimed", failReason: "cancelled: suspended" });
    // Released for pacing after the cancel: failed, never queued again.
    expect(await recordPlatformJobOutcome("pj-rem", { outcome: "release" }, NOW)).toEqual({ updated: true });
    expect(state.jobs[0].status).toBe("failed");
  });

  it("another club's reminder and command, and a setup-reply to this club, are untouched", async () => {
    state.jobs = [
      job({ id: "a", purpose: "setup-reminder", refId: "org-other:setup-reminder" }),
      job({ id: "b", purpose: "setup-admin-code", refId: "org-other:setup-admin-code" }),
      job({ id: "c", purpose: "setup-reply", refId: "org-riverside:setup-reminder" }),
    ];
    expect(await cancelSetupDm("org-riverside", "suspended", NOW)).toEqual({ cancelled: 0, alreadyClaimed: 0 });
    expect(state.jobs.map((j) => j.status)).toEqual(["queued", "queued", "queued"]);
  });

  it("a job the Pi has ALREADY CLAIMED keeps its status (it may be on its way), is marked, and the caller is told", async () => {
    state.jobs = [job({ status: "claimed" })];
    expect(await cancelSetupDm("org-riverside", "went-live", NOW)).toEqual({ cancelled: 0, alreadyClaimed: 1 });
    expect(state.jobs[0]).toMatchObject({ status: "claimed", failReason: "cancelled: went-live" });
    expect(state.jobs[0].failedAt).toBeUndefined();
  });

  it("a job already sent, or no job at all: nothing to do", async () => {
    state.jobs = [job({ status: "sent" })];
    expect(await cancelSetupDm("org-riverside", "went-live", NOW)).toEqual({ cancelled: 0, alreadyClaimed: 0 });
    expect(state.jobs[0]).toEqual(job({ status: "sent" }));
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

describe("THE PACING GAP: a cancelled job the Pi then RELEASES is not put back in the queue", () => {
  it("claimed, cancelled (marked), released for pacing: failed, never queued again", async () => {
    state.jobs = [job({ status: "claimed", claimedAt: NOW })];
    await cancelSetupDm("org-riverside", "suspended", NOW);
    expect(await recordPlatformJobOutcome("pj-1", { outcome: "release" }, NOW)).toEqual({ updated: true });
    expect(state.jobs[0]).toMatchObject({ status: "failed", failedAt: NOW, failReason: "cancelled: suspended" });
  });

  it("claimed, cancelled, and the Pi had in fact SENT it: recorded as sent (the mark says it was cancelled too late)", async () => {
    state.jobs = [job({ status: "claimed" })];
    await cancelSetupDm("org-riverside", "went-live", NOW);
    expect(await recordPlatformJobOutcome("pj-1", { outcome: "sent", waMessageId: "wa-1" }, NOW)).toEqual({ updated: true });
    expect(state.jobs[0]).toMatchObject({ status: "sent", failReason: "cancelled: went-live" });
  });

  it("a job that was NOT cancelled is released exactly as before: back to queued, in ONE statement", async () => {
    state.jobs = [job({ status: "claimed", claimedAt: NOW })];
    expect(await recordPlatformJobOutcome("pj-1", { outcome: "release" }, NOW)).toEqual({ updated: true });
    expect(state.jobs[0]).toMatchObject({ status: "queued", claimedAt: null });
    expect(dbMock.platformJob.updateMany).toHaveBeenCalledTimes(1);
    expect(dbMock.platformJob.updateMany.mock.calls[0][0].data).toEqual({ status: "queued", claimedAt: null });
  });

  it("a release of a job with some OTHER failReason on it is still a plain release", async () => {
    state.jobs = [job({ status: "claimed", failReason: "something else" })];
    await recordPlatformJobOutcome("pj-1", { outcome: "release" }, NOW);
    expect(state.jobs[0].status).toBe("queued");
  });

  it("released first, cancelled after: the cancel finds it queued and fails it", async () => {
    state.jobs = [job({ status: "claimed" })];
    await recordPlatformJobOutcome("pj-1", { outcome: "release" }, NOW);
    expect(await cancelSetupDm("org-riverside", "suspended", NOW)).toEqual({ cancelled: 1, alreadyClaimed: 0 });
    expect(state.jobs[0].status).toBe("failed");
  });

  it("the mark is the cancellation's own prefix", () => {
    expect(CANCELLED_REASON_PREFIX).toBe("cancelled: ");
  });
});

describe("cancelQueuedPlatformDms (the platform channel's guard)", () => {
  it("refuses to cancel sign-up codes and the owner's DMs by purpose", async () => {
    for (const purpose of ["otp", "owner-approval", "owner-ack", "owner-setup-stuck", "billing", "setup-reply"]) {
      await expect(cancelQueuedPlatformDms({ purposes: [purpose as never], refIds: ["x"], reason: "y", now: NOW })).rejects.toThrow(/cannot be cancelled/);
      // One bad purpose among good ones refuses the whole call.
      await expect(
        cancelQueuedPlatformDms({ purposes: ["setup-ask", purpose as never], refIds: ["x"], reason: "y", now: NOW }),
      ).rejects.toThrow(/cannot be cancelled/);
    }
    expect(dbMock.$queryRaw).not.toHaveBeenCalled();
  });

  it("refuses a cancel that names no purpose or no refId (it would otherwise match nothing, silently)", async () => {
    await expect(cancelQueuedPlatformDms({ purposes: [], refIds: ["x"], reason: "y", now: NOW })).rejects.toThrow(/at least one/);
    await expect(cancelQueuedPlatformDms({ purposes: ["setup-ask"], refIds: [], reason: "y", now: NOW })).rejects.toThrow(/at least one/);
    await expect(cancelQueuedPlatformDms({ purposes: ["setup-ask"], refIds: [" "], reason: "y", now: NOW })).rejects.toThrow(/at least one/);
    expect(dbMock.$queryRaw).not.toHaveBeenCalled();
  });
});

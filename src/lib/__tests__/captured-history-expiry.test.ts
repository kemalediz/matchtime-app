/**
 * Captured group chat expires (2026-10-08): the rule's numbers, the two
 * bounded statements, and what is logged. The database is mocked here;
 * which rows really go is proved against Postgres in
 * e2e/api/captured-history-expiry.spec.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => [] as Array<{ sql: string; values: unknown[] }>);
const counts = vi.hoisted(() => ({ next: [3, 2] as number[] }));
vi.mock("@/lib/db", () => ({
  db: {
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ sql: strings.join("?"), values });
      return counts.next.shift() ?? 0;
    }),
  },
}));

import {
  CAPTURED_HISTORY_MAX_PER_RUN,
  CAPTURED_HISTORY_RETENTION_DAYS,
  capturedHistoryCutoffs,
  expireCapturedHistory,
} from "../captured-history-expiry";
import { SWEEP_WINDOW_DAYS } from "../setup-learning/run";

const NOW = new Date("2026-10-20T11:00:00Z");

beforeEach(() => {
  calls.length = 0;
  counts.next = [3, 2];
});

describe("the rule", () => {
  it("keeps captured chat for 7 days", () => {
    expect(CAPTURED_HISTORY_RETENTION_DAYS).toBe(7);
  });

  it("measures 7 days back, and protects exactly the window the learned-setup sweep reads", () => {
    const c = capturedHistoryCutoffs(NOW);
    expect(c.expireBefore.toISOString()).toBe("2026-10-13T11:00:00.000Z");
    expect(c.sweepReadsSince.toISOString()).toBe(new Date(NOW.getTime() - SWEEP_WINDOW_DAYS * 86_400_000).toISOString());
    expect(c.sweepReadsSince.toISOString()).toBe("2026-10-17T11:00:00.000Z");
  });
});

describe("expireCapturedHistory", () => {
  it("runs one bounded statement per table and returns the counts", async () => {
    const r = await expireCapturedHistory(NOW);
    expect(r).toEqual({ connectRequests: 3, onboardingSessions: 2 });
    expect(calls).toHaveLength(2);
    const [connect, session] = calls;

    expect(connect.sql).toContain(`UPDATE "ClubConnect" SET "capturedHistory" = NULL`);
    expect(connect.sql).toContain(`"capturedHistory" IS NOT NULL`);
    expect(connect.sql).toContain("LIMIT");
    // Measured from when the group was linked; a club approved inside the
    // sweep's window is left alone.
    expect(connect.sql).toContain(`"linkedAt"`);
    expect(connect.sql).toContain(`"approvedAt"`);
    expect(connect.values).toEqual(["2026-10-13 11:00:00.000", "2026-10-17 11:00:00.000", CAPTURED_HISTORY_MAX_PER_RUN]);

    expect(session.sql).toContain(`UPDATE "OnboardingSession" SET "capturedHistory" = NULL`);
    expect(session.sql).toContain(`"capturedHistory" IS NOT NULL`);
    expect(session.sql).toContain(`'completed'`);
    expect(session.sql).toContain(`'abandoned'`);
    expect(session.sql).toContain("LIMIT");
    expect(session.values).toEqual(["2026-10-13 11:00:00.000", CAPTURED_HISTORY_MAX_PER_RUN]);
  });

  it("never selects or returns the chat itself", async () => {
    await expireCapturedHistory(NOW);
    for (const c of calls) expect(c.sql).not.toMatch(/RETURNING|SELECT\s+\*/i);
  });

  it("logs counts only, and nothing at all when nothing expired", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await expireCapturedHistory(NOW);
    expect(log.mock.calls).toEqual([
      ["[captured-history] expired after 7 days: 3 connect request(s), 2 onboarding session(s)"],
    ]);
    log.mockClear();
    counts.next = [0, 0];
    expect(await expireCapturedHistory(NOW)).toEqual({ connectRequests: 0, onboardingSessions: 0 });
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });
});

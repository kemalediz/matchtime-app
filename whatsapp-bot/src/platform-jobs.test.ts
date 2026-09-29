/**
 * The Pi's half of the PLATFORM CHANNEL (self-join slice 3).
 *
 * Once per scheduler tick the Pi asks /api/whatsapp/platform-jobs for work
 * that belongs to no club (sign-up codes today; the connect reply, the
 * owner's approval DM and leaving a group later), whatever the clubs'
 * switches say. The server has already CLAIMED each job it hands over, so
 * the Pi must report every one:
 *
 *   sent     the send resolved (with the message id when there is one)
 *   failed   the send threw or timed out. Reported as FAILED, never as
 *            sent, and not retried (a timed-out send may have landed).
 *   release  the one-DM-a-minute pacing held it. The server re-queues it.
 *
 * A DM spends the same pacing slot as a club's DMs (WhatsApp restricted
 * the number for 21 hours after ~56 DMs in a burst). Leaving a group is
 * not a DM and is not paced.
 */
import { describe, it, expect, vi } from "vitest";
import { runPlatformJobs, type PlatformPollDeps } from "./platform-jobs.js";
import type { WaDriver } from "./driver.js";

function setup(over: Partial<PlatformPollDeps> = {}, jobs: unknown[] | null = []) {
  const calls: Array<[string, ...unknown[]]> = [];
  const driver = {
    sendDirectText: vi.fn(async (phone: string, text: string) => {
      calls.push(["sendDirectText", phone, text]);
      return { key: { id: "wa-1" }, id: { _serialized: "true_447700900123@c.us_wa-1" } };
    }),
    leaveGroup: vi.fn(async (groupId: string) => {
      calls.push(["leaveGroup", groupId]);
    }),
  } as unknown as WaDriver;
  const reports: unknown[] = [];
  let slots = 1;
  const deps: PlatformPollDeps = {
    driver,
    fetchJobs: vi.fn(async () => jobs as never),
    report: vi.fn(async (r) => {
      reports.push(r);
    }),
    takeDmSlot: vi.fn(() => {
      if (slots <= 0) return false;
      slots--;
      return true;
    }),
    sendTimeoutMs: 1_000,
    log: () => {},
    error: () => {},
    ...over,
  };
  return { deps, driver, calls, reports, setSlots: (n: number) => (slots = n) };
}

const DM = { id: "pj1", kind: "dm", phone: "447700900123", text: "Your code: 123456", purpose: "otp" };
const LEAVE = { id: "pj2", kind: "leave-group", groupId: "120363900000000001@g.us" };

describe("runPlatformJobs", () => {
  it("does nothing when the server has nothing (or is too old to answer)", async () => {
    const { deps, calls, reports } = setup({}, null);
    expect(await runPlatformJobs(deps)).toEqual({ sent: 0, failed: 0, released: 0 });
    expect(calls).toEqual([]);
    expect(reports).toEqual([]);
  });

  it("sends a DM to the bare phone and reports it sent with its message id", async () => {
    const { deps, calls, reports } = setup({}, [DM]);
    expect(await runPlatformJobs(deps)).toEqual({ sent: 1, failed: 0, released: 0 });
    expect(calls).toEqual([["sendDirectText", "447700900123", "Your code: 123456"]]);
    expect(reports).toEqual([{ id: "pj1", outcome: "sent", waMessageId: "true_447700900123@c.us_wa-1" }]);
  });

  it("a DM whose send THROWS is reported failed with the reason, never sent", async () => {
    const { deps, reports } = setup(
      {
        driver: {
          sendDirectText: async () => {
            throw new Error("not on WhatsApp");
          },
        } as unknown as WaDriver,
      },
      [DM],
    );
    expect(await runPlatformJobs(deps)).toEqual({ sent: 0, failed: 1, released: 0 });
    expect(reports).toEqual([{ id: "pj1", outcome: "failed", error: expect.stringContaining("not on WhatsApp") }]);
  });

  it("a DM whose send HANGS is reported failed after the timeout", async () => {
    vi.useFakeTimers();
    try {
      const { deps, reports } = setup(
        { driver: { sendDirectText: () => new Promise(() => {}) } as unknown as WaDriver },
        [DM],
      );
      const run = runPlatformJobs(deps);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await run).toEqual({ sent: 0, failed: 1, released: 0 });
      expect(reports).toEqual([{ id: "pj1", outcome: "failed", error: expect.stringMatching(/timed out/) }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases a DM the pacing holds, and does not send it", async () => {
    const { deps, calls, reports, setSlots } = setup({}, [DM, { ...DM, id: "pj3" }]);
    setSlots(1);
    expect(await runPlatformJobs(deps)).toEqual({ sent: 1, failed: 0, released: 1 });
    expect(calls).toHaveLength(1);
    expect(reports).toEqual([
      { id: "pj1", outcome: "sent", waMessageId: expect.any(String) },
      { id: "pj3", outcome: "release" },
    ]);
  });

  it("leaves a group without spending a DM slot", async () => {
    const { deps, calls, reports, setSlots } = setup({}, [LEAVE]);
    setSlots(0);
    expect(await runPlatformJobs(deps)).toEqual({ sent: 1, failed: 0, released: 0 });
    expect(calls).toEqual([["leaveGroup", "120363900000000001@g.us"]]);
    expect(deps.takeDmSlot).not.toHaveBeenCalled();
    expect(reports).toEqual([{ id: "pj2", outcome: "sent" }]);
  });

  it("a leave that throws is reported failed", async () => {
    const { deps, reports } = setup(
      {
        driver: {
          leaveGroup: async () => {
            throw new Error("not-authorized");
          },
        } as unknown as WaDriver,
      },
      [LEAVE],
    );
    await runPlatformJobs(deps);
    expect(reports).toEqual([{ id: "pj2", outcome: "failed", error: expect.stringContaining("not-authorized") }]);
  });

  it("releases a kind this build does not know (the server is ahead), sending nothing", async () => {
    const { deps, calls, reports } = setup({}, [{ id: "pj9", kind: "group-invite-accept" }]);
    expect(await runPlatformJobs(deps)).toEqual({ sent: 0, failed: 0, released: 1 });
    expect(calls).toEqual([]);
    expect(reports).toEqual([{ id: "pj9", outcome: "release" }]);
  });

  it("reports a malformed DM as failed rather than sending to nobody", async () => {
    const { deps, calls, reports } = setup({}, [{ id: "pj4", kind: "dm", phone: "", text: "x" }]);
    await runPlatformJobs(deps);
    expect(calls).toEqual([]);
    expect(reports).toEqual([{ id: "pj4", outcome: "failed", error: expect.stringMatching(/malformed/) }]);
  });

  it("one job's report failing does not stop the next job", async () => {
    let n = 0;
    const { deps, calls } = setup(
      {
        report: vi.fn(async () => {
          if (n++ === 0) throw new Error("network");
        }),
      },
      [LEAVE, { ...LEAVE, id: "pj5", groupId: "120363900000000002@g.us" }],
    );
    await runPlatformJobs(deps);
    expect(calls.map((c) => c[1])).toEqual(["120363900000000001@g.us", "120363900000000002@g.us"]);
  });
});

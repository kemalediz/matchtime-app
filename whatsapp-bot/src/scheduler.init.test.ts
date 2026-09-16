/**
 * `ready` is not a once-only event. whatsapp-web.js re-runs `inject()` on
 * every page navigation (Client.js `framenavigated`) and emits `ready`
 * again from the SAME process. Seen on 2026-09-16: bot.log carried two
 * `WhatsApp bot is ready!` lines under one PID with NRestarts=0, and the
 * second one started a second polling interval.
 *
 * Two intervals is the duplicate-dispatch class that flooded a customer
 * group on 2026-07-19 (see scripts/deploy-pi.sh). The server's atomic
 * claim stops the same key going out twice, but a doubled poll rate on a
 * Pi that rate-limits DMs at 1/min is still wrong. So: one interval, ever.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const getDuePosts = vi.fn(async () => null);
vi.mock("./api.js", () => ({
  getDuePosts: (...a: unknown[]) => getDuePosts(...a),
  ackInstruction: vi.fn(),
  releaseInstruction: vi.fn(),
}));

const { initScheduler, stopScheduler } = await import("./scheduler.js");

const fakeClient = {} as never;
const orgs = [{ groupId: "447525334985-1607872139@g.us", orgName: "Sutton Football Club" }];

beforeEach(() => {
  vi.useFakeTimers();
  getDuePosts.mockClear();
});

afterEach(() => {
  stopScheduler();
  vi.useRealTimers();
});

describe("initScheduler is idempotent across repeat `ready` events", () => {
  it("starts exactly one polling interval however many times it is called", async () => {
    initScheduler(fakeClient, orgs);
    await vi.advanceTimersByTimeAsync(0); // the immediate kick-off tick
    const afterFirst = getDuePosts.mock.calls.length;
    expect(afterFirst).toBe(1);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      initScheduler(fakeClient, orgs);
      initScheduler(fakeClient, orgs);
    } finally {
      warn.mockRestore();
    }
    await vi.advanceTimersByTimeAsync(0);
    // No extra kick-off ticks from the repeats.
    expect(getDuePosts.mock.calls.length).toBe(afterFirst);

    // Two poll periods later: exactly two more ticks, not six.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getDuePosts.mock.calls.length).toBe(afterFirst + 2);
  });

  it("says so when a repeat is ignored", () => {
    const warns: string[] = [];
    const warn = vi
      .spyOn(console, "warn")
      .mockImplementation((...a: unknown[]) => void warns.push(a.map(String).join(" ")));
    try {
      initScheduler(fakeClient, orgs);
      initScheduler(fakeClient, orgs);
    } finally {
      warn.mockRestore();
    }
    expect(warns.join("\n")).toMatch(/already/i);
  });

  it("can be started again after stopScheduler", async () => {
    initScheduler(fakeClient, orgs);
    await vi.advanceTimersByTimeAsync(0);
    stopScheduler();
    initScheduler(fakeClient, orgs);
    await vi.advanceTimersByTimeAsync(0);
    expect(getDuePosts.mock.calls.length).toBe(2);
  });
});

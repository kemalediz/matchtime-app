/**
 * /api/cron/learn-setup also expires captured group chat (2026-10-08).
 * This pins the door: expiry runs on every authorised call, whether or
 * not SETUP_LEARNING_ENABLED is on, AFTER the sweep (so chat the sweep
 * reads in this run is read first), on the same clock, and a failure in
 * either half does not stop the other. The work itself is
 * captured-history-expiry.test.ts and e2e/api/captured-history-expiry.spec.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const order = vi.hoisted(() => [] as string[]);
const sweep = vi.hoisted(() =>
  vi.fn(async (_now: Date, opts: { enabled?: boolean }) => {
    order.push("sweep");
    return { enabled: opts.enabled ?? false, considered: 0, outcomes: [] };
  }),
);
const expire = vi.hoisted(() =>
  vi.fn(async (_now: Date) => {
    order.push("expire");
    return { connectRequests: 1, onboardingSessions: 0 };
  }),
);
vi.mock("@/lib/setup-learning/run", () => ({ runSetupLearningSweep: sweep }));
vi.mock("@/lib/captured-history-expiry", () => ({ expireCapturedHistory: expire }));

import { GET } from "../learn-setup/route";

const ENV = { ...process.env };
beforeEach(() => {
  process.env.CRON_SECRET = "s3cret";
  delete process.env.MT_TEST_MODE;
  delete process.env.SETUP_LEARNING_ENABLED;
  order.length = 0;
  sweep.mockClear();
  expire.mockClear();
});
afterEach(() => {
  process.env = { ...ENV };
});

const req = (headers: Record<string, string> = { authorization: "Bearer s3cret" }) =>
  new Request("https://mt.test/api/cron/learn-setup", { headers });

describe("GET /api/cron/learn-setup: captured chat expiry", () => {
  it("refuses without the cron secret, and expires nothing", async () => {
    expect((await GET(req({}))).status).toBe(401);
    expect(expire).not.toHaveBeenCalled();
  });

  it("flag off: the sweep does nothing, expiry still runs", async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      enabled: false,
      considered: 0,
      outcomes: [],
      expired: { connectRequests: 1, onboardingSessions: 0 },
    });
    expect(expire).toHaveBeenCalledTimes(1);
  });

  it("flag on: the sweep reads first, then expiry, on the same clock", async () => {
    process.env.SETUP_LEARNING_ENABLED = "1";
    await GET(req());
    expect(order).toEqual(["sweep", "expire"]);
    expect(expire.mock.calls[0][0]).toBe(sweep.mock.calls[0][0]);
  });

  it("a sweep that throws does not stop expiry, and the route still fails loudly", async () => {
    sweep.mockRejectedValueOnce(new Error("boom"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await GET(req());
    expect(expire).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(500);
    err.mockRestore();
  });

  it("an expiry that throws still returns the sweep's report", async () => {
    expire.mockRejectedValueOnce(new Error("boom"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ enabled: false, expired: null });
    err.mockRestore();
  });
});

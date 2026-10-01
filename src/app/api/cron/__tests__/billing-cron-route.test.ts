/**
 * Club fee billing, slice B4: /api/cron/billing, hourly from vercel.json,
 * behind CRON_SECRET like every other cron. The work is runBillingCron
 * (club-billing-b4.test.ts); this pins the door: the secret, the test
 * clock (only under MT_TEST_MODE), and the schedule.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const run = vi.hoisted(() => vi.fn(async (now: Date) => ({ enabled: true, daytime: true, refunds: { finished: 0, failed: 0 }, clubs: [], now: now.toISOString() })));
vi.mock("@/lib/club-billing-scheduler", () => ({ runBillingCron: run }));

import { GET } from "../billing/route";

const ENV = { ...process.env };
beforeEach(() => {
  process.env.CRON_SECRET = "s3cret";
  delete process.env.MT_TEST_MODE;
  run.mockClear();
});
afterEach(() => {
  process.env = { ...ENV };
});

const req = (headers: Record<string, string>) => new Request("https://mt.test/api/cron/billing", { headers });

describe("GET /api/cron/billing", () => {
  it("refuses without the cron secret, and never runs", async () => {
    expect((await GET(req({}))).status).toBe(401);
    expect((await GET(req({ authorization: "Bearer wrong" }))).status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });

  it("runs with the secret, on the real clock", async () => {
    const before = Date.now();
    const res = await GET(req({ authorization: "Bearer s3cret", "x-test-now": "2026-10-22T09:00:00Z" }));
    expect(res.status).toBe(200);
    const at = (run.mock.calls[0][0] as Date).getTime();
    expect(at).toBeGreaterThanOrEqual(before);
  });

  it("x-test-now pins the clock only under MT_TEST_MODE=1", async () => {
    process.env.MT_TEST_MODE = "1";
    await GET(req({ authorization: "Bearer s3cret", "x-test-now": "2026-10-22T09:00:00Z" }));
    expect((run.mock.calls[0][0] as Date).toISOString()).toBe("2026-10-22T09:00:00.000Z");
  });

  it("is scheduled hourly in vercel.json", () => {
    const cfg = JSON.parse(readFileSync(path.resolve(__dirname, "../../../../../vercel.json"), "utf8")) as { crons: Array<{ path: string; schedule: string }> };
    expect(cfg.crons).toContainEqual({ path: "/api/cron/billing", schedule: "0 * * * *" });
  });
});

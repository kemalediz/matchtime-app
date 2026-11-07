/**
 * /api/cron/cloud-dispatch (WhatsApp Cloud API plan, PR C4): the
 * per-minute sweep. Behind CRON_SECRET like every cron; the work is
 * `runCloudDispatchSweep` (its own tests pin the flags off path). The
 * test clock is honoured only under MT_TEST_MODE=1. And the schedule is
 * in vercel.json, every minute.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sweep = vi.hoisted(() => ({ runCloudDispatchSweep: vi.fn() }));
vi.mock("@/lib/cloud-api/dispatch", () => sweep);
const switchEnv = vi.hoisted(() => ({ poolEnvForApiRequest: vi.fn() }));
vi.mock("@/lib/pool/switch-env", () => switchEnv);

import { GET } from "../cloud-dispatch/route";

const SECRET = "cron-secret";
const get = (headers: Record<string, string> = { authorization: `Bearer ${SECRET}` }) => GET(new Request("http://x/api/cron/cloud-dispatch", { headers }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CRON_SECRET", SECRET);
  sweep.runCloudDispatchSweep.mockResolvedValue({ enabled: false, configured: false, claimed: 0 });
  switchEnv.poolEnvForApiRequest.mockResolvedValue({ POOL: "1" });
});
afterEach(() => vi.unstubAllEnvs());

describe("GET /api/cron/cloud-dispatch", () => {
  it("401 without the cron secret, and nothing runs", async () => {
    expect((await get({})).status).toBe(401);
    expect((await get({ authorization: "Bearer nope" })).status).toBe(401);
    expect(sweep.runCloudDispatchSweep).not.toHaveBeenCalled();
  });

  it("runs the sweep and returns its report", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false, configured: false, claimed: 0 });
    expect(sweep.runCloudDispatchSweep).toHaveBeenCalledTimes(1);
  });

  it("the pool switch is the request's, resolved only when the sweep asks", async () => {
    await get();
    expect(switchEnv.poolEnvForApiRequest).not.toHaveBeenCalled();
    const { poolEnv } = sweep.runCloudDispatchSweep.mock.calls[0][0];
    expect(await poolEnv()).toEqual({ POOL: "1" });
    expect(switchEnv.poolEnvForApiRequest).toHaveBeenCalledTimes(1);
  });

  it("the test clock only under MT_TEST_MODE=1", async () => {
    const at = "2026-11-07T09:00:00.000Z";
    vi.stubEnv("MT_TEST_MODE", "1");
    await get({ authorization: `Bearer ${SECRET}`, "x-test-now": at });
    expect(sweep.runCloudDispatchSweep.mock.calls[0][0].now.toISOString()).toBe(at);
    vi.stubEnv("MT_TEST_MODE", "");
    await get({ authorization: `Bearer ${SECRET}`, "x-test-now": at });
    expect(sweep.runCloudDispatchSweep.mock.calls[1][0].now.toISOString()).not.toBe(at);
  });

  it("a failed sweep is a 500 with no detail, never a crash", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    sweep.runCloudDispatchSweep.mockRejectedValueOnce(new Error("db down"));
    const res = await get();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "sweep failed" });
  });
});

describe("vercel.json", () => {
  it("runs the sweep every minute", () => {
    const json = JSON.parse(readFileSync(path.resolve(__dirname, "../../../../../vercel.json"), "utf8")) as { crons: Array<{ path: string; schedule: string }> };
    expect(json.crons).toContainEqual({ path: "/api/cron/cloud-dispatch", schedule: "* * * * *" });
  });
});

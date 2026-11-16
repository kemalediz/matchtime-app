/**
 * The daily 06:00 cron (`/api/cron/close-ratings`) runs the retention
 * sweeps: the pool's housekeeping, tagged people after 7 days, and since
 * 2026-11-13 the /play visit breakdown after 90 days (daily totals since 2026-11-16). Only Vercel's cron, with
 * CRON_SECRET, may run it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const pool = vi.hoisted(() => ({ poolHousekeeping: vi.fn() }));
vi.mock("@/lib/pool/housekeeping", () => pool);
const mentions = vi.hoisted(() => ({ purgeOldMentions: vi.fn() }));
vi.mock("@/lib/group-mentions", () => mentions);
const visits = vi.hoisted(() => ({ purgeOldPoolVisitDaily: vi.fn() }));
vi.mock("@/lib/pool/visits", () => visits);

import { GET } from "../../cron/close-ratings/route";

const call = (auth?: string) => GET(new Request("http://localhost/api/cron/close-ratings", { headers: auth ? { authorization: auth } : {} }));

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = "s3cret";
  pool.poolHousekeeping.mockResolvedValue({ pendingDeleted: 0 });
  mentions.purgeOldMentions.mockResolvedValue(0);
  visits.purgeOldPoolVisitDaily.mockResolvedValue(12);
});

describe("GET /api/cron/close-ratings", () => {
  it("deletes the /play daily visit breakdown older than 90 days and says how many", async () => {
    const res = await call("Bearer s3cret");
    expect(res.status).toBe(200);
    expect(visits.purgeOldPoolVisitDaily).toHaveBeenCalledTimes(1);
    expect(await res.json()).toMatchObject({ ok: true, visitTotalsDeleted: 12 });
  });

  it("a housekeeping failure never keeps the breakdown past its 90 days", async () => {
    pool.poolHousekeeping.mockRejectedValue(new Error("pool down"));
    await expect(call("Bearer s3cret")).rejects.toThrow("pool down");
    expect(visits.purgeOldPoolVisitDaily).toHaveBeenCalledTimes(1);
  });

  it("without the cron secret: 401, and nothing is deleted", async () => {
    for (const auth of [undefined, "Bearer wrong"]) expect((await call(auth)).status).toBe(401);
    expect(visits.purgeOldPoolVisitDaily).not.toHaveBeenCalled();
    expect(pool.poolHousekeeping).not.toHaveBeenCalled();
  });
});

/**
 * THE CLOUD DISPATCH CRON DOES NO DATABASE WORK WITH THE FLAGS OFF
 * (WhatsApp Cloud API plan, PR C4).
 *
 * The real route, the real dispatcher, the real pool sweeps and the real
 * pool switch reader: only the database is replaced, by a stand-in that
 * records every touch. With CLOUD_API_ENABLED unset (the default) the
 * per-minute cron reads nothing, writes nothing and calls nobody: not the
 * claim, not the pool switch row, not the pool sweeps (those stay the
 * Pi's alone, run from its platform poll as before) and not the network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const touched = vi.hoisted(() => [] as string[]);
vi.mock("@/lib/db", () => {
  const recorder = (path: string): unknown =>
    new Proxy(() => undefined, {
      get: (_t, key) => {
        if (key === "then") return undefined;
        const p = `${path}.${String(key)}`;
        touched.push(p);
        return recorder(p);
      },
      apply: () => {
        touched.push(`${path}()`);
        throw new Error(`database touched: ${path}`);
      },
    });
  return { db: recorder("db") };
});

import { GET } from "../cloud-dispatch/route";

const SECRET = "cron-secret";
const fetchSpy = vi.fn();

beforeEach(() => {
  touched.length = 0;
  fetchSpy.mockReset();
  vi.stubGlobal("fetch", fetchSpy);
  vi.stubEnv("CRON_SECRET", SECRET);
  vi.stubEnv("CLOUD_API_ENABLED", undefined as unknown as string);
  vi.stubEnv("CLOUD_API_PURPOSES", "otp,pool-offer,pool-placed");
  vi.stubEnv("WA_CLOUD_ACCESS_TOKEN", "t");
  vi.stubEnv("WA_CLOUD_PHONE_NUMBER_ID", "1");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("GET /api/cron/cloud-dispatch with CLOUD_API_ENABLED unset", () => {
  it("answers, and touches no database, no pool sweep and no network", async () => {
    const res = await GET(new Request("http://x/api/cron/cloud-dispatch", { headers: { authorization: `Bearer ${SECRET}` } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ enabled: false, claimed: 0 });
    expect(touched).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the stand-in is not vacuous: switched on, the same route does reach the database", async () => {
    vi.stubEnv("CLOUD_API_ENABLED", "1");
    vi.spyOn(console, "error").mockImplementation(() => {});
    await GET(new Request("http://x/api/cron/cloud-dispatch", { headers: { authorization: `Bearer ${SECRET}` } }));
    expect(touched.length).toBeGreaterThan(0);
  });
});

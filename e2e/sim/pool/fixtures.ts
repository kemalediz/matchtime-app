/**
 * The pool scenario fixture (2026-10-24, slice L1): every scenario gets a
 * fresh `pool` world (world.ts) on the shared e2e fixtures, and a failed
 * scenario gets its transcript attached and printed.
 *
 *   import { scenario, scenarios, stubbedOnly, liveOnly, expect } from "./fixtures";
 *
 *   scenarios("a stranger messages MatchTime", () => {
 *     scenario("a plain DM is ignored", async ({ pool }) => { ... });
 *   });
 *
 * Three kinds of scenario:
 *   model-free (or stubbed through `pool.arm`): the default. Runs in every
 *               run and costs $0.
 *   stubbedOnly() first in the body: the scenario's stubs are what it
 *               tests, so it is skipped in a live run (where `pool.arm`
 *               does nothing).
 *   liveOnly()  first in the body: runs only under MT_SIM_LIVE_LLM=1, on
 *               the developer key ANTHROPIC_API_KEY_DEV, and FAILS without
 *               that key rather than skip or fall back (the orchestrator
 *               refuses too, `e2e/run.ts`). Paid: the slice that adds one
 *               reports its calls and cost, and asks Kemal above $2.
 */
import { setPoolPlatform } from "../../helpers/pool-platform";
import { test as base, expect, resetDb } from "../../fixtures";
import { requireDevApiKey } from "../../helpers/dev-api-key";
import { clearGeocodeStub, setGeocodeStub } from "../../helpers/geocode-stub";
import { PoolWorld } from "./world";

export const LIVE = process.env.MT_SIM_LIVE_LLM === "1";

/** Google's answer for a UK postcode district (one shape for every stubbed lookup). */
const UK_POINT = {
  status: "OK",
  results: [
    {
      place_id: "e2e-pool-district",
      formatted_address: "Sutton SM1, UK",
      geometry: { location: { lat: 51.3656, lng: -0.1963 }, location_type: "APPROXIMATE" },
      types: ["postal_code_prefix", "postal_code"],
      address_components: [{ long_name: "United Kingdom", short_name: "GB", types: ["country", "political"] }],
    },
  ],
};

/** One pool scenario: `scenario("...", async ({ pool }) => { ... })`. */
export const scenario = base.extend<{ pool: PoolWorld }>({
  pool: async ({ request, db }, provide, testInfo) => {
    const world = new PoolWorld(request, db, LIVE);
    await world.start();
    // The platform switch ON, as in production (the owner's row, 2026-10-28).
    // A scenario that wants it off says so (the `x-mt-test-pool-open` seam).
    await setPoolPlatform(db, true);
    // A postcode district is placed by Google (stubbed): every address gets
    // a point in the UK, so a /play sign-up near "SM1" has its centre.
    setGeocodeStub({ geocode: { "*": { body: UK_POINT } } });
    await provide(world);
    clearGeocodeStub();
    if (testInfo.status !== testInfo.expectedStatus) {
      const transcript = world.transcript();
      await testInfo.attach("transcript", { body: transcript, contentType: "text/plain" });
      console.log(`\n--- transcript: ${testInfo.title} ---\n${transcript}\n`);
    }
  },
});

/** A group of scenarios on a freshly seeded database, run in order. */
export function scenarios(title: string, fn: () => void): void {
  scenario.describe(title, () => {
    scenario.describe.configure({ mode: "serial" });
    scenario.beforeAll(() => resetDb());
    scenario.afterAll(() => resetDb());
    fn();
  });
}

/** First line of a scenario whose stubs are the thing under test. */
export function stubbedOnly(): void {
  scenario.skip(LIVE, "stubbed scenario: its stubs are bypassed in a live run");
}

/** First line of a scenario that needs the real model. */
export function liveOnly(): void {
  scenario.skip(!LIVE, "live scenario: run with MT_SIM_LIVE_LLM=1 (spends ANTHROPIC_API_KEY_DEV)");
  requireDevApiKey("a live pool scenario (e2e/sim/pool)");
}

export { expect };

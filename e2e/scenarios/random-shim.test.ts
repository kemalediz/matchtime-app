import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rehearsalServerEnv } from "../helpers/env";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const shim = require("./random-shim.cjs") as {
  makeSeededRandom: (seed: string) => { random: () => number; onRequest: (method: string, url: string) => void };
};

const draw = (r: { random: () => number }, n = 5) => Array.from({ length: n }, () => r.random());

describe("makeSeededRandom", () => {
  it("draws the same numbers for the same request, however much was drawn before it", () => {
    const a = shim.makeSeededRandom("vets");
    const b = shim.makeSeededRandom("vets");
    a.onRequest("GET", "/api/cron/generate-teams");
    draw(b, 17); // b drew a lot before its request
    b.onRequest("GET", "/api/cron/generate-teams?x=1");
    expect(draw(a)).toEqual(draw(b));
  });

  it("gives the second request to a path its own numbers, and another seed others", () => {
    const a = shim.makeSeededRandom("vets");
    a.onRequest("POST", "/api/whatsapp/admin-group");
    const first = draw(a);
    a.onRequest("POST", "/api/whatsapp/admin-group");
    expect(draw(a)).not.toEqual(first);
    const c = shim.makeSeededRandom("fnf");
    c.onRequest("POST", "/api/whatsapp/admin-group");
    expect(draw(c)).not.toEqual(first);
  });

  it("the one preload loads both the clock and the random shim", () => {
    const src = readFileSync(path.join(__dirname, "server-shims.cjs"), "utf8");
    expect(src).toContain('require("../rehearsal/clock-shim.cjs")');
    expect(src).toContain('require("./random-shim.cjs")');
  });

  it("stays in [0, 1)", () => {
    const a = shim.makeSeededRandom("x");
    for (const v of draw(a, 1000)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe("the server's shims for a scenario run", () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  });

  it("loads the moving clock and the repeatable random for a scenario run", () => {
    const env = rehearsalServerEnv({ MT_SCENARIO_CASSETTE: "replay" });
    expect(env.NODE_OPTIONS).toContain("server-shims.cjs");
    expect(env.MT_SCENARIO_RANDOM_SEED).toBeTruthy();
    expect(env.MT_REHEARSAL_CLOCK_FILE).toBeTruthy();
    expect(rehearsalServerEnv({ MT_SCENARIOS_DRY: "1" }).NODE_OPTIONS).toContain("server-shims.cjs");
  });

  it("loads only the clock for a plain rehearsal, and nothing at all otherwise", () => {
    const reh = rehearsalServerEnv({ MT_REHEARSAL_SCENARIO: "x.json" });
    expect(reh.NODE_OPTIONS).toContain("clock-shim.cjs");
    expect(reh.NODE_OPTIONS).not.toContain("server-shims.cjs");
    expect(rehearsalServerEnv({})).toEqual({});
  });
});

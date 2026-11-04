import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildTestEnv } from "../helpers/env";
import { CASSETTE_DIR_ENV, CASSETTE_ENV, REPLAY_PLACEHOLDER_KEY, cassetteDir, cassetteMode } from "./mode";

const saved = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

describe("cassetteMode", () => {
  it("is off unless asked for", () => {
    expect(cassetteMode({})).toBeNull();
    expect(cassetteMode({ [CASSETTE_ENV]: "" })).toBeNull();
    expect(cassetteMode({ [CASSETTE_ENV]: "record" })).toBe("record");
    expect(cassetteMode({ [CASSETTE_ENV]: "replay" })).toBe("replay");
  });

  it("refuses a mode it does not know rather than guessing", () => {
    expect(() => cassetteMode({ [CASSETTE_ENV]: "replya" })).toThrow(/record or replay/);
  });

  it("defaults the recordings to the committed directory", () => {
    expect(cassetteDir({})).toMatch(/e2e\/scenarios\/recordings$/);
    expect(cassetteDir({ [CASSETTE_DIR_ENV]: "/tmp/x" })).toBe("/tmp/x");
  });
});

describe("the server's key under each mode", () => {
  it("a live run with no cassette is exactly as before: the developer key", () => {
    process.env.MT_SIM_LIVE_LLM = "1";
    process.env.ANTHROPIC_API_KEY_DEV = "sk-dev-test-key";
    delete process.env[CASSETTE_ENV];
    expect(buildTestEnv().ANTHROPIC_API_KEY).toBe("sk-dev-test-key");
  });

  it("a record run spends the developer key, never the production one", () => {
    process.env.MT_SIM_LIVE_LLM = "1";
    process.env.ANTHROPIC_API_KEY_DEV = "sk-dev-test-key";
    process.env.ANTHROPIC_API_KEY = "sk-prod-must-not-appear";
    process.env[CASSETTE_ENV] = "record";
    expect(buildTestEnv().ANTHROPIC_API_KEY).toBe("sk-dev-test-key");
  });

  it("a replay run hands the server NO real key at all, and needs none", () => {
    process.env.MT_SIM_LIVE_LLM = "1";
    process.env.ANTHROPIC_API_KEY_DEV = "sk-dev-test-key";
    process.env[CASSETTE_ENV] = "replay";
    const env = buildTestEnv();
    expect(env.ANTHROPIC_API_KEY).toBe(REPLAY_PLACEHOLDER_KEY);
    expect(Object.values(env)).not.toContain("sk-dev-test-key");
    delete process.env.ANTHROPIC_API_KEY_DEV;
    expect(() => buildTestEnv()).not.toThrow();
  });

  it("a stubbed run is untouched by the cassette variable", () => {
    delete process.env.MT_SIM_LIVE_LLM;
    process.env[CASSETTE_ENV] = "replay";
    expect(buildTestEnv().ANTHROPIC_API_KEY).toBe("");
  });
});

describe("production code", () => {
  it("never reads the cassette's variables or endpoints (the seam is the base URL, outside src/)", () => {
    const root = path.resolve(__dirname, "../../src");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = path.join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx|js|cjs|mjs)$/.test(f) && /MT_SCENARIO_CASSETTE|__cassette/.test(readFileSync(p, "utf8"))) offenders.push(p);
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});

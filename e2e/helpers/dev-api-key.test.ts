/**
 * The dev key resolver: it must FAIL, never fall back.
 *
 * `MDs/llm-spend-september-2026.md` measured the problem this module
 * exists for: in September the harnesses made about 18,500 model calls
 * on the SAME key as the 77 the live bot made, so the real cost of
 * running MatchTime (about $4 per club per month) was invisible
 * underneath our own testing.
 *
 * The fix is one variable, `ANTHROPIC_API_KEY_DEV`, and one rule: a
 * harness that cannot find it STOPS. A quiet fall back to
 * `ANTHROPIC_API_KEY` would put every development call back on the
 * production key with nobody noticing, which is precisely the failure
 * being fixed. So the "falls back to nothing" cases below are the point
 * of the file, not edge cases around it.
 */
import { describe, it, expect } from "vitest";
import {
  type MutableEnv,
  DEV_KEY_ENV,
  PROD_KEY_ENV,
  DevApiKeyMissingError,
  forgetProductionApiKey,
  readDevApiKey,
  requireDevApiKey,
  spendDevApiKey,
} from "./dev-api-key";

const HARNESS = "scripts/example-harness.ts";

describe("the variable names", () => {
  it("names the dev key separately from the production key", () => {
    expect(DEV_KEY_ENV).toBe("ANTHROPIC_API_KEY_DEV");
    expect(PROD_KEY_ENV).toBe("ANTHROPIC_API_KEY");
  });
});

describe("readDevApiKey", () => {
  it("returns the trimmed dev key when it is set", () => {
    expect(readDevApiKey({ [DEV_KEY_ENV]: "  sk-ant-dev  " })).toBe("sk-ant-dev");
  });

  it("returns null when the dev key is absent", () => {
    expect(readDevApiKey({})).toBeNull();
  });

  it("returns null when the dev key is blank or whitespace", () => {
    expect(readDevApiKey({ [DEV_KEY_ENV]: "" })).toBeNull();
    expect(readDevApiKey({ [DEV_KEY_ENV]: "   " })).toBeNull();
  });

  it("does NOT read the production key, however tempting", () => {
    expect(readDevApiKey({ [PROD_KEY_ENV]: "sk-ant-prod" })).toBeNull();
  });
});

describe("requireDevApiKey", () => {
  it("returns the dev key when it is set", () => {
    expect(requireDevApiKey(HARNESS, { [DEV_KEY_ENV]: "sk-ant-dev" })).toBe("sk-ant-dev");
  });

  it("throws when the dev key is missing, naming the variable and the harness", () => {
    let thrown: unknown;
    try {
      requireDevApiKey(HARNESS, {});
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(DevApiKeyMissingError);
    const message = (thrown as Error).message;
    expect(message).toContain(DEV_KEY_ENV);
    expect(message).toContain(HARNESS);
  });

  it("throws rather than falling back, even with a perfectly good production key present", () => {
    expect(() => requireDevApiKey(HARNESS, { [PROD_KEY_ENV]: "sk-ant-prod" })).toThrow(
      DevApiKeyMissingError,
    );
  });

  it("says, in the refusal, that the production key is not a fallback", () => {
    let message = "";
    try {
      requireDevApiKey(HARNESS, { [PROD_KEY_ENV]: "sk-ant-prod" });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/not a fallback|never falls back|will not fall back/i);
    expect(message).toContain("MDs/llm-spend-september-2026.md");
  });

  it("never puts the key value itself in the refusal", () => {
    let message = "";
    try {
      requireDevApiKey(HARNESS, { [DEV_KEY_ENV]: "   ", [PROD_KEY_ENV]: "sk-ant-prod-secret" });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).not.toContain("sk-ant-prod-secret");
  });
});

describe("spendDevApiKey", () => {
  it("overwrites the production variable in this process with the dev key", () => {
    // The seam. Shared library code under src/ keeps reading
    // ANTHROPIC_API_KEY and is not edited; the HARNESS decides what that
    // name resolves to inside its own process.
    const env = { [DEV_KEY_ENV]: "sk-ant-dev", [PROD_KEY_ENV]: "sk-ant-prod" };
    expect(spendDevApiKey(HARNESS, env)).toBe("sk-ant-dev");
    expect(env[PROD_KEY_ENV]).toBe("sk-ant-dev");
  });

  it("sets the production variable even when it was not previously set", () => {
    const env: MutableEnv = { [DEV_KEY_ENV]: "sk-ant-dev" };
    spendDevApiKey(HARNESS, env);
    expect(env[PROD_KEY_ENV]).toBe("sk-ant-dev");
  });

  it("leaves the production key ALONE when it refuses, so nothing half-happens", () => {
    const env: MutableEnv = { [PROD_KEY_ENV]: "sk-ant-prod" };
    expect(() => spendDevApiKey(HARNESS, env)).toThrow(DevApiKeyMissingError);
    expect(env[PROD_KEY_ENV]).toBe("sk-ant-prod");
  });
});

describe("forgetProductionApiKey", () => {
  it("removes the production key from the process env", () => {
    const env: MutableEnv = { [PROD_KEY_ENV]: "sk-ant-prod", [DEV_KEY_ENV]: "sk-ant-dev" };
    forgetProductionApiKey(env);
    expect(env[PROD_KEY_ENV]).toBeUndefined();
  });

  it("leaves the dev key in place", () => {
    const env: MutableEnv = { [PROD_KEY_ENV]: "sk-ant-prod", [DEV_KEY_ENV]: "sk-ant-dev" };
    forgetProductionApiKey(env);
    expect(env[DEV_KEY_ENV]).toBe("sk-ant-dev");
  });

  it("is a no-op when there is no production key to forget", () => {
    const env: MutableEnv = {};
    expect(() => forgetProductionApiKey(env)).not.toThrow();
    expect(env[PROD_KEY_ENV]).toBeUndefined();
  });
});

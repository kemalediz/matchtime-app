/**
 * The pure rules of `scripts/set-match-result.ts` (2026-11-16, review of
 * #609): its time limits for who-is-who, the client settings it builds,
 * which test stub variables count as set, and how it reads its arguments.
 * No network, no database.
 */
import { describe, expect, it } from "vitest";
import {
  WHO_IS_WHO_CLIENT_MAX_RETRIES,
  WHO_IS_WHO_TIMEOUT_MS,
  readArgs,
  stubsOnRealData,
  whoIsWhoClientOptions,
  whoIsWhoTimeoutMs,
} from "../set-match-result-rules";

describe("who-is-who's limits", () => {
  it("allows 60 seconds in all by default", () => {
    expect(WHO_IS_WHO_TIMEOUT_MS).toBe(60_000);
    expect(whoIsWhoTimeoutMs({})).toBe(60_000);
  });

  it("takes the e2e override only when it is a positive number of milliseconds", () => {
    expect(whoIsWhoTimeoutMs({ MT_TEST_WHO_IS_WHO_TIMEOUT_MS: "1500" })).toBe(1500);
    for (const junk of ["", " ", "0", "-5", "abc"]) expect(whoIsWhoTimeoutMs({ MT_TEST_WHO_IS_WHO_TIMEOUT_MS: junk }), junk).toBe(60_000);
  });

  it("builds the client with the overall budget as its own timeout and ONE retry", () => {
    expect(WHO_IS_WHO_CLIENT_MAX_RETRIES).toBe(1);
    expect(whoIsWhoClientOptions("sk-ant-dev", 60_000)).toEqual({ apiKey: "sk-ant-dev", timeout: 60_000, maxRetries: 1 });
  });
});

describe("test stubs on real data", () => {
  const HARNESS = "postgresql://e2e:e2e@127.0.0.1:54400/matchtime_e2e";

  it("counts any MT_TEST_ variable with any value but exactly empty, whitespace included", () => {
    const env = { DATABASE_URL: "postgresql://ops@db.example/prod", MT_TEST_A: " ", MT_TEST_B: "", MT_TEST_C: "1", OTHER: "x" };
    expect(stubsOnRealData({ env, readersOn: false, harnessDbUrl: HARNESS })).toEqual(["MT_TEST_A", "MT_TEST_C"]);
  });

  it("asks the readers too: one that is on counts even with no MT_TEST_ variable seen", () => {
    expect(stubsOnRealData({ env: { DATABASE_URL: "postgresql://ops@db.example/prod" }, readersOn: true, harnessDbUrl: HARNESS })).toEqual(["a stub reader is on"]);
  });

  it("allows them only against the harness's database, compared exactly", () => {
    const env = { MT_TEST_A: "1" };
    expect(stubsOnRealData({ env: { ...env, DATABASE_URL: HARNESS }, readersOn: true, harnessDbUrl: HARNESS })).toEqual([]);
    for (const url of [`${HARNESS}_other`, HARNESS.slice(0, -1), undefined]) {
      expect(stubsOnRealData({ env: { ...env, DATABASE_URL: url }, readersOn: false, harnessDbUrl: HARNESS }), String(url)).toEqual(["MT_TEST_A"]);
    }
  });

  it("is nothing to refuse with no stub set", () => {
    expect(stubsOnRealData({ env: { DATABASE_URL: "postgresql://ops@db.example/prod", MT_TEST_A: "" }, readersOn: false, harnessDbUrl: HARNESS })).toEqual([]);
  });
});

describe("readArgs", () => {
  const err = (argv: string[]) => {
    const r = readArgs(argv);
    return r.ok ? null : r.error;
  };

  it("reads the flags", () => {
    expect(readArgs(["--match", "m1", "--score", "Yellow 7 Red 4", "--mom", "Pat", "--by", "Sue", "--apply"])).toEqual({
      ok: true,
      args: { match: "m1", score: "Yellow 7 Red 4", mom: "Pat", by: "Sue", apply: true },
    });
  });

  it("says --apply takes no value", () => {
    expect(err(["--match", "m1", "--apply=true"])).toBe('"--apply=true": --apply takes no value (write --apply)');
  });

  it("refuses the rest as before", () => {
    expect(err(["--mom=Pat"])).toBe('"--mom=Pat": write the value after a space (--mom <value>)');
    expect(err(["--mom", " "])).toBe("--mom needs a value");
    expect(err(["--mom", "--apply"])).toBe("--mom needs a value");
    expect(err(["--mom", "Pat", "--mom", "Omar"])).toBe("--mom is given twice");
    expect(err(["--moom", "Pat"])).toBe('unknown flag "--moom" (known: --match, --score, --mom, --by, --apply)');
    expect(err(["Pat"])).toBe('unexpected "Pat": every value goes after its flag (--mom <name>)');
  });
});

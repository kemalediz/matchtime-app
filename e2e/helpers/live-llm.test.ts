/**
 * Unit tests for the LIVE-model gate.
 *
 * The defect these were written against, reproduced on 034f694 in a
 * checkout with no `.env`:
 *
 *     $ npm run test:corpus:live
 *     …
 *     ✓ 1 …corpus-live.spec.ts › replays the whole corpus ×3 (4.0s)
 *     1 passed (7.3s)
 *
 * Four seconds, 8/47 cases, exit 0. Not one of the 141 "runs" reached
 * Anthropic: `buildTestEnv()` passes `ANTHROPIC_API_KEY: ""` through
 * when the orchestrator has no key, `getAnthropic()` returns null, and
 * every message gets `offlineVerdict(…, "ANTHROPIC_API_KEY not set")`.
 * A green tick on a measurement that never happened.
 *
 * The first test in this file is the one that matters: it runs the real
 * orchestrator with an empty key and requires it to REFUSE. Everything
 * else pins the pieces.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  OFFLINE_FATAL_PREFIXES,
  PROBE_MODEL,
  assertSeamMatchesMode,
  classifyReasoning,
  describeReach,
  keyFingerprint,
  liveReachFailure,
  probeAnthropic,
  reachWatermark,
  readReach,
  summariseReach,
} from "./live-llm";
import { E2EPreflightError } from "./preflight";
import { readFileSync } from "node:fs";

const REPO_ROOT = process.cwd();

/** Run the real orchestrator, keyless-live, and report what it did.
 *  `ANTHROPIC_API_KEY: ""` rather than deleted on purpose: dotenv leaves
 *  an already-present key alone, so this is deterministic whether or not
 *  the checkout has a `.env` — and an empty string is exactly the value
 *  `buildTestEnv()` hands the server when there is no key at all. */
function runOrchestratorKeylessLive(): { status: number | null; output: string } {
  const res = spawnSync("npx", ["tsx", "e2e/run.ts", "sim/corpus-live.spec.ts"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 120_000,
    env: {
      ...process.env,
      MT_SIM_LIVE_LLM: "1",
      ANTHROPIC_API_KEY: "",
      // Never fight a real run for this checkout's lock file.
      MT_E2E_RUN_LOCK: path.join(REPO_ROOT, ".e2e", "live-llm-test.lock"),
    },
  });
  return { status: res.status, output: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

describe("a live run with no usable key", () => {
  it(
    "refuses, names the missing key, and never reaches Playwright",
    () => {
      const { status, output } = runOrchestratorKeylessLive();
      expect(status, `orchestrator exited ${status}\n${output}`).not.toBe(0);
      expect(output).toMatch(/REFUSING to run/);
      expect(output).toMatch(/ANTHROPIC_API_KEY/);
      // The refusal must come BEFORE any work: no Postgres, no schema
      // push, no Playwright. A run that gets as far as a scoreboard has
      // already produced the numbers nobody should trust.
      expect(output).not.toMatch(/running Playwright/);
      expect(output).not.toMatch(/scoreboard|passed \(/i);
    },
    130_000,
  );
});

describe("keyFingerprint", () => {
  it("identifies a key without disclosing it", () => {
    const key = "sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFF";
    const fp = keyFingerprint(key);
    expect(fp).toContain("FFFF");
    expect(fp).not.toContain("AAAABBBB");
    // Short enough to be useless on its own: a handful of characters,
    // not a redaction that leaves most of the key behind.
    expect(fp.length).toBeLessThan(8);
  });

  it("never echoes a short key back whole", () => {
    expect(keyFingerprint("abcd")).not.toBe("abcd");
  });
});

describe("assertSeamMatchesMode", () => {
  const liveOk = { ANTHROPIC_API_KEY: "sk-ant-real", MT_TEST_LLM_STUB_FILE: "" };
  const stubOk = { ANTHROPIC_API_KEY: "", MT_TEST_LLM_STUB_FILE: "/tmp/stub.json" };

  it("accepts a correctly wired live env", () => {
    expect(() => assertSeamMatchesMode("live", liveOk)).not.toThrow();
  });

  it("accepts a correctly wired stubbed env", () => {
    expect(() => assertSeamMatchesMode("stub", stubOk)).not.toThrow();
  });

  it("refuses a live run whose child env still carries a stub file", () => {
    // The real leak: buildTestEnv() DELETES the key from its overlay,
    // but the child is spawned with { ...process.env, ...overlay }, so
    // an MT_TEST_LLM_STUB_FILE in the orchestrator's own environment
    // survives and the "live" sweep is silently stubbed.
    expect(() =>
      assertSeamMatchesMode("live", { ...liveOk, MT_TEST_LLM_STUB_FILE: "/tmp/stub.json" }),
    ).toThrow(E2EPreflightError);
    expect(() =>
      assertSeamMatchesMode("live", { ...liveOk, MT_TEST_LLM_STUB_FILE: "/tmp/stub.json" }),
    ).toThrow(/MT_TEST_LLM_STUB_FILE/);
  });

  it("refuses a live run with a blank key", () => {
    expect(() => assertSeamMatchesMode("live", { ...liveOk, ANTHROPIC_API_KEY: "   " })).toThrow(
      /ANTHROPIC_API_KEY/,
    );
  });

  it("refuses a stubbed run that could reach the real model", () => {
    // The other direction, and the expensive one: a "stubbed" run that
    // silently bills a real key.
    expect(() => assertSeamMatchesMode("stub", { ...stubOk, ANTHROPIC_API_KEY: "sk-ant-real" })).toThrow(
      /ANTHROPIC_API_KEY/,
    );
  });

  it("refuses a stubbed run with no stub seam at all", () => {
    expect(() => assertSeamMatchesMode("stub", { ...stubOk, MT_TEST_LLM_STUB_FILE: "" })).toThrow(
      /MT_TEST_LLM_STUB_FILE/,
    );
  });
});

describe("probeAnthropic", () => {
  const ok = {
    status: 200,
    json: {
      model: PROBE_MODEL,
      usage: { input_tokens: 11, output_tokens: 1 },
    },
  };

  function fakeFetch(...responses: Array<{ status: number; json?: unknown; throws?: string }>) {
    let i = 0;
    const calls: string[] = [];
    const impl = async (url: string) => {
      calls.push(url);
      const r = responses[Math.min(i++, responses.length - 1)];
      if (r.throws) throw new Error(r.throws);
      return {
        status: r.status,
        ok: r.status < 400,
        text: async () => JSON.stringify(r.json ?? {}),
      } as Response;
    };
    return Object.assign(impl, { calls });
  }

  it("returns the tokens the probe spent", async () => {
    const res = await probeAnthropic({ key: "sk-ant-x", fetchImpl: fakeFetch(ok) });
    expect(res.model).toBe(PROBE_MODEL);
    expect(res.inputTokens).toBe(11);
    expect(res.outputTokens).toBe(1);
  });

  it("refuses on 401 and says the key was rejected", async () => {
    await expect(
      probeAnthropic({
        key: "sk-ant-bad",
        fetchImpl: fakeFetch({ status: 401, json: { error: { message: "invalid x-api-key" } } }),
      }),
    ).rejects.toThrow(/rejected|401/i);
  });

  it("refuses on 403", async () => {
    await expect(
      probeAnthropic({ key: "sk-ant-bad", fetchImpl: fakeFetch({ status: 403 }) }),
    ).rejects.toThrow(E2EPreflightError);
  });

  it("refuses when the model the analyzer uses is not available to this key", async () => {
    await expect(
      probeAnthropic({
        key: "sk-ant-x",
        fetchImpl: fakeFetch({ status: 404, json: { error: { message: "model not found" } } }),
      }),
    ).rejects.toThrow(new RegExp(PROBE_MODEL));
  });

  it("retries once on a transient failure, then succeeds", async () => {
    const f = fakeFetch({ status: 500 }, ok);
    const res = await probeAnthropic({ key: "sk-ant-x", fetchImpl: f, retryDelayMs: 0 });
    expect(res.inputTokens).toBe(11);
    expect(f.calls.length).toBe(2);
  });

  it("fails closed when the network never comes back", async () => {
    await expect(
      probeAnthropic({
        key: "sk-ant-x",
        fetchImpl: fakeFetch({ status: 0, throws: "ENOTFOUND api.anthropic.com" }),
        retryDelayMs: 0,
      }),
    ).rejects.toThrow(E2EPreflightError);
  });

  it("refuses a 200 that proves no spend", async () => {
    // No `usage` block means we cannot show a single token was billed,
    // which is the whole point of probing.
    await expect(
      probeAnthropic({ key: "sk-ant-x", fetchImpl: fakeFetch({ status: 200, json: {} }) }),
    ).rejects.toThrow(/usage/i);
  });

  it("never puts the key in the message it throws", async () => {
    const key = "sk-ant-SUPERSECRETVALUE";
    await probeAnthropic({ key, fetchImpl: fakeFetch({ status: 401 }) }).catch((e: Error) => {
      expect(e.message).not.toContain("SUPERSECRETVALUE");
    });
  });
});

describe("PROBE_MODEL", () => {
  it("is the model the analyzer actually calls", () => {
    // A probe against a model the sweep does not use would prove the
    // wrong thing — a key can have access to one and not the other.
    const src = readFileSync(path.join(REPO_ROOT, "src", "lib", "message-analyzer.ts"), "utf8");
    const m = /^const MODEL = "([^"]+)";$/m.exec(src);
    expect(m, "could not find `const MODEL = …` in src/lib/message-analyzer.ts").not.toBeNull();
    expect(m![1]).toBe(PROBE_MODEL);
  });
});

describe("classifyReasoning", () => {
  it("calls the keyless fallback fatal", () => {
    expect(classifyReasoning("ANTHROPIC_API_KEY not set", "llm")).toBe("offline-fatal");
  });

  it("calls an API error fatal", () => {
    expect(classifyReasoning("Claude API error: 529 overloaded", "llm")).toBe("offline-fatal");
  });

  it("calls a stubbed verdict in a live run fatal", () => {
    expect(classifyReasoning("test-stub: no verdict configured for this id", "llm")).toBe("stub");
  });

  it("tolerates a dropped verdict — that is model behaviour, not config", () => {
    expect(classifyReasoning("Claude emitted no verdict for this id", "llm")).toBe("offline");
  });

  it("does not count a deterministic fast-path as model reach", () => {
    expect(classifyReasoning("usage help requested", "fast-path")).toBe("fast-path");
  });

  it("counts anything else from the llm path as model reach", () => {
    expect(classifyReasoning("Zair is dropping out and asking for a replacement", "llm")).toBe(
      "model",
    );
  });

  it("has no fatal prefix that is a prefix of a tolerated one", () => {
    for (const f of OFFLINE_FATAL_PREFIXES) {
      expect(classifyReasoning(`${f} — trailing detail`, "llm")).toBe("offline-fatal");
    }
  });
});

describe("liveReachFailure", () => {
  const rows = (n: number, reasoning: string) =>
    Array.from({ length: n }, () => ({ reasoning, handledBy: "llm" }));

  it("fails a sweep where nothing reached the model", () => {
    const s = summariseReach(rows(141, "ANTHROPIC_API_KEY not set"));
    expect(s.offlineFatal).toBe(141);
    expect(s.model).toBe(0);
    const msg = liveReachFailure(s);
    expect(msg).toMatch(/ANTHROPIC_API_KEY not set/);
    expect(msg).toMatch(/141/);
  });

  it("fails a sweep that analyzed nothing at all", () => {
    expect(liveReachFailure(summariseReach([]))).toMatch(/no message/i);
  });

  it("fails on a single fatal offline verdict, however small the share", () => {
    const s = summariseReach([...rows(999, "player is in"), ...rows(1, "Claude API error: 500")]);
    expect(liveReachFailure(s)).toMatch(/Claude API error/);
  });

  it("fails when the stub seam was live", () => {
    const s = summariseReach([
      ...rows(50, "player is in"),
      ...rows(1, "test-stub: no verdict configured for this id"),
    ]);
    expect(liveReachFailure(s)).toMatch(/stub/i);
  });

  it("passes a healthy sweep", () => {
    expect(liveReachFailure(summariseReach(rows(120, "player is in")))).toBeNull();
  });

  it("tolerates a few dropped verdicts but not a flood", () => {
    const okish = summariseReach([
      ...rows(98, "player is in"),
      ...rows(2, "Claude emitted no verdict for this id"),
    ]);
    expect(liveReachFailure(okish)).toBeNull();

    const flood = summariseReach([
      ...rows(50, "player is in"),
      ...rows(50, "Claude emitted no verdict for this id"),
    ]);
    expect(liveReachFailure(flood)).toMatch(/never reached the model/i);
  });

  it("ignores fast-path rows when judging reach", () => {
    const s = summariseReach([
      ...rows(10, "player is in"),
      ...Array.from({ length: 40 }, () => ({
        reasoning: "usage help requested",
        handledBy: "fast-path",
      })),
    ]);
    expect(liveReachFailure(s)).toBeNull();
  });
});

describe("reachWatermark", () => {
  /** A db that records the SQL it was asked for. */
  function fakeDb(rows: Record<string, unknown[]>) {
    const sql: string[] = [];
    const params: unknown[][] = [];
    return {
      sql,
      params,
      async all<T>(q: string, p: unknown[] = []): Promise<T[]> {
        sql.push(q);
        params.push(p);
        const key = /max\(/.test(q) ? "watermark" : "reach";
        return (rows[key] ?? []) as T[];
      },
    };
  }

  it("reads the table's own high-water mark, never a clock", async () => {
    // The bug this pins: `SELECT now()` is a timestamptz, `createdAt` is
    // a Prisma `timestamp(3)` holding UTC, and comparing them makes
    // Postgres reinterpret the column in the session's zone. In
    // Europe/London in summer that put every row of a live sweep an hour
    // "before" a watermark taken an instant earlier, and the S12 arm
    // reported "0 of 0 messages reached the model" while the metering
    // proxy reported 100 real calls and $1.48 billed.
    const db = fakeDb({ watermark: [{ high: "2026-09-01T15:00:00.000Z" }] });
    const w = await reachWatermark(db);
    expect(w).toBeInstanceOf(Date);
    expect(db.sql[0]).toMatch(/max\("createdAt"\)/);
    expect(db.sql[0]).not.toMatch(/now\(\)|current_timestamp/i);
  });

  it("returns null for an empty table, meaning read everything", async () => {
    const db = fakeDb({ watermark: [{ high: null }] });
    expect(await reachWatermark(db)).toBeNull();
  });

  it("filters on the same column it read the watermark from", async () => {
    const db = fakeDb({ reach: [{ reasoning: "player is in", handledBy: "llm" }] });
    const since = new Date("2026-09-01T15:00:00.000Z");
    const s = await readReach(db, since);
    expect(db.sql[0]).toMatch(/WHERE "createdAt" > \$1/);
    // Passed as a Date, so node-pg does the encoding — no string
    // formatting, no cast, nothing for a time zone to get hold of.
    expect(db.params[0][0]).toBe(since);
    expect(s.model).toBe(1);
  });

  it("reads the whole table when there is no watermark", async () => {
    const db = fakeDb({ reach: [] });
    await readReach(db, null);
    expect(db.sql[0]).not.toMatch(/WHERE/);
  });
});

/**
 * §10 step 5 adds a THIRD way a message can legitimately not reach the
 * model: the router gate decided not to ask. That is a design decision,
 * not a degradation — but it must never be counted as "reached the real
 * model", or a live sweep run with `ROUTER_GATE_ENABLED=1` would report
 * a model-reach number that includes messages no model ever saw. That is
 * the same class of unverifiable number PR #38 exists to kill.
 */
describe("a live run cannot be secretly gated", () => {
  const liveOkNoRouterStub = { ANTHROPIC_API_KEY: "sk-ant-real", MT_TEST_LLM_STUB_FILE: "" };

  it("refuses a live run that can still see the router stub file", () => {
    expect(() =>
      assertSeamMatchesMode("live", {
        ...liveOkNoRouterStub,
        MT_TEST_ROUTER_STUB_FILE: "/tmp/router-stub.json",
      }),
    ).toThrow(/MT_TEST_ROUTER_STUB_FILE/);
  });

  it("allows a live run with the router stub pinned empty", () => {
    expect(() =>
      assertSeamMatchesMode("live", { ...liveOkNoRouterStub, MT_TEST_ROUTER_STUB_FILE: "" }),
    ).not.toThrow();
  });
});

describe("the router gate is visible to the reach guard", () => {
  it("a gated message is classified `gated`, never `model`", () => {
    expect(
      classifyReasoning("router-gate: routed none; the analyzer was not asked", "router-gate"),
    ).toBe("gated");
  });

  it("gated messages are excluded from the attributable denominator", () => {
    const s = summariseReach([
      { reasoning: "the player said in", handledBy: "llm" },
      { reasoning: "router-gate: routed none; not asked", handledBy: "router-gate" },
      { reasoning: "router-gate: routed none; not asked", handledBy: "router-gate" },
    ]);
    expect(s.total).toBe(3);
    expect(s.model).toBe(1);
    expect(s.gated).toBe(2);
    // 1 of 1, not 3 of 3 and not 1 of 3.
    expect(s.attributable).toBe(1);
    expect(s.offlineRate).toBe(0);
  });

  it("a gate that ate the WHOLE sweep still fails, because nothing reached the model", () => {
    const s = summariseReach([
      { reasoning: "router-gate: routed none", handledBy: "router-gate" },
      { reasoning: "router-gate: routed none", handledBy: "router-gate" },
    ]);
    expect(s.attributable).toBe(0);
    expect(liveReachFailure(s)).not.toBeNull();
  });

  it("the reach line SAYS how many were gated, rather than hiding them", () => {
    const s = summariseReach([
      { reasoning: "the player said in", handledBy: "llm" },
      { reasoning: "router-gate: routed none", handledBy: "router-gate" },
    ]);
    expect(describeReach(s)).toContain("gated");
  });

  it("an offline verdict is still offline even with the gate on", () => {
    // The guard must not be weakened: `router-gate` is a handledBy, and
    // a REAL offline reasoning must win over it if both ever appear.
    expect(classifyReasoning("ANTHROPIC_API_KEY not set", "router-gate")).toBe("offline-fatal");
    expect(classifyReasoning("test-stub: no verdict configured", "router-gate")).toBe("stub");
  });
});

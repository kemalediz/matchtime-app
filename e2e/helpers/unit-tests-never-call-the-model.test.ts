/**
 * THE FREE SUITES ARE FREE.
 *
 * The approval rule (CLAUDE.md, 2026-09-19) rests on one promise: unit
 * tests and the Playwright web suite make no model calls and cost
 * nothing, so only a deliberate, approved run ever touches the model.
 *
 * ── the leak this exists for ─────────────────────────────────────────
 * On 2026-09-23 a plain `npx vitest run`, in a checkout whose repo-root
 * `.env` held `ANTHROPIC_API_KEY_DEV`, sent 2 real model calls.
 * `live-llm.test.ts` spawns `e2e/run.ts` with `MT_SIM_LIVE_LLM=1` to
 * prove a keyless live run refuses. It pinned `ANTHROPIC_API_KEY` empty,
 * which was the only key name when it was written. The child then ran
 * dotenv's `config()`, which fills every name the environment does NOT
 * already hold, so it picked up `ANTHROPIC_API_KEY_DEV` from `.env`.
 * `buildTestEnv()` resolved it, and the pre-flight probed both
 * `PROBE_MODELS` for real. Vitest itself never loads `.env`; the key
 * came in through a child.
 *
 * ── the rule ─────────────────────────────────────────────────────────
 * A unit test reaches a model only when `MT_UNIT_LIVE_LLM=1` is set,
 * never because a key happens to be present. Without the flag,
 * `unit-model-guard.setup.ts` pins every key name to "" (dotenv and
 * `node --env-file` both leave a name that is already set alone, so no
 * child can refill it), and refuses any fetch to an anthropic.com host
 * without touching the network, failing the test that tried.
 *
 * This file proves that wiring is in place and works, and scans the
 * unit suite for the shapes that would get around it.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import vitestConfig from "../../vitest.config";
import { DEV_KEY_ENV, DevApiKeyMissingError, PROD_KEY_ENV } from "./dev-api-key";
import { LIVE_ENV_FLAG } from "./live-llm";
import {
  GUARD_SETUP_FILE,
  ModelCallRefused,
  PINNED_EMPTY,
  UNIT_LIVE_LLM_FLAG,
  guardFetch,
  isFetchGuarded,
  isModelUrl,
  liveModelTestsEnabled,
  openForApprovedLiveRun,
  pinModelAccessShut,
  takeRefusedModelCalls,
} from "./unit-model-guard";

const REPO_ROOT = path.resolve(__dirname, "../..");
const rel = (f: string) => path.relative(REPO_ROOT, f);
const optedIn = liveModelTestsEnabled();

const tmpDirs: string[] = [];
function tmpCheckout(dotenv: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mt-unit-guard-"));
  writeFileSync(path.join(dir, ".env"), dotenv);
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe("the opt-in flag", () => {
  it("is named in the same shape as the sim suite's own live flag", () => {
    expect(UNIT_LIVE_LLM_FLAG).toBe("MT_UNIT_LIVE_LLM");
    expect(LIVE_ENV_FLAG).toBe("MT_SIM_LIVE_LLM");
  });

  it("opens only on exactly 1", () => {
    expect(liveModelTestsEnabled({ MT_UNIT_LIVE_LLM: "1" })).toBe(true);
    for (const v of [undefined, "", "0", "true", "yes", " 1"]) {
      expect(liveModelTestsEnabled({ MT_UNIT_LIVE_LLM: v })).toBe(false);
    }
  });

  it("is never opened by the mere presence of a key", () => {
    expect(
      liveModelTestsEnabled({
        [PROD_KEY_ENV]: "sk-ant-prod",
        [DEV_KEY_ENV]: "sk-ant-dev",
        [LIVE_ENV_FLAG]: "1",
      }),
    ).toBe(false);
  });

  it("pins the product key, the dev key and the sim live flag", () => {
    expect([...PINNED_EMPTY].sort()).toEqual([PROD_KEY_ENV, DEV_KEY_ENV, LIVE_ENV_FLAG].sort());
    const env: Record<string, string | undefined> = {
      [PROD_KEY_ENV]: "sk-ant-prod",
      [DEV_KEY_ENV]: "sk-ant-dev",
      [LIVE_ENV_FLAG]: "1",
      UNRELATED: "kept",
    };
    pinModelAccessShut(env);
    expect(env).toEqual({
      [PROD_KEY_ENV]: "",
      [DEV_KEY_ENV]: "",
      [LIVE_ENV_FLAG]: "",
      UNRELATED: "kept",
    });
  });
});

describe("the guard is wired into the unit suite", () => {
  it("vitest.config.ts runs the guard before every test file", () => {
    const setupFiles = [vitestConfig.test?.setupFiles ?? []].flat();
    expect(setupFiles.map((f) => path.resolve(REPO_ROOT, String(f)))).toContain(
      path.resolve(REPO_ROOT, GUARD_SETUP_FILE),
    );
  });

  it.skipIf(optedIn)("this very process holds no usable key and no live flag", () => {
    for (const name of PINNED_EMPTY) {
      expect(Object.prototype.hasOwnProperty.call(process.env, name), `${name} must be SET`).toBe(true);
      expect(process.env[name], `${name} must be pinned empty`).toBe("");
    }
  });

  it.skipIf(optedIn)("refuses a fetch to the model and records it, without the network", async () => {
    // Checked first so an unwired guard fails here, before any request.
    expect(isFetchGuarded(), "globalThis.fetch is not the guarded fetch").toBe(true);
    await expect(
      fetch("https://api.anthropic.com/v1/messages", { method: "POST", body: "{}" }),
    ).rejects.toThrow(/MT_UNIT_LIVE_LLM/);
    expect(takeRefusedModelCalls()).toEqual(["POST https://api.anthropic.com/v1/messages"]);
  });

  it.skipIf(optedIn)("refuses the real SDK too, which is how src/ reaches the model", async () => {
    expect(isFetchGuarded(), "globalThis.fetch is not the guarded fetch").toBe(true);
    // baseURL pinned so an ANTHROPIC_BASE_URL in the shell cannot send
    // this somewhere the guard is not looking.
    const client = new Anthropic({
      apiKey: "sk-ant-guard-test-not-real",
      baseURL: "https://api.anthropic.com",
      maxRetries: 0,
    });
    const err = await client.messages
      .create({ model: "claude-haiku-4-5", max_tokens: 1, messages: [{ role: "user", content: "x" }] })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(Anthropic.APIConnectionError);
    expect(String((err as Error & { cause?: unknown }).cause)).toMatch(/MT_UNIT_LIVE_LLM/);
    expect(takeRefusedModelCalls()).toEqual(["POST https://api.anthropic.com/v1/messages"]);
  });

  it.skipIf(optedIn)(
    "a child that loads .env with dotenv, the way e2e/run.ts does, still sees no key",
    () => {
      const dir = tmpCheckout(
        `${DEV_KEY_ENV}="sk-ant-planted-dev"\n${PROD_KEY_ENV}="sk-ant-planted-prod"\n${LIVE_ENV_FLAG}=1\n`,
      );
      const dotenvEntry = require.resolve("dotenv", { paths: [REPO_ROOT] });
      const script =
        `require(${JSON.stringify(dotenvEntry)}).config({ quiet: true });` +
        `process.stdout.write(JSON.stringify([${PINNED_EMPTY.map((n) => `process.env.${n}`).join(",")}]))`;
      const r = spawnSync(process.execPath, ["-e", script], {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env },
      });
      expect(r.status, r.stderr).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual(PINNED_EMPTY.map(() => ""));
    },
  );

  it.skipIf(optedIn)("a child started with node --env-file sees no key either", () => {
    const dir = tmpCheckout(`${DEV_KEY_ENV}="sk-ant-planted-dev"\n${PROD_KEY_ENV}="sk-ant-planted-prod"\n`);
    const r = spawnSync(
      process.execPath,
      ["--env-file=.env", "-e", `process.stdout.write(JSON.stringify([process.env.${DEV_KEY_ENV}, process.env.${PROD_KEY_ENV}]))`],
      { cwd: dir, encoding: "utf8", env: { ...process.env } },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(["", ""]);
  });
});

describe("guardFetch", () => {
  it("refuses every anthropic.com host and never calls through", async () => {
    const inner = vi.fn(async () => new Response("should never happen"));
    const seen: string[] = [];
    const guarded = guardFetch(inner as unknown as typeof fetch, (c) => seen.push(c));
    for (const url of [
      "https://api.anthropic.com/v1/messages",
      new URL("https://api.anthropic.com/v1/messages/count_tokens"),
      new Request("https://API.Anthropic.com/v1/models"),
      "https://anthropic.com/",
    ]) {
      await expect(guarded(url)).rejects.toBeInstanceOf(ModelCallRefused);
    }
    expect(inner).not.toHaveBeenCalled();
    expect(seen).toHaveLength(4);
    expect(seen[2]).toBe("GET https://api.anthropic.com/v1/models");
  });

  it("lets everything else through untouched, including a local fake API", async () => {
    const inner = vi.fn(async () => new Response("ok"));
    const guarded = guardFetch(inner as unknown as typeof fetch, () => {
      throw new Error("must not record");
    });
    await guarded("http://127.0.0.1:4010/v1/messages", { method: "POST" });
    await guarded("https://notanthropic.com/x");
    await guarded("https://anthropic.com.example.org/x");
    expect(inner).toHaveBeenCalledTimes(3);
  });

  it("recognises model hosts and nothing else", () => {
    expect(isModelUrl("https://api.anthropic.com/v1/messages")).toBe(true);
    expect(isModelUrl("https://console.anthropic.com")).toBe(true);
    expect(isModelUrl("http://localhost:3000/api/anthropic.com")).toBe(false);
    expect(isModelUrl("not a url")).toBe(false);
  });
});

describe("an approved live unit run (MT_UNIT_LIVE_LLM=1) spends the DEV key only", () => {
  it("takes the dev key from the environment and puts it over the product key", () => {
    const env: Record<string, string | undefined> = {
      [DEV_KEY_ENV]: "sk-ant-dev",
      [PROD_KEY_ENV]: "sk-ant-prod",
    };
    openForApprovedLiveRun(env, tmpCheckout(""));
    expect(env[PROD_KEY_ENV]).toBe("sk-ant-dev");
  });

  it("reads ONLY the dev key out of .env, never the rest of it", () => {
    const dir = tmpCheckout(`${DEV_KEY_ENV}="sk-ant-from-dotenv"\nDATABASE_URL=postgres://prod\n`);
    const env: Record<string, string | undefined> = { [PROD_KEY_ENV]: "sk-ant-prod" };
    openForApprovedLiveRun(env, dir);
    expect(env[PROD_KEY_ENV]).toBe("sk-ant-from-dotenv");
    expect(env.DATABASE_URL).toBeUndefined();
  });

  it("refuses rather than fall back to the product key", () => {
    const env: Record<string, string | undefined> = { [PROD_KEY_ENV]: "sk-ant-prod" };
    expect(() => openForApprovedLiveRun(env, tmpCheckout(""))).toThrow(DevApiKeyMissingError);
    expect(env[PROD_KEY_ENV]).toBe("sk-ant-prod");
  });
});

// ─── source scan: shapes that would get around the runtime guard ─────

/** Every file the unit suites run: the root vitest include globs, plus
 *  the Pi bot's own vitest suite. */
function unitTestFiles(): string[] {
  const roots = ["src", "e2e/corpus", "e2e/helpers", "e2e/replay", "whatsapp-bot/src"];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry === "node_modules" || entry === "generated") continue;
        walk(full);
      } else if (/\.test\.ts$/.test(entry)) {
        out.push(full);
      }
    }
  };
  roots.forEach((r) => walk(path.join(REPO_ROOT, r)));
  return out.filter((f) => f !== __filename);
}

describe("no unit test can get around the guard", () => {
  const files = unitTestFiles();

  it("scans a plausible number of unit test files (guards the walker itself)", () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it("no unit test file loads .env itself", () => {
    // Loading .env inside the test process would put a real key back
    // after the guard pinned it. A test that needs a key sets a fake one.
    const loadsDotenv = /(?:from\s+["']dotenv["']|require\(\s*["']dotenv["']\s*\))/;
    expect(files.filter((f) => loadsDotenv.test(readFileSync(f, "utf8"))).map(rel)).toEqual([]);
  });

  it("a test that spawns a LIVE harness pins the dev key empty itself", () => {
    // Belt and braces for exactly the 2026-09-23 leak: this must hold
    // even with MT_UNIT_LIVE_LLM=1, when the guard stands down.
    const asksForLive = new RegExp(`(?:${LIVE_ENV_FLAG}|\\[LIVE_ENV_FLAG\\])\\s*:\\s*["'\`]1["'\`]`);
    const spawns = /\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\(/;
    const pinsDev = new RegExp(`(?:${DEV_KEY_ENV}|\\[DEV_KEY_ENV\\])\\s*:\\s*["'\`]["'\`]`);
    const offenders = files.filter((f) => {
      const text = readFileSync(f, "utf8");
      return asksForLive.test(text) && spawns.test(text) && !pinsDev.test(text);
    });
    expect(offenders.map(rel)).toEqual([]);
  });

  it("nothing loads dotenv with override, which would beat the pin in a child", () => {
    const override = /override\s*:\s*true/;
    const sources: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) {
          if (entry === "node_modules" || entry === "generated") continue;
          walk(full);
        } else if (/\.tsx?$/.test(entry) && full !== __filename) {
          sources.push(full);
        }
      }
    };
    ["src", "e2e", "scripts"].forEach((r) => walk(path.join(REPO_ROOT, r)));
    const offenders = sources.filter((f) => {
      const text = readFileSync(f, "utf8");
      return /dotenv/.test(text) && override.test(text);
    });
    expect(offenders.map(rel)).toEqual([]);
  });

  it("the Pi bot has no route to the model at all", () => {
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "whatsapp-bot/package.json"), "utf8"));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(Object.keys(deps).filter((d) => /anthropic/i.test(d))).toEqual([]);
    const botTests = files.filter((f) => rel(f).startsWith("whatsapp-bot/"));
    expect(botTests.length).toBeGreaterThan(0);
    expect(botTests.filter((f) => /anthropic/i.test(readFileSync(f, "utf8"))).map(rel)).toEqual([]);
  });
});

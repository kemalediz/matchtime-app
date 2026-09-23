/**
 * NO HARNESS SPENDS THE PRODUCTION KEY.
 *
 * September 2026 billed $184.60 and `MDs/llm-spend-september-2026.md`
 * MEASURED that 98% of it was our own harnesses: about 18,500 router
 * calls against the same `ANTHROPIC_API_KEY` as the **77** the live bot
 * made all month. The real cost of running MatchTime, about $4 per club
 * per month, was invisible underneath our testing.
 *
 * The wiring that fixes it is small and therefore easy to undo. Every
 * non-production entry point now resolves `ANTHROPIC_API_KEY_DEV` and
 * assigns it over `ANTHROPIC_API_KEY` inside its own process
 * (`helpers/dev-api-key.ts`), so shared library code under `src/` is
 * untouched and keeps reading the one name it always read. One
 * `process.env.ANTHROPIC_API_KEY` slipped back into a new dryrun script
 * would put that script on the production key and nothing would go red.
 *
 * So this is a SOURCE SCAN, in the spirit of
 * `src/lib/__tests__/no-global-rating-writes.test.ts`: a unit test over
 * the call sites we know about today cannot catch the harness somebody
 * writes next month. This can.
 *
 * ── WHAT IS DELIBERATELY NOT SCANNED ─────────────────────────────────
 * `e2e/api`, `e2e/web` and `e2e/sim` are Playwright specs. They execute
 * inside worker processes whose environment came from `buildTestEnv()`,
 * where `ANTHROPIC_API_KEY` has already been pinned to "" (stubbed run)
 * or to the dev key (live run). Reading it there is reading the value
 * this fix put in, not reaching past it, so `onboarding-enrichment-live
 * .spec.ts` asserting the key is visible in its worker stays legal.
 *
 * The orchestrator side (`e2e/run.ts`, `helpers/`, `replay/`, `corpus/`
 * and everything in `scripts/`) runs in a process that loaded the
 * repo-root `.env`, which is where the production key lives. That is the
 * side that has to be clean, and it is the side scanned below.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { DEV_KEY_ENV, PROD_KEY_ENV } from "./dev-api-key";

const REPO_ROOT = path.resolve(__dirname, "../..");

/** A read of THIS process's production key. `ANTHROPIC_API_KEY_DEV` does
 *  not match: `Y` and `_` are both word characters, so the negative
 *  lookahead below is belt and braces over an already-safe boundary. */
const PROD_KEY_READ_SOURCE =
  /process\.env(?:\.ANTHROPIC_API_KEY(?![A-Z0-9_])|\[\s*["'`]ANTHROPIC_API_KEY["'`]\s*\])/
    .source;
/** Fresh objects per use: a `/g` regex carries `lastIndex` between
 *  `.test()` calls and would skip every other file. */
const prodKeyReadAll = () => new RegExp(PROD_KEY_READ_SOURCE, "g");
const prodKeyRead = () => new RegExp(PROD_KEY_READ_SOURCE);

/** Constructing the SDK client inside a harness. Whatever key it is
 *  handed has to have come through the resolver. */
const SDK_CONSTRUCTION = /new\s+Anthropic\s*\(/;

/** The resolver, by either of the two calls a harness can make. */
const RESOLVER_CALL = /\b(?:spendDevApiKey(?:OrExit)?|requireDevApiKey)\s*\(/;

/**
 * Orchestrator-side harness source. Everything under `scripts/`, plus
 * the non-Playwright half of `e2e/`. Tests are excluded: a test may
 * legitimately name the production variable in a fixture proving it is
 * NOT used, and both files in this directory do exactly that.
 */
function harnessFiles(): string[] {
  const roots = [
    path.join(REPO_ROOT, "scripts"),
    path.join(REPO_ROOT, "e2e", "helpers"),
    path.join(REPO_ROOT, "e2e", "replay"),
    path.join(REPO_ROOT, "e2e", "corpus"),
  ];
  const out: string[] = [path.join(REPO_ROOT, "e2e", "run.ts")];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry === "node_modules") continue;
        walk(full);
      } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
        out.push(full);
      }
    }
  };
  roots.forEach(walk);
  // The resolver itself is the one file allowed to name both variables:
  // naming them is its whole job.
  return out.filter((f) => path.basename(f) !== "dev-api-key.ts");
}

/** Dropping the production key rather than resolving a dev one. What
 *  the e2e orchestrator does: it never calls a model itself, it just
 *  must not let a child inherit the key `.env` gave it. */
const FORGET_CALL = /\bforgetProductionApiKey\s*\(/;

/**
 * Every harness whose process can end up spending money, named, with
 * the call each one owes. An existence check is half the value:
 * renaming a harness out of this list is a deliberate act, and deleting
 * one silently is not possible.
 */
const LIVE_HARNESSES: Array<[file: string, owes: RegExp]> = [
  ["e2e/run.ts", FORGET_CALL],
  ["e2e/helpers/env.ts", RESOLVER_CALL],
  ["e2e/replay/router-attendance-live.ts", RESOLVER_CALL],
  ["e2e/replay/router-recall-live.ts", RESOLVER_CALL],
  ["e2e/replay/router-regressions-live.ts", RESOLVER_CALL],
  ["scripts/chase-at-risk-live.ts", RESOLVER_CALL],
  ["scripts/dryrun-dm-qa.ts", RESOLVER_CALL],
  ["scripts/dryrun-fee-confirm.ts", RESOLVER_CALL],
  ["scripts/dryrun-payment-claim.ts", RESOLVER_CALL],
  ["scripts/dryrun-pipeline.ts", RESOLVER_CALL],
  ["scripts/measure-claimless.ts", RESOLVER_CALL],
  ["scripts/sim-onboarding.ts", RESOLVER_CALL],
];

const rel = (f: string) => path.relative(REPO_ROOT, f);

describe("no harness reads the production Anthropic key", () => {
  const files = harnessFiles();

  it("scans a plausible number of harness files (guards the walker itself)", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it(`finds no orchestrator-side read of process.env.${PROD_KEY_ENV}`, () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(prodKeyReadAll())) {
        offenders.push(`${rel(file)}:${text.slice(0, m.index).split("\n").length}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("finds no harness constructing an Anthropic client without going through the resolver", () => {
    const offenders = files.filter((file) => {
      const text = readFileSync(file, "utf8");
      return SDK_CONSTRUCTION.test(text) && !text.includes("dev-api-key");
    });
    expect(offenders.map(rel)).toEqual([]);
  });
});

describe("every live harness resolves the dev key", () => {
  it.each(LIVE_HARNESSES)("%s exists and makes its call", (relative, owes) => {
    const full = path.join(REPO_ROOT, relative);
    expect(existsSync(full), `${relative} is gone. Update LIVE_HARNESSES deliberately`).toBe(true);
    expect(owes.test(readFileSync(full, "utf8")), `${relative} must call ${owes}`).toBe(true);
  });
});

describe("production is untouched", () => {
  /** Every `.ts`/`.tsx` under `src`, minus the generated Prisma client. */
  function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry === "generated" || entry === "node_modules") continue;
        sourceFiles(full, out);
      } else if (/\.tsx?$/.test(entry)) {
        out.push(full);
      }
    }
    return out;
  }

  const src = sourceFiles(path.join(REPO_ROOT, "src"));

  it("scans a plausible number of src files (guards the walker itself)", () => {
    expect(src.length).toBeGreaterThan(100);
  });

  it(`has no mention of ${DEV_KEY_ENV} anywhere under src/`, () => {
    // The shared-module trap: the tidy-looking "fix" for a missing dev
    // key is `process.env.ANTHROPIC_API_KEY_DEV ?? process.env.ANTHROPIC_API_KEY`
    // in whichever library file constructs the client. That one line
    // would hand the dev key to the Pi and to Vercel, and re-merge the
    // two bills in the other direction. The key choice belongs to the
    // caller's environment; `src/` must not know the dev variable exists.
    const offenders = src.filter((f) => readFileSync(f, "utf8").includes(DEV_KEY_ENV));
    expect(offenders.map(rel)).toEqual([]);
  });

  it(`leaves ${PROD_KEY_ENV} as the only key name src/ reads`, () => {
    const readers = src.filter((f) => prodKeyRead().test(readFileSync(f, "utf8")));
    // Not an exact list: src/ is free to grow model call sites. The
    // assertion is that they still read the PRODUCTION name, because
    // that is what Vercel and the Pi set.
    expect(readers.length).toBeGreaterThan(0);
  });
});

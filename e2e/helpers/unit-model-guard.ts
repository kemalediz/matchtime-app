/**
 * The unit suite reaches a model only when someone asked it to.
 *
 * `vitest run` is the free suite: no database of record, no network, no
 * model, no bill. That is what lets the approval rule in CLAUDE.md work
 * (a live run needs Kemal's yes, a unit run needs nobody's). On
 * 2026-09-23 it stopped being true without anyone noticing: a unit test
 * spawned `e2e/run.ts` live, the child loaded the repo-root `.env`,
 * found `ANTHROPIC_API_KEY_DEV` and spent it on two probe calls. See
 * `unit-tests-never-call-the-model.test.ts` for the full mechanism.
 *
 * So the switch is a FLAG, never the presence of a key:
 *
 *   MT_UNIT_LIVE_LLM unset  (the default, every ordinary run)
 *     Every key name is pinned to "", as is `MT_SIM_LIVE_LLM`. Pinned,
 *     not deleted: dotenv's `config()` and `node --env-file` both leave
 *     a name that is already set alone, so no child a test spawns can
 *     refill it from `.env`. And `fetch` refuses any anthropic.com host
 *     without touching the network, recording the attempt so the setup
 *     file can fail the test that made it.
 *
 *   MT_UNIT_LIVE_LLM=1  (an approved live run, and only then)
 *     The guard stands down, and the process spends the DEVELOPER's key
 *     (`spendDevApiKey`), read from the environment or, failing that,
 *     from `.env`. Only that one name is read from `.env`; the rest of
 *     it (the production database URL among it) stays out.
 *
 * The name mirrors `MT_SIM_LIVE_LLM`, the one existing live opt in:
 * `MT_<suite>_LIVE_LLM`, set to exactly "1". It is deliberately not an
 * `MT_TEST_*` name, which this repo keeps for seams that code under
 * `src/` reads, and deliberately not `MT_SIM_LIVE_LLM` itself, so a
 * shell exported for a sim run does not also open the unit suite.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "dotenv";
import { DEV_KEY_ENV, PROD_KEY_ENV, readDevApiKey, spendDevApiKey, type MutableEnv } from "./dev-api-key";

export const UNIT_LIVE_LLM_FLAG = "MT_UNIT_LIVE_LLM";

/** The setup file vitest.config.ts must list, relative to the repo root. */
export const GUARD_SETUP_FILE = "e2e/helpers/unit-model-guard.setup.ts";

/** Mirrors `LIVE_ENV_FLAG` in `live-llm.ts`, which the guard test pins.
 *  Not imported: the setup runs before every test file and should load
 *  as little as it can. */
const SIM_LIVE_FLAG = "MT_SIM_LIVE_LLM";

/** Everything that, left in scope, lets this process or a child it
 *  spawns spend money on a model. */
export const PINNED_EMPTY: readonly string[] = [PROD_KEY_ENV, DEV_KEY_ENV, SIM_LIVE_FLAG];

export function liveModelTestsEnabled(env: MutableEnv = process.env): boolean {
  return env[UNIT_LIVE_LLM_FLAG] === "1";
}

export function pinModelAccessShut(env: MutableEnv = process.env): void {
  for (const name of PINNED_EMPTY) env[name] = "";
}

/** Put a pin back if a test deleted it. A value a test set on purpose (a
 *  fake key for a mocked SDK) is left alone. */
export function repinIfDeleted(env: MutableEnv = process.env): void {
  for (const name of PINNED_EMPTY) {
    if (!Object.prototype.hasOwnProperty.call(env, name)) env[name] = "";
  }
}

export function isModelUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "anthropic.com" || host.endsWith(".anthropic.com");
  } catch {
    return false;
  }
}

export class ModelCallRefused extends Error {
  constructor(call: string) {
    super(
      `unit test tried to call the model (${call}) without ${UNIT_LIVE_LLM_FLAG}=1. ` +
        `Unit tests are free: stub the SDK or point ANTHROPIC_BASE_URL at a local fake. ` +
        `A live run needs Kemal's approval and ${UNIT_LIVE_LLM_FLAG}=1.`,
    );
    this.name = "ModelCallRefused";
  }
}

function describeCall(input: string | URL | Request, init?: RequestInit): string {
  if (input instanceof Request) return `${(init?.method ?? input.method).toUpperCase()} ${input.url}`;
  const url = input instanceof URL ? input.href : new URL(input).href;
  return `${(init?.method ?? "GET").toUpperCase()} ${url}`;
}

export function guardFetch(inner: typeof fetch, record: (call: string) => void): typeof fetch {
  const guarded = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    if (!isModelUrl(url)) return inner(input, init);
    const call = describeCall(input, init);
    record(call);
    return Promise.reject(new ModelCallRefused(call));
  };
  return guarded as typeof fetch;
}

/** Kept on `globalThis`, like the guard itself, so a module graph
 *  reloaded for the next test file in the same worker still reads the
 *  list the installed fetch writes to. */
const REFUSED = Symbol.for("matchtime.unit-model-guard.refused");
const store = globalThis as typeof globalThis & { [REFUSED]?: string[] };
const refused: string[] = (store[REFUSED] ??= []);

/** The model calls refused since the last drain, emptied as it returns. */
export function takeRefusedModelCalls(): string[] {
  return refused.splice(0, refused.length);
}

const GUARDED = Symbol.for("matchtime.unit-model-guard");

/** Whether this process's `fetch` is the guarded one. */
export function isFetchGuarded(f: typeof fetch = globalThis.fetch): boolean {
  return (f as typeof fetch & { [GUARDED]?: true })[GUARDED] === true;
}

/** Make this process unable to reach the model. Idempotent. */
export function shutModelAccess(env: MutableEnv = process.env): void {
  pinModelAccessShut(env);
  if (isFetchGuarded()) return;
  const current = globalThis.fetch;
  const guarded = guardFetch(current.bind(globalThis), (c) => refused.push(c)) as typeof fetch & {
    [GUARDED]?: true;
  };
  guarded[GUARDED] = true;
  globalThis.fetch = guarded;
}

/**
 * `MT_UNIT_LIVE_LLM=1`: spend the developer's key and nothing else. Reads
 * only `ANTHROPIC_API_KEY_DEV` out of `<root>/.env` when the environment
 * lacks it, and refuses (never falls back to the product key) when
 * neither has one.
 */
export function openForApprovedLiveRun(env: MutableEnv = process.env, root = process.cwd()): string {
  if (!readDevApiKey(env)) {
    const file = path.join(root, ".env");
    if (existsSync(file)) {
      const fromFile = parse(readFileSync(file))[DEV_KEY_ENV];
      if (fromFile) env[DEV_KEY_ENV] = fromFile;
    }
  }
  return spendDevApiKey(`a live unit test run (${UNIT_LIVE_LLM_FLAG}=1)`, env);
}

/**
 * Which way a club-scenario run uses the model (e2e/scenarios/club-scenarios.spec.ts):
 *
 *   MT_SCENARIO_CASSETTE=record   live, on ANTHROPIC_API_KEY_DEV, every call kept
 *   MT_SCENARIO_CASSETTE=replay   no network: every answer from the cassette
 *   unset                         not a scenario run: nothing here applies
 *
 * Read by the harness only (run.ts, helpers/env.ts, the scenario spec).
 * Nothing under src/ reads it; mode.test.ts fails if anything does.
 */
import path from "node:path";

export const CASSETTE_ENV = "MT_SCENARIO_CASSETTE";
export const CASSETTE_DIR_ENV = "MT_SCENARIO_CASSETTE_DIR";

/** What the server under test holds as its key in a replay: not a key. If
 *  anything ever bypassed the proxy with it, Anthropic would answer 401 and
 *  nothing would be billed. */
export const REPLAY_PLACEHOLDER_KEY = "cassette-replay-no-network-not-a-key";

export function cassetteMode(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): "record" | "replay" | null {
  const v = (env[CASSETTE_ENV] ?? "").trim();
  if (!v) return null;
  if (v === "record" || v === "replay") return v;
  throw new Error(`${CASSETTE_ENV} must be record or replay, not "${v}"`);
}

export function cassetteDir(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): string {
  return env[CASSETTE_DIR_ENV]?.trim() || path.resolve(__dirname, "recordings");
}

/**
 * Which WhatsApp library holds the line: `WA_DRIVER`.
 *
 * Unset, or `wwebjs`, is whatsapp-web.js: exactly what the Pi has always
 * run. Nothing changes unless somebody opts in, and the rollback from
 * whatever comes next is this one variable plus a restart.
 *
 * An unrecognised value is an ERROR, not a silent default. A typo must
 * never quietly run the driver the operator was trying to move away from:
 * on the cutover morning "it started fine" and "it started fine on the old
 * library" have to be distinguishable. Same rule HomeTenant's
 * `driver-select.ts` follows, for the same reason.
 *
 * ── `baileys` needs one of two explicit switches ─────────────────────
 * `WA_DRIVER=baileys` on its own THROWS. It runs only with:
 *
 *   WA_SHADOW=1        receive-only (`shadow.ts`): every send refused at
 *                      the driver. How Phase 5 measured Baileys on
 *                      MatchTime's real number from 2026-09-23.
 *   WA_BAILEYS_LIVE=1  sends ENABLED. The cutover switch (Phase 6), added
 *                      on Kemal's decision after the shadow run proved the
 *                      phone gate (62 of 62 group members resolved to a
 *                      phone), DM sender resolution, a 503 reconnect and a
 *                      session surviving a restart.
 *
 * If both are set, shadow WINS and the startup banner says the live
 * switch was ignored. The safe reading of a contradiction is the one that
 * cannot post. A value that is neither a yes nor a no throws, for the
 * same reason `WA_SHADOW` does.
 *
 * ── Why the Baileys driver is imported dynamically ──────────────────
 * A static import would pull the whole `baileys` package, and its Signal
 * and protobuf trees, into every start of the live bot on the Pi, for a
 * driver it is not going to use. `createDriver` is async so that the
 * import happens only when Baileys is actually selected. With `WA_DRIVER`
 * unset nothing under `src/drivers/baileys.ts` is loaded at all.
 */
import type { WaDriver } from "./driver.js";
import { createWwebjsDriver } from "./drivers/wwebjs.js";
import { resolveShadowMode, shadowGuard, type ShadowMode } from "./shadow.js";

/** The deliberate switch that lets a Baileys process SEND. */
export const BAILEYS_LIVE_ENV = "WA_BAILEYS_LIVE";

const YES = ["1", "true", "yes", "on"];
const NO = ["0", "false", "no", "off"];

export function resolveBaileysLive(env: Record<string, string | undefined>): boolean {
  const raw = typeof env[BAILEYS_LIVE_ENV] === "string" ? (env[BAILEYS_LIVE_ENV] as string).trim() : "";
  if (raw.length === 0) return false;
  const value = raw.toLowerCase();
  if (YES.includes(value)) return true;
  if (NO.includes(value)) return false;
  throw new Error(
    `${BAILEYS_LIVE_ENV}=${JSON.stringify(raw)} is not a yes or a no. Use one of ${YES.join(", ")} ` +
      `to let the Baileys driver send for real, or one of ${NO.join(", ")}, or leave it unset.`,
  );
}

/**
 * The startup line for a Baileys run that is not plain shadow: LIVE, or
 * shadow with the live switch overridden. Null otherwise (whatsapp-web.js,
 * or a shadow run that never asked for live), where `shadowBanner` alone
 * already says everything.
 */
export function baileysLiveBanner(
  driverName: string,
  shadow: ShadowMode,
  env: Record<string, string | undefined>,
): string | null {
  if (driverName !== "baileys") return null;
  const live = resolveBaileysLive(env);
  const bar = "=".repeat(72);
  if (shadow.enabled) {
    if (!live) return null;
    return (
      `[driver] ${BAILEYS_LIVE_ENV}=1 is IGNORED: ${shadow.source} is also set and shadow wins. ` +
      "Every send stays refused. Unset WA_SHADOW to run Baileys live."
    );
  }
  return [
    "",
    bar,
    `  Baileys LIVE: sends ENABLED (${BAILEYS_LIVE_ENV}=1, WA_SHADOW off).`,
    "  This process posts to real WhatsApp groups and DMs. Scheduler, batch",
    "  flush, heartbeat, org refresh, participant sweep and restart catch-up",
    "  all run. Rollback: unset WA_DRIVER and WA_BAILEYS_LIVE, then",
    "  scripts/deploy-pi.sh (back to whatsapp-web.js).",
    bar,
    "",
  ].join("\n");
}

export type DriverName = "wwebjs" | "baileys";

const DRIVERS: readonly DriverName[] = ["wwebjs", "baileys"];

const SHADOW_OFF: ShadowMode = { enabled: false, source: "not checked" };

export function selectDriver(
  raw: string | undefined,
  shadow: ShadowMode = SHADOW_OFF,
  baileysLive = false,
): DriverName {
  const value = (raw ?? "").trim().toLowerCase();
  if (!value) return "wwebjs";
  if (value === "baileys") {
    if (!shadow.enabled && !baileysLive) {
      throw new Error(
        "WA_DRIVER=baileys needs an explicit second switch: WA_SHADOW=1 to run it " +
          "receive-only (every send refused at the driver), or WA_BAILEYS_LIVE=1 to let it " +
          "send for real to Sutton FC's group. Neither is set, so this refuses rather than " +
          "guess. Unset WA_DRIVER to run whatsapp-web.js. See " +
          "MDs/baileys-migration-plan-2026-09-21.md.",
      );
    }
    return "baileys";
  }
  if ((DRIVERS as readonly string[]).includes(value)) return value as DriverName;
  throw new Error(
    `WA_DRIVER=${JSON.stringify(raw)} is not a known driver. Use one of: ${DRIVERS.join(", ")} ` +
      "(baileys only with WA_SHADOW=1 or WA_BAILEYS_LIVE=1).",
  );
}

/**
 * How each driver is built. Injectable so `driver-select.test.ts` can
 * prove what `createDriver` constructs and what it wraps without opening
 * a browser or a socket.
 */
export interface DriverFactories {
  wwebjs(env: NodeJS.ProcessEnv): WaDriver;
  baileys(env: NodeJS.ProcessEnv): Promise<WaDriver>;
}

const DEFAULT_FACTORIES: DriverFactories = {
  wwebjs: (env) => createWwebjsDriver(env),
  baileys: async (env) => (await import("./drivers/baileys.js")).createBaileysDriver(env),
};

/**
 * Build the driver `WA_DRIVER` names, guarded if `WA_SHADOW` says so.
 *
 * The guard wraps WHATEVER driver was selected, not only Baileys: shadow
 * mode is a property of the process, and an operator who asked for a
 * receive-only bot must get one whichever library is underneath. The raw
 * driver does not escape this function, so nothing downstream holds a
 * reference that could go around the guard.
 */
export async function createDriver(
  env: NodeJS.ProcessEnv = process.env,
  factories: DriverFactories = DEFAULT_FACTORIES,
): Promise<WaDriver> {
  const shadow = resolveShadowMode(env);
  const name = selectDriver(env.WA_DRIVER, shadow, resolveBaileysLive(env));
  const driver = name === "wwebjs" ? factories.wwebjs(env) : await factories.baileys(env);
  return shadow.enabled ? shadowGuard(driver) : driver;
}

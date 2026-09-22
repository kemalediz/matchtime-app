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
 * ── `baileys` is selectable, but only in shadow mode ────────────────
 * Phases 3, 3b and 4 built the whole Baileys driver
 * (`src/drivers/baileys.ts`): it connects, sends, hears messages, lists
 * its groups, sweeps rosters, sees joins and leaves and decrypts poll
 * votes. What it has NOT done is run against a real WhatsApp group. Phase
 * 5 is that week: a throwaway number in a throwaway group, receive-only,
 * where the offline replay, the LID-to-phone paths, reactions, mentions,
 * poll votes and participant events are measured for the first time.
 *
 * So `WA_DRIVER=baileys` now works, and ONLY together with `WA_SHADOW=1`
 * (`shadow.ts`), which refuses every send at the driver itself. Without
 * it this throws. The guarantee that matters is unchanged and is now
 * structural rather than aspirational: there is no configuration of this
 * file in which a Baileys process can post to Sutton FC's group. Making
 * one is a deliberate edit here, after the shadow week and after the
 * phone gate (`scripts/measure-group-phones.ts`) has been run on Sutton's
 * group, and it is Kemal's decision.
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

export type DriverName = "wwebjs" | "baileys";

const DRIVERS: readonly DriverName[] = ["wwebjs", "baileys"];

const SHADOW_OFF: ShadowMode = { enabled: false, source: "not checked" };

export function selectDriver(
  raw: string | undefined,
  shadow: ShadowMode = SHADOW_OFF,
): DriverName {
  const value = (raw ?? "").trim().toLowerCase();
  if (!value) return "wwebjs";
  if (value === "baileys") {
    if (!shadow.enabled) {
      throw new Error(
        "WA_DRIVER=baileys may only run in SHADOW MODE for now: set WA_SHADOW=1 as well. " +
          "The Baileys driver is built (Phases 3, 3b and 4 of " +
          "MDs/baileys-migration-plan-2026-09-21.md: connect, send, receive, groups, " +
          "participants, joins and leaves, poll votes), but nothing in it has run against a " +
          "real WhatsApp group, so the Phase 5 shadow run on a throwaway number has to come " +
          "first: the offline replay, LID-to-phone resolution, reactions, mentions, poll " +
          "votes and participant events are all unmeasured, and so is the phone gate " +
          "(scripts/measure-group-phones.ts) on Sutton's group. Shadow mode refuses every " +
          "send at the driver, so it cannot post anywhere. Running Baileys for real is a " +
          "deliberate edit to driver-select.ts after that week, not an env var. Unset " +
          "WA_DRIVER to run whatsapp-web.js.",
      );
    }
    return "baileys";
  }
  if ((DRIVERS as readonly string[]).includes(value)) return value as DriverName;
  throw new Error(
    `WA_DRIVER=${JSON.stringify(raw)} is not a known driver. Use one of: ${DRIVERS.join(", ")} ` +
      "(baileys only with WA_SHADOW=1).",
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
  const name = selectDriver(env.WA_DRIVER, shadow);
  const driver = name === "wwebjs" ? factories.wwebjs(env) : await factories.baileys(env);
  return shadow.enabled ? shadowGuard(driver) : driver;
}

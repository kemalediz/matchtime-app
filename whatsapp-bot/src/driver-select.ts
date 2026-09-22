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
 * `baileys` is deliberately NOT a known value yet. `src/baileys/` today is
 * Phase 1: a socket that watches and sends nothing. Accepting the name
 * here before Phase 3 has built the driver would turn a hopeful env var
 * into a bot that comes up mute.
 */
import type { WaDriver } from "./driver.js";
import { createWwebjsDriver } from "./drivers/wwebjs.js";

export type DriverName = "wwebjs";

const DRIVERS: readonly DriverName[] = ["wwebjs"];

export function selectDriver(raw: string | undefined): DriverName {
  const value = (raw ?? "").trim().toLowerCase();
  if (!value) return "wwebjs";
  if ((DRIVERS as readonly string[]).includes(value)) return value as DriverName;
  if (value === "baileys") {
    throw new Error(
      "WA_DRIVER=baileys is not available yet. src/baileys/ is Phase 1 of " +
        "MDs/baileys-migration-plan-2026-09-21.md and only watches; the driver arrives in " +
        "Phase 3. Unset WA_DRIVER to run whatsapp-web.js.",
    );
  }
  throw new Error(
    `WA_DRIVER=${JSON.stringify(raw)} is not a known driver. Use one of: ${DRIVERS.join(", ")}.`,
  );
}

/** Build the driver `WA_DRIVER` names. */
export function createDriver(env: NodeJS.ProcessEnv = process.env): WaDriver {
  const name = selectDriver(env.WA_DRIVER);
  switch (name) {
    case "wwebjs":
      return createWwebjsDriver(env);
  }
}

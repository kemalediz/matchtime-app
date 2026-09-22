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
 * `baileys` is deliberately NOT a known value yet. Phase 3 built the
 * Baileys driver's OUTBOUND half (`src/drivers/baileys.ts`): it can send,
 * but it has no socket lifecycle, no inbound path and no groups, so a bot
 * on it could not hear anybody. Accepting the name before those land
 * would turn a hopeful env var into a bot that comes up deaf, and deaf
 * looks like healthy.
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
      "WA_DRIVER=baileys is not available yet. The Baileys driver is the outbound half only " +
        "(Phase 3 of MDs/baileys-migration-plan-2026-09-21.md): it cannot receive messages or " +
        "see groups until the inbound wiring and Phase 4 land. Unset WA_DRIVER to run " +
        "whatsapp-web.js.",
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

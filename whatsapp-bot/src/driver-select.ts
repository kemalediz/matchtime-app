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
 * Baileys driver's outbound half and Phase 3b its lifecycle, identity and
 * inbound path (`src/drivers/baileys.ts`), so it can now connect, send and
 * hear messages. It still cannot list its groups, sweep a roster, see a
 * join or a leave, or count a MoM vote: that is Phase 4. A bot on it would
 * come up hearing messages and blind to its own groups (and would record
 * `group-enumeration` and `participant-sync` degraded on every open), and
 * blind looks like healthy to everyone but the heartbeat. `createBaileysDriver`
 * is deliberately not imported here until then.
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
      "WA_DRIVER=baileys is not available yet. The Baileys driver can connect, send and receive " +
        "messages (Phases 3 and 3b of MDs/baileys-migration-plan-2026-09-21.md), but it cannot " +
        "list its groups, sync participants, see joins and leaves or read poll votes until " +
        "Phase 4 lands, and the offline-replay measurement (Phase 5) has not been taken. Unset " +
        "WA_DRIVER to run whatsapp-web.js.",
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

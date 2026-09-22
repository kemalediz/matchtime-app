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
 * `baileys` is deliberately NOT a known value yet. Phases 3, 3b and 4 have
 * built the whole Baileys driver (`src/drivers/baileys.ts`): it connects,
 * sends, hears messages, lists its groups, sweeps rosters, sees joins and
 * leaves and decrypts poll votes. What it has not done is run against a
 * real WhatsApp group: the Phase 5 shadow run, on a throwaway number, is
 * where the offline replay, the LID-to-phone paths, reactions, mentions,
 * poll votes and participant events are measured for the first time; the
 * restart replay (`fetchRecentGroupMessages`) waits on that measurement;
 * and the phone gate (`scripts/measure-group-phones.ts`) has not been run on
 * Sutton's group. Switching is Kemal's decision after those, not a side
 * effect of a PR. `createBaileysDriver` is deliberately not imported here
 * until then.
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
      "WA_DRIVER=baileys is not available yet. The Baileys driver is built (Phases 3, 3b and 4 of " +
        "MDs/baileys-migration-plan-2026-09-21.md: connect, send, receive, groups, participants, " +
        "joins and leaves, poll votes), but nothing in it has run against a real WhatsApp group. " +
        "Still to do before it may be selected: the Phase 5 shadow run on a throwaway number " +
        "(offline replay, LID-to-phone resolution, reactions, mentions, poll votes, participant " +
        "events), the restart replay that measurement decides, and the phone gate " +
        "(scripts/measure-group-phones.ts) on Sutton's group. Unset WA_DRIVER to run whatsapp-web.js.",
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

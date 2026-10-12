/**
 * THE CLUB SET VERSION (2026-10-13): one short stamp that changes whenever
 * the set of clubs the Pi should serve, monitor or silence changes.
 *
 * ── Why ──────────────────────────────────────────────────────────────
 * The Pi learns which groups are clubs', which are silent and which are
 * admin groups from GET /api/whatsapp/orgs, and re-reads it every five
 * minutes. For a club that has just gone live that is five minutes with no
 * hello and with every message in its group dropped (whatsapp-bot's
 * scheduler loops over the clubs of the last refresh, and its message
 * handler drops a group that is still in the silent set). The other way
 * round, a club that has just been suspended or paused keeps being acted
 * for until the next refresh.
 *
 * So two responses carry this stamp, and the Pi refreshes at once when
 * they differ (whatsapp-bot/src/org-refresh.ts):
 *   - GET /api/whatsapp/orgs: the stamp its snapshot was read at;
 *   - GET /api/whatsapp/platform-jobs: the stamp now. That is the one
 *     request the Pi makes every scheduler tick (30 seconds) whatever the
 *     clubs' switches say.
 *
 * ── What it is ───────────────────────────────────────────────────────
 * DERIVED, not stored: no counter to bump in ten writers, so no writer can
 * forget. ONE query reads, for every club that has a WhatsApp group or an
 * admin group, the columns /orgs decides from, in a fixed order; the
 * stamp is a hash of those rows and of the three flags /orgs also
 * decides from. It is opaque: the Pi only ever compares it for equality.
 *
 * ── What changes it ──────────────────────────────────────────────────
 * Any change to one of these, on a club with a group or an admin group:
 *   approval status     approved (the old flow: the club is served; the
 *                       hold: it is setting up and its group goes
 *                       silent), suspended, rejected;
 *   setup stage         setting up -> live (GO, the Go live button, the
 *                       owner's Go live now);
 *   the bot switch      go-live, an old-flow approval, a mute, an unmute;
 *   billing status      a pause and a resume (and every other move, which
 *                       costs one refresh that changes nothing);
 *   the removal stamp   MatchTime removed from a setting-up club's group,
 *                       and added back;
 *   the group           linked at an approval, changed, or cleared;
 *   the admin group     linked or unlinked;
 * and a club with a group being created or deleted; and BILLING_ENABLED,
 * SELF_JOIN_ENABLED or the legacy setup trigger being switched.
 *
 * ── What does NOT change it ──────────────────────────────────────────
 * Groups that are not a club's yet: a connect request waiting for its
 * add or its approval, a group somebody added MatchTime to unasked, and a
 * group in the middle of the old in-group setup. The Pi is told about
 * each of those at the add itself, or by the setup's own reply, and the
 * five-minute refresh stays as the backstop. Nothing else about a club
 * (its name, its settings, its games, its members) changes it either.
 *
 * ── Cost ─────────────────────────────────────────────────────────────
 * One SELECT of eight small columns from `Organisation`, for the clubs
 * with a group: tens of rows. Measured in
 * e2e/helpers/club-set-version-lib-tests.ts.
 */
import { createHash } from "node:crypto";
import { db } from "./db";
import { isBillingEnabled } from "./club-billing-rules";
import { isLegacySetupTriggerEnabled, isSelfJoinEnabled } from "./club-approval";
import { SETUP_REMOVED_SELECT, SETUP_STAGE_SELECT } from "./club-setup";

/** The flags /orgs decides its sets from. */
export interface ClubSetFlags {
  billing: boolean;
  selfJoin: boolean;
  legacySetupTrigger: boolean;
}

/** The columns read. The stage and the removal stamp come through the
 *  club-setup module's own selects, which is the one home of their names. */
const CLUB_SET_SELECT = {
  id: true,
  whatsappGroupId: true,
  adminGroupId: true,
  whatsappBotEnabled: true,
  billingStatus: true,
  ...SETUP_STAGE_SELECT,
  ...SETUP_REMOVED_SELECT,
} as const;

/**
 * Pure: the stamp for these rows and flags. `rows` must be in a fixed
 * order (the loader orders by id) and each row's keys in a fixed order
 * (one select). Dates are hashed as their ISO strings.
 */
export function clubSetVersionOf(rows: ReadonlyArray<Record<string, unknown>>, flags: ClubSetFlags): string {
  const body = JSON.stringify([flags.billing, flags.selfJoin, flags.legacySetupTrigger, rows.map((r) => Object.keys(r).sort().map((k) => [k, r[k]]))]);
  return createHash("sha256").update(body).digest("hex").slice(0, 16);
}

/** The stamp now. One query. Throws only when the database does. */
export async function loadClubSetVersion(): Promise<string> {
  const rows = await db.organisation.findMany({
    where: { OR: [{ whatsappGroupId: { not: null } }, { adminGroupId: { not: null } }] },
    orderBy: { id: "asc" },
    select: CLUB_SET_SELECT,
  });
  return clubSetVersionOf(rows as Array<Record<string, unknown>>, {
    billing: isBillingEnabled(),
    selfJoin: isSelfJoinEnabled(),
    legacySetupTrigger: isLegacySetupTriggerEnabled(),
  });
}

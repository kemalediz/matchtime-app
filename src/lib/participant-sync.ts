/**
 * Shared participant-import core (Phase 1 autonomous onboarding,
 * 2026-06-12 design §B.4/§C.4).
 *
 * Extracted VERBATIM from /api/whatsapp/sync-participants so two call
 * sites share one loop:
 *   1. The sync route (bot startup sweep over live orgs) — unchanged
 *      behaviour, now a thin wrapper.
 *   2. Onboarding completion — imports the participant snapshot taken
 *      when the bot was added, so a freshly onboarded org starts with
 *      its roster pre-filled instead of waiting for a Pi restart.
 *
 * Semantics (unchanged from the route):
 *   - Phone-keyed upsert of User; pushname-dedupe against phone-less
 *     provisional members BEFORE creating; NEVER overwrites existing
 *     User.name/phoneNumber.
 *   - Membership upsert as PLAYER; restores soft-removed (leftAt) rows;
 *     always stamps lastSeenInGroupAt.
 *   - @lid-only participants (no resolvable phone) are skipped — the
 *     pushname resolvers pick them up the moment they message.
 */
import { db } from "./db";
import { findExistingOrgMember } from "./resolve-player";
import {
  snapshotPhone,
  parseParticipantSnapshot,
  type SnapshotParticipant,
} from "./participant-snapshot";

// Re-export so existing importers keep one import site.
export { snapshotPhone, parseParticipantSnapshot, type SnapshotParticipant };

export interface ImportResult {
  added: number;
  alreadyKnown: number;
  skippedNoPhone: number;
  restoredMembership: number;
  total: number;
}

/** Upsert Users + Memberships for a participant list into an org. */
export async function importParticipants(
  orgId: string,
  participants: SnapshotParticipant[],
): Promise<ImportResult> {
  let added = 0;
  let alreadyKnown = 0;
  let skippedNoPhone = 0;
  let restoredMembership = 0;

  for (const p of participants) {
    const phone = snapshotPhone(p);
    if (!phone) {
      skippedNoPhone += 1;
      continue;
    }
    const pushname = p.pushname?.trim() || null;

    let user = await db.user.findUnique({
      where: { phoneNumber: phone },
      select: { id: true, name: true },
    });
    if (!user && pushname) {
      // No phone-keyed record — but a phone-less record (e.g. a provisional
      // member the analyzer/squad-list created earlier by NAME) may already
      // exist for this person. Dedup BEFORE creating, on a strong unambiguous
      // signal only (alias / unique exact-or-fuzzy name). Ambiguous names fall
      // through to a fresh create so two distinct people are never merged.
      const match = await findExistingOrgMember(orgId, { name: pushname });
      if (match) {
        // Backfill the phone we now know onto the matched record (it was
        // created phone-less). Guard against a unique-constraint race in case
        // another row already claimed this number.
        try {
          await db.user.update({
            where: { id: match.userId },
            data: { phoneNumber: phone },
          });
        } catch {
          // Phone already taken by another row — leave the matched record's
          // existing identity untouched; membership upsert below still runs.
        }
        // Counted as alreadyKnown by the else-branch below (user is now set).
        user = { id: match.userId, name: match.name };
      }
    }
    if (!user) {
      // New User — synthetic email keeps the unique index happy.
      const slug =
        (pushname ?? "player")
          .toLowerCase()
          .normalize("NFD")
          .replace(/[̀-ͯ]/g, "")
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "")
          .slice(0, 32) || "player";
      user = await db.user.create({
        data: {
          name: pushname,
          phoneNumber: phone,
          email: `wa-sync+${slug}-${Date.now().toString(36)}@matchtime.local`,
          isActive: true,
          onboarded: false,
        },
        select: { id: true, name: true },
      });
      added += 1;
    } else {
      alreadyKnown += 1;
    }

    // Upsert active Membership. If the user was previously soft-removed
    // (leftAt set) but is now visible in the WhatsApp group again,
    // restore them — same restoreMembership semantics the analyze
    // route uses for re-engaging members.
    //
    // Always stamp lastSeenInGroupAt — that's how DM-blast features
    // (roster check-in survey) scope to members currently in the
    // WhatsApp group rather than the whole DB roster.
    const now = new Date();
    const existing = await db.membership.findUnique({
      where: { userId_orgId: { userId: user.id, orgId } },
    });
    if (!existing) {
      await db.membership.create({
        data: {
          userId: user.id,
          orgId,
          role: "PLAYER",
          lastSeenInGroupAt: now,
        },
      });
    } else {
      await db.membership.update({
        where: { id: existing.id },
        data: {
          lastSeenInGroupAt: now,
          ...(existing.leftAt !== null ? { leftAt: null } : {}),
        },
      });
      if (existing.leftAt !== null) restoredMembership += 1;
    }
  }

  return {
    added,
    alreadyKnown,
    skippedNoPhone,
    restoredMembership,
    total: participants.length,
  };
}

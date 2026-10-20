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
 *     User.name/phoneNumber (a name match holding a different number is
 *     treated as a different person, see adoptPhoneIfUnset).
 *   - Membership upsert as PLAYER; restores soft-removed (leftAt) rows;
 *     always stamps lastSeenInGroupAt.
 *   - Stamps `Organisation.lastParticipantSweepAt` when the roster was
 *     non-empty (2026-09-09). This function is that column's ONLY
 *     writer — see the note at the bottom.
 *   - @lid-only participants (no resolvable phone) are skipped — the
 *     pushname resolvers pick them up the moment they message.
 */
import { db } from "./db";
import { findExistingOrgMember } from "./resolve-player";
import { linkJoinerToPlaceholder } from "./placeholder-link";
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
  /** Phoneless placeholders merged into a participant known by phone. */
  linkedPlaceholders: number;
  total: number;
}

/**
 * Give a name-matched member the participant's phone, ONLY if they have
 * none. A saved number is never replaced here (2026-10-20, follow-up to
 * #315): the name dedupe is alias, exact or first-token fuzzy, so its match
 * can be someone else entirely. The write is conditional on the number
 * still being NULL, so a sign-in or admin edit in between is never
 * overwritten. True when the member now holds `phone`.
 */
async function adoptPhoneIfUnset(userId: string, phone: string): Promise<boolean> {
  const current = await db.user.findUnique({
    where: { id: userId },
    select: { phoneNumber: true },
  });
  if (!current) return false;
  if (current.phoneNumber) return current.phoneNumber === phone;
  try {
    const { count } = await db.user.updateMany({
      where: { id: userId, phoneNumber: null },
      data: { phoneNumber: phone },
    });
    return count === 1;
  } catch {
    // Unique clash: another row claimed this number in a race. Not ours.
    return false;
  }
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
  let linkedPlaceholders = 0;

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
    // A user who already existed BY PHONE (another club, a web sign-up) is
    // the one case the pushname dedupe below cannot reach: they may have
    // a phoneless placeholder here from a third party's "X in". See the
    // link step after the membership write.
    const knownByPhone = user !== null;
    if (!user && pushname) {
      // No phone-keyed record — but a phone-less record (e.g. a provisional
      // member the analyzer/squad-list created earlier by NAME) may already
      // exist for this person. Dedup BEFORE creating, on a strong unambiguous
      // signal only (alias / unique exact-or-fuzzy name). Ambiguous names fall
      // through to a fresh create so two distinct people are never merged.
      const match = await findExistingOrgMember(orgId, { name: pushname });
      if (match && (await adoptPhoneIfUnset(match.userId, phone))) {
        // Counted as alreadyKnown by the else-branch below (user is now set).
        user = { id: match.userId, name: match.name };
      }
      // A match that already holds a DIFFERENT number is a different
      // WhatsApp account (a namesake, or the same person on a new number):
      // it is not this participant. Fall through and create them; the
      // saved user keeps their number, and no write touches them.
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
    let membershipChanged = false;
    if (!existing) {
      await db.membership.create({
        data: {
          userId: user.id,
          orgId,
          role: "PLAYER",
          lastSeenInGroupAt: now,
        },
      });
      membershipChanged = true;
    } else {
      await db.membership.update({
        where: { id: existing.id },
        data: {
          lastSeenInGroupAt: now,
          ...(existing.leftAt !== null ? { leftAt: null } : {}),
        },
      });
      if (existing.leftAt !== null) {
        restoredMembership += 1;
        membershipChanged = true;
      }
    }

    // Same link group-join makes (2026-09-29): a person known by phone
    // whose membership here is new or restored takes over the one
    // phoneless placeholder of their name, if there is exactly one. No DM
    // from the sweep; an ambiguous match shows on /admin/players instead.
    if (knownByPhone && membershipChanged) {
      const link = await linkJoinerToPlaceholder(orgId, user.id, { extraNames: [pushname] });
      if (link.kind === "linked") linkedPlaceholders += 1;
    }
  }

  // ── THE SWEEP'S OWN CLOCK (2026-09-09) ───────────────────────────
  //
  // `Organisation.lastParticipantSweepAt` records that a full READ of
  // the group's participant list SUCCEEDED. It is the only thing that
  // licenses the inference "we have never seen this person, therefore
  // they are not in the group", and this function is its only writer.
  //
  // It is stamped for the READ, not for the matching: a roster that is
  // entirely @lid participants imports zero rows and is still a
  // successful read of the list.
  //
  // An EMPTY list is NOT a successful read. That is the exact shape of
  // the 2026-07-07 breakage — `chat.participants` comes back `[]` with
  // nothing thrown — and the Pi already refuses to POST one. Stamping
  // it here would tell the gate, the admin banner and the health alert
  // that a dead sweep is healthy, which is the whole failure this
  // column exists to prevent.
  if (participants.length > 0) {
    await db.organisation.update({
      where: { id: orgId },
      data: { lastParticipantSweepAt: new Date() },
    });
  }

  return {
    added,
    alreadyKnown,
    skippedNoPhone,
    restoredMembership,
    linkedPlaceholders,
    total: participants.length,
  };
}

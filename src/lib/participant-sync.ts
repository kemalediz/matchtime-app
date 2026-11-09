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
 *   - Phone-keyed upsert of User; NEVER overwrites existing
 *     User.name/phoneNumber. No phone is attached to a phoneless member
 *     by a match of names (2026-11-09): an unknown number is a new member,
 *     and a phoneless placeholder who-is-who reads its WhatsApp name as
 *     is told to the club's admins once (`possible-duplicate-notice`).
 *   - A member known by phone whose name is EMPTY takes the WhatsApp name
 *     the Pi sends (2026-11-03, Vets MNF: 20 of 27 imported nameless, so
 *     the month's list matched 4 of 13). Only while it is still empty, and
 *     only a real name (`usableWhatsAppName`: never a number shown as a
 *     name). A new user is named the same way.
 *   - Membership upsert as PLAYER; restores soft-removed (leftAt) rows;
 *     always stamps lastSeenInGroupAt.
 *   - Stamps `Organisation.lastParticipantSweepAt` when the roster was
 *     non-empty (2026-09-09). This function is that column's ONLY
 *     writer — see the note at the bottom.
 *   - @lid-only participants (no resolvable phone) are skipped — the
 *     pushname resolvers pick them up the moment they message.
 */
import { db } from "./db";
import { linkJoinerToPlaceholder } from "./placeholder-link";
import { usableWhatsAppName } from "./resolve-sender";
import { notifyPossibleDuplicates } from "./possible-duplicate-notice";
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
 * Give a nameless member the WhatsApp name the Pi knows, ONLY while his
 * name is still empty (the write is conditional on it), so a name an
 * organiser or the member set in between is never replaced. Best effort:
 * a failure leaves him nameless and the sweep goes on.
 */
async function nameIfNameless(userId: string, name: string): Promise<void> {
  try {
    const { count } = await db.user.updateMany({ where: { id: userId, name: null }, data: { name } });
    if (count === 1) console.log(`[participant-sync] named ${userId} "${name}" from WhatsApp`);
  } catch (err) {
    console.error(`[participant-sync] naming ${userId} failed:`, err instanceof Error ? err.message : "failed");
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
  /** The members this sweep made from numbers it had never seen. */
  const newcomers: { userId: string; name: string | null }[] = [];

  for (const p of participants) {
    const phone = snapshotPhone(p);
    if (!phone) {
      skippedNoPhone += 1;
      continue;
    }
    const pushname = p.pushname?.trim() || null;
    // The name a user may be GIVEN: never a phone number or @lid digits.
    const waName = usableWhatsAppName(pushname);

    let user = await db.user.findUnique({
      where: { phoneNumber: phone },
      select: { id: true, name: true },
    });
    // A user who already existed BY PHONE (another club, a web sign-up) is
    // the one case the pushname dedupe below cannot reach: they may have
    // a phoneless placeholder here from a third party's "X in". See the
    // link step after the membership write.
    const knownByPhone = user !== null;
    // NO PHONE IS ATTACHED BY NAME (2026-11-09, review of #574). A
    // newcomer's number used to be given to a phoneless member whose name
    // matched the WhatsApp name by spelling (a first-name PREFIX
    // included), so a new "Dav" could take over Davide's placeholder and
    // every message and charge after it. Now an unknown number is a new
    // member. When who-is-who reads the newcomer's WhatsApp name as a
    // phoneless provisional member, the club's admins are told once
    // (`notifyPossibleDuplicates`, after the loop) and merge the two on
    // /admin/players. Nobody is merged by code.
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
          name: waName,
          phoneNumber: phone,
          email: `wa-sync+${slug}-${Date.now().toString(36)}@matchtime.local`,
          isActive: true,
          onboarded: false,
        },
        select: { id: true, name: true },
      });
      added += 1;
      newcomers.push({ userId: user.id, name: waName });
    } else {
      alreadyKnown += 1;
      if (!user.name && waName) await nameIfNameless(user.id, waName);
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

  // A newcomer who may be a phoneless placeholder of the club: the
  // admins are told once, by who-is-who, never merged by code (review of
  // #574, round 3). Never throws.
  if (newcomers.length > 0) await notifyPossibleDuplicates(orgId, newcomers);

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

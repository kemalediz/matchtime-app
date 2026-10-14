/**
 * CAN MATCHTIME POST IN THIS GROUP? (2026-10-14)
 *
 * Clubs often run as a WhatsApp community whose "announcements" group only
 * admins can send in. WhatsApp also lets any group be switched to "only
 * admins can send messages". A post from a member who is not an admin there
 * reaches nobody, so MatchTime must know, per group, before it posts.
 *
 * Baileys reports both settings in its group metadata (rc14
 * `extractGroupMetadata`, lib/Socket/groups.js): `announce` (the group's
 * `announcement` node), `isCommunityAnnounce` (`default_sub_group`) and each
 * participant's `admin` ("admin" | "superadmin" | null). It keeps them
 * current with two events: `groups.update` carrying `announce` when the
 * setting is switched (process-message.js, GROUP_CHANGE_ANNOUNCE), and
 * `group-participants.update` with action "promote" / "demote".
 *
 * THE RULE, once: MatchTime can post when it is an admin, or when the group
 * is neither admin-only nor a community announcements group.
 *
 * NEVER BLOCK ON A GUESS. A roster that does not contain MatchTime (our ids
 * not known yet, or an addressing mismatch) gives NO reading at all, and a
 * group with no reading is never gated: exactly today's behaviour.
 *
 * Pure: no socket, no server. The Baileys driver feeds it; the send gate
 * (`postability-gate.ts`) and the server report (`postability-report.ts`)
 * read it.
 */
import {
  isAdminParticipant,
  legacyIdsOf,
  participantOf,
  type ParticipantLike,
} from "./baileys/groups.js";

export type PostabilityReason = "ok" | "admin-only" | "community-announce";

export interface GroupPostability {
  /** Only admins can send messages. */
  announce: boolean;
  /** A community's announcements group. */
  communityAnnounce: boolean;
  /** MatchTime is an admin (or the creator) of the group. */
  botIsAdmin: boolean;
  canPost: boolean;
  reason: PostabilityReason;
}

export function decidePostability(f: {
  announce: boolean;
  communityAnnounce: boolean;
  botIsAdmin: boolean;
}): GroupPostability {
  const announce = f.announce === true;
  const communityAnnounce = f.communityAnnounce === true;
  const botIsAdmin = f.botIsAdmin === true;
  const restricted = announce || communityAnnounce;
  const canPost = botIsAdmin || !restricted;
  const reason: PostabilityReason = canPost ? "ok" : communityAnnounce ? "community-announce" : "admin-only";
  return { announce, communityAnnounce, botIsAdmin, canPost, reason };
}

export function samePostability(a: GroupPostability | undefined, b: GroupPostability | undefined): boolean {
  if (!a || !b) return a === b;
  return (
    a.announce === b.announce &&
    a.communityAnnounce === b.communityAnnounce &&
    a.botIsAdmin === b.botIsAdmin &&
    a.canPost === b.canPost
  );
}

/** The metadata fields read here: Baileys' `GroupMetadata`, or the listing's. */
export interface PostabilityMetaLike {
  id?: string | null;
  announce?: boolean | null;
  isCommunityAnnounce?: boolean | null;
  participants?: ReadonlyArray<ParticipantLike | string> | null;
}

function findSelf(
  participants: ReadonlyArray<ParticipantLike | string> | null | undefined,
  selfIds: ReadonlySet<string>,
): ParticipantLike | null {
  if (selfIds.size === 0) return null;
  for (const raw of participants ?? []) {
    if (legacyIdsOf(raw).some((id) => selfIds.has(id))) return participantOf(raw);
  }
  return null;
}

/**
 * The reading for one metadata read, or null when MatchTime is not found
 * in its roster (unknown: never gated). `selfIds` are our ids in legacy
 * spelling (`447...@c.us`, `158...@lid`), as the driver's `selfLegacy()`.
 */
export function postabilityFromMetadata(
  meta: PostabilityMetaLike | null | undefined,
  selfIds: ReadonlySet<string>,
): GroupPostability | null {
  if (!meta) return null;
  const self = findSelf(meta.participants, selfIds);
  if (!self) return null;
  return decidePostability({
    announce: meta.announce === true,
    communityAnnounce: meta.isCommunityAnnounce === true,
    botIsAdmin: isAdminParticipant(self),
  });
}

export interface ParticipantsChangeLike {
  id?: string | null;
  action?: string | null;
  participants?: ReadonlyArray<ParticipantLike | string> | null;
}

export type PostabilityListener = (
  groupId: string,
  next: GroupPostability,
  prev: GroupPostability | undefined,
) => void;

export interface PostabilityTracker {
  /** A `groupMetadata` read, a listing entry or a `groups.upsert`. */
  applyMetadata(meta: PostabilityMetaLike | null | undefined, selfIds: ReadonlySet<string>): void;
  /** A `groups.update` partial. Only `announce` matters here. */
  applyGroupUpdate(partial: { id?: string | null; announce?: boolean | null } | null | undefined): void;
  /** A `group-participants.update`: our own promote, demote or removal. */
  applyParticipants(update: ParticipantsChangeLike | null | undefined, selfIds: ReadonlySet<string>): void;
  /** The last reading, or undefined when there is none (never gated). */
  get(groupId: string): GroupPostability | undefined;
  forget(groupId: string): void;
  /** Called on the first reading of a group and on every real change. */
  onChange(listener: PostabilityListener): void;
}

export function createPostabilityTracker(opts: { error?: (line: string) => void } = {}): PostabilityTracker {
  const error = opts.error ?? ((l: string) => console.error(l));
  const byGroup = new Map<string, GroupPostability>();
  const listeners: PostabilityListener[] = [];

  function set(groupId: string, next: GroupPostability): void {
    const prev = byGroup.get(groupId);
    byGroup.set(groupId, next);
    if (samePostability(prev, next)) return;
    for (const l of listeners) {
      try {
        l(groupId, next, prev);
      } catch (err) {
        error(`[postability] a listener failed for ${groupId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  return {
    applyMetadata(meta, selfIds) {
      const id = meta?.id;
      if (!id) return;
      const p = postabilityFromMetadata(meta, selfIds);
      if (p) set(id, p);
    },

    applyGroupUpdate(partial) {
      const id = partial?.id;
      if (!id || typeof partial?.announce !== "boolean") return;
      const prev = byGroup.get(id);
      if (!prev) return;
      set(id, decidePostability({ ...prev, announce: partial.announce }));
    },

    applyParticipants(update, selfIds) {
      const id = update?.id;
      if (!id) return;
      const involvesSelf = (update?.participants ?? []).some((p) => legacyIdsOf(p).some((x) => selfIds.has(x)));
      if (!involvesSelf) return;
      if (update?.action === "remove") {
        byGroup.delete(id);
        return;
      }
      if (update?.action !== "promote" && update?.action !== "demote") return;
      const prev = byGroup.get(id);
      if (!prev) return;
      set(id, decidePostability({ ...prev, botIsAdmin: update.action === "promote" }));
    },

    get(groupId) {
      return byGroup.get(groupId);
    },

    forget(groupId) {
      byGroup.delete(groupId);
    },

    onChange(listener) {
      listeners.push(listener);
    },
  };
}

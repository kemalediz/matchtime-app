/**
 * CAN MATCHTIME POST IN THIS GROUP? The server's pure half (2026-10-14).
 *
 * Clubs often run as a WhatsApp community whose "announcements" group only
 * admins can send in, and any group can be switched to "only admins can
 * send messages". A post from MatchTime there, when it is not an admin,
 * reaches nobody. The Pi reads the settings from WhatsApp
 * (whatsapp-bot/src/group-postability.ts) and reports three booleans; this
 * file holds the same rule, the pause/resume plan and the organiser's
 * texts. The DB half is group-postability.ts.
 *
 * NEVER BLOCK ON A GUESS: an input that is not exactly three booleans is no
 * reading at all, and no reading changes nothing.
 */
import { t } from "./i18n/t";

export interface PostabilityInput {
  announce: boolean;
  communityAnnounce: boolean;
  botIsAdmin: boolean;
}

export type PostabilityReason = "ok" | "admin-only" | "community-announce";

export function parsePostabilityInput(raw: unknown): PostabilityInput | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.announce !== "boolean" || typeof r.communityAnnounce !== "boolean" || typeof r.botIsAdmin !== "boolean") {
    return null;
  }
  return { announce: r.announce, communityAnnounce: r.communityAnnounce, botIsAdmin: r.botIsAdmin };
}

/** MatchTime can post when it is an admin, or when the group is neither
 *  admin-only nor a community announcements group. The Pi's rule. */
export function decideGroupPostability(p: PostabilityInput): { canPost: boolean; reason: PostabilityReason } {
  const restricted = p.announce || p.communityAnnounce;
  if (p.botIsAdmin || !restricted) return { canPost: true, reason: "ok" };
  return { canPost: false, reason: p.communityAnnounce ? "community-announce" : "admin-only" };
}

/** The stored state the plan reads. */
export interface PostStatePrev {
  canPost: boolean;
  blockedSince: Date | null;
  noticeSentAt: Date | null;
}

/**
 * One reading against the last: when the stretch of "cannot post" began,
 * whether the organisers are due their one notice, and whether this reading
 * ends a stretch (resume, clear the alert).
 */
export function planPostStateChange(args: { prev: PostStatePrev | null; canPost: boolean; now: Date }): {
  blockedSince: Date | null;
  noticeDue: boolean;
  becamePostable: boolean;
} {
  const { prev, canPost, now } = args;
  if (canPost) {
    return { blockedSince: null, noticeDue: false, becamePostable: !!prev && !prev.canPost };
  }
  const continuing = !!prev && !prev.canPost;
  const blockedSince = continuing ? (prev!.blockedSince ?? now) : now;
  const told = prev?.noticeSentAt ?? null;
  // Told for this stretch already, or told less than a day ago (a setting
  // switched off and on again, or a reading that flapped): not again.
  const toldThisStretch = !!told && told.getTime() >= blockedSince.getTime();
  const toldRecently = !!told && now.getTime() - told.getTime() < NOTICE_REPEAT_MS;
  return {
    blockedSince,
    noticeDue: !toldThisStretch && !toldRecently,
    becamePostable: false,
  };
}

/** At most one notice per group per this long, however often its setting flaps. */
export const NOTICE_REPEAT_MS = 24 * 60 * 60 * 1000;

// ── What the organisers are told ─────────────────────────────────────────

/** To the organiser who added MatchTime while connecting their club. */
export function connectNotPostableText(
  lang: string | null | undefined,
  p: { group: string | null; reason: Exclude<PostabilityReason, "ok"> },
): string {
  const s = t(lang);
  return p.reason === "community-announce" ? s.gp_connect_community({ group: p.group }) : s.gp_connect_admin_only({ group: p.group });
}

/** To a live club's organisers: their group became one MatchTime cannot post in. */
export function liveGroupNotPostableText(
  lang: string | null | undefined,
  p: { club: string; reason: Exclude<PostabilityReason, "ok"> },
): string {
  return t(lang).gp_live_blocked({ club: p.club, community: p.reason === "community-announce" });
}

/** To a club's one person: its admin group became one MatchTime cannot post in. */
export function adminGroupNotPostableText(lang: string | null | undefined, p: { club: string; group: string | null }): string {
  return t(lang).gp_admin_group_blocked({ club: p.club, group: p.group });
}

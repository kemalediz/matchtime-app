/**
 * APP SELF-IN GROUP-MEMBERSHIP GATE.
 *
 * Closes a loophole: a signed-in web user (matchtime.ai) could mark
 * THEMSELVES "in" on a match even if they were NOT part of the org's
 * WhatsApp group. Attendance is a group activity — self-IN from the app
 * must be reserved for real group members.
 *
 * This gate applies ONLY to the app's self-IN action (the `attendMatch`
 * server action → the "I'm in!" button). It does NOT touch:
 *   - the WhatsApp bot path (analyze route → registerAttendance),
 *   - guest-adds a member types from inside the WhatsApp group,
 *   - admin add-player from the dashboard,
 * all of which legitimately register people who may not (yet) be group
 * members and stay ungated.
 *
 * "LLM extracts, code decides" sibling: pure, DB-free logic. The caller
 * (attendMatch) fetches the Membership row for the match's org, the org's
 * sync freshness, and (only when needed) the fallback evidence, and feeds
 * the relevant fields in.
 *
 * ── WHY THERE IS A DEGRADED MODE (2026-08-31) ────────────────────────────
 *
 * `Membership.lastSeenInGroupAt` has exactly ONE writer: the bot's startup
 * participant sweep (`whatsapp-bot/src/index.ts` → `/api/whatsapp/sync-
 * participants` → `importParticipants`). That sweep has been failing since
 * 2026-07-07 because whatsapp-web.js's injected page code is out of step
 * with the live WhatsApp Web build (see MDs/cold-audit-2026-08-31.md).
 *
 * While it is down the column is frozen, and a null sighting stops meaning
 * "you are not in the group" and starts meaning "I have not been able to
 * look". Nine real Sutton players, including regulars and someone who
 * joined the group yesterday, were being told to their face that they were
 * not in a group they were sitting in. The set grew every week.
 *
 * The gate is not wrong. Treating a STALE signal as proof of absence is
 * wrong. So:
 *   - while the sweep is FRESH, nothing changes at all,
 *   - while it is STALE, a null sighting alone no longer denies; we look
 *     for positive evidence that this person really is in this club's
 *     group, and if we cannot find any we still deny, but we say something
 *     TRUE instead of an accusation.
 */

/**
 * How old the most recent successful participant sweep may be before we
 * stop trusting `lastSeenInGroupAt` as evidence of ABSENCE.
 *
 * Ten days. The sweep runs on every bot `ready` event, so on every deploy,
 * reboot and WhatsApp Web reconnect — in practice several times a week.
 *
 *   - 7 days is too tight: a genuinely healthy bot that stays connected
 *     through a quiet week with no deploy would be declared broken.
 *   - 14 days is too loose: a fortnight of silent breakage is a fortnight
 *     of blocking every new joiner, and the 2026-07-07 outage ran for
 *     eight weeks before anyone noticed.
 *   - 10 days clears any plausible healthy quiet run (it is longer than a
 *     fortnightly deploy rhythm) while catching a real outage inside its
 *     second week, before the blocked set grows past a name or two.
 *
 * The two errors are not symmetric, which is why we lean towards calling
 * it stale: a false "stale" only opens a narrow, evidence-gated fallback,
 * whereas a false "fresh" tells real players a falsehood and locks them
 * out of the button.
 */
export const GROUP_SYNC_FRESHNESS_DAYS = 10;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface GateMembership {
  /** Non-null once the user has left / been removed from the org's
   *  WhatsApp group. Strongest deny signal — someone who left the group
   *  cannot self-IN, regardless of role, and it is written by the
   *  `group_leave` event and by admins, so it is NOT affected by the
   *  participant sweep being down. */
  leftAt: Date | null;
  /** Last time the bot saw this user in the org's WhatsApp group
   *  participant sync. Null = never confirmed in the group. Only
   *  trustworthy as evidence of absence while the sweep is fresh. */
  lastSeenInGroupAt: Date | null;
  role: "OWNER" | "ADMIN" | "PLAYER";
}

/** Health of the org's participant sweep, derived from existing data. */
export interface GroupSyncStatus {
  /** MAX(`Membership.lastSeenInGroupAt`) across every membership of the
   *  org (left rows included — this measures when a SWEEP last succeeded,
   *  not who is currently on the roster). Null when no sweep has ever
   *  succeeded for this org. */
  lastSyncAt: Date | null;
  now: Date;
}

/**
 * Positive evidence that this person really is in this club's WhatsApp
 * group. Only consulted while the sweep is stale — never on the healthy
 * path, so the original protection is untouched when the signal is good.
 *
 * Both signals are chosen because they can only have been produced by
 * somebody who was in the group:
 *
 *   - `authoredGroupMessages`: `AnalyzedMessage` rows for this org whose
 *     `authorUserId` is this user. The bot only ever analyses messages
 *     from the org's monitored group, and only a participant can post
 *     there. This is direct proof of presence.
 *
 *   - `clubAttendances`: `Attendance` rows on this org's matches. Every
 *     one of those was written by the bot reading an IN in the group, by
 *     an admin on the dashboard, or by a member's guest-add from inside
 *     the group. The app's own self-IN cannot be their origin, because
 *     that is the very path this gate stands in front of. So an
 *     attendance row means a member of the group put this person in a
 *     squad for this club.
 *
 * Deliberately NOT used: `provisionallyAddedAt`. It is set both when an
 * unknown sender posts in the group (good evidence) and when a name is
 * merely mentioned in a squad list (weak), and it is cleared the moment
 * an admin edits the player, so its absence means nothing either way.
 */
export interface GroupPresenceEvidence {
  /** AnalyzedMessage rows in the org's group authored by this user. */
  authoredGroupMessages: number;
  /** Attendance rows on this org's matches for this user. */
  clubAttendances: number;
}

export interface SelfMarkInContext {
  sync: GroupSyncStatus;
  evidence: GroupPresenceEvidence;
}

export type SelfMarkInReason =
  /** No Membership row for this org at all. */
  | "no-membership"
  /** Membership exists but `leftAt` is set. Always denies. */
  | "left-group"
  /** OWNER/ADMIN exemption: they manage the roster. */
  | "admin"
  /** The sweep confirmed them in the group. */
  | "seen-in-group"
  /** Sweep is stale; they have posted in the club's WhatsApp group. */
  | "degraded-posted-in-group"
  /** Sweep is stale; they have already been in a squad for this club. */
  | "degraded-plays-for-club"
  /** Sweep is fresh and it has never seen them. They are not in the group. */
  | "not-in-group"
  /** Sweep is stale and we found no evidence either way. */
  | "degraded-no-evidence";

export interface SelfMarkInDecision {
  allowed: boolean;
  reason: SelfMarkInReason;
  /** True when the participant sweep was stale AND that staleness is what
   *  the decision turned on. Callers log this so "the gate is running
   *  degraded" is never invisible. */
  degraded: boolean;
}

/** Whole days since the last successful sweep, or null while it is fresh.
 *  `Infinity` when no sweep has ever succeeded for this org. */
export function groupSyncStaleDays(sync: GroupSyncStatus): number | null {
  if (sync.lastSyncAt === null) return Infinity;
  const days = (sync.now.getTime() - sync.lastSyncAt.getTime()) / DAY_MS;
  return days > GROUP_SYNC_FRESHNESS_DAYS ? Math.floor(days) : null;
}

/**
 * Has the org's participant sweep gone quiet for longer than we are
 * willing to trust it?
 *
 * A never-synced org counts as stale, not as healthy: "no sweep has ever
 * succeeded here" carries even less information than "the last one was a
 * while ago", and reading it as healthy would deny every player in a
 * freshly onboarded club.
 */
export function isGroupSyncStale(sync: GroupSyncStatus): boolean {
  return groupSyncStaleDays(sync) !== null;
}

/** Context used when a caller supplies none: assume the sweep is healthy
 *  and there is no evidence, i.e. the strict pre-2026-08-31 behaviour.
 *  Callers that have not been taught about staleness must never fall into
 *  the relaxed path by accident. */
function strictContext(): SelfMarkInContext {
  const now = new Date();
  return {
    sync: { lastSyncAt: now, now },
    evidence: { authoredGroupMessages: 0, clubAttendances: 0 },
  };
}

/**
 * May this user mark THEMSELVES in from the app, and why?
 *
 * Order matters:
 *   1. No membership          → deny.
 *   2. `leftAt` set           → deny. Strongest signal, independent of the
 *                               sweep, and the admin exemption does NOT
 *                               override it.
 *   3. OWNER/ADMIN            → allow. They manage the roster.
 *   4. Seen in the group      → allow.
 *   5. Sweep fresh            → deny. The signal is good, so never seen
 *                               really does mean not in the group.
 *   6. Sweep stale + evidence → allow, flagged degraded.
 *   7. Sweep stale, no evidence → deny, flagged degraded, with an honest
 *                               message (see `selfMarkInDenialMessage`).
 */
export function decideSelfMarkIn(
  m: GateMembership | null,
  ctx: SelfMarkInContext = strictContext(),
): SelfMarkInDecision {
  if (!m) return { allowed: false, reason: "no-membership", degraded: false };

  // A member who left the WhatsApp group can never self-IN. `leftAt` is
  // written by the group_leave event and by admins, so it stays truthful
  // even while the participant sweep is down.
  if (m.leftAt !== null) return { allowed: false, reason: "left-group", degraded: false };

  // Admins/owners manage the roster; they don't need a group-sync sighting.
  if (m.role === "OWNER" || m.role === "ADMIN") {
    return { allowed: true, reason: "admin", degraded: false };
  }

  // A plain player confirmed by the sweep, whenever that sweep last ran.
  if (m.lastSeenInGroupAt !== null) {
    return { allowed: true, reason: "seen-in-group", degraded: false };
  }

  // Never seen. Whether that means anything depends entirely on whether
  // the sweep has been able to look.
  if (!isGroupSyncStale(ctx.sync)) {
    return { allowed: false, reason: "not-in-group", degraded: false };
  }

  if (ctx.evidence.authoredGroupMessages > 0) {
    return { allowed: true, reason: "degraded-posted-in-group", degraded: true };
  }
  if (ctx.evidence.clubAttendances > 0) {
    return { allowed: true, reason: "degraded-plays-for-club", degraded: true };
  }
  return { allowed: false, reason: "degraded-no-evidence", degraded: true };
}

/**
 * May this user mark THEMSELVES in from the app?
 *
 * Thin boolean wrapper over `decideSelfMarkIn` for call sites that do not
 * need the reason.
 */
export function canSelfMarkIn(m: GateMembership | null, ctx?: SelfMarkInContext): boolean {
  return decideSelfMarkIn(m, ctx).allowed;
}

/**
 * What we tell the player when the gate says no.
 *
 * The healthy-path wording is unchanged: when the sweep is working, "you
 * are not in the group" is a true statement and the fix really is to get
 * added.
 *
 * The degraded wording exists because the old line was a lie whenever the
 * sweep was down. It does not accuse the player of anything, it says why
 * we cannot confirm, and it points at replying IN in the group, which goes
 * through the bot's analyze path and works no matter what the participant
 * sweep is doing.
 */
export function selfMarkInDenialMessage(reason: SelfMarkInReason, clubName: string): string {
  if (reason === "degraded-no-evidence") {
    return (
      `We cannot confirm your place in the ${clubName} WhatsApp group right now, because ` +
      "MatchTime has not been able to read the group's member list for a while. Reply IN on " +
      "the group and we will put you straight down. Sorry for the extra step."
    );
  }
  return (
    `You need to be in the ${clubName} WhatsApp group to mark yourself in. ` +
    "Ask a member to add you in the group."
  );
}

/**
 * One line for the admin player list when the participant sweep has gone
 * quiet, so a degraded gate is visible to the person who can do something
 * about it. Null while the sweep is healthy.
 *
 * Paired with the `console.warn` the server action emits on every degraded
 * decision. Between them, "the gate is running degraded" is never silent.
 */
export function groupSyncAdminWarning(sync: GroupSyncStatus): string | null {
  const days = groupSyncStaleDays(sync);
  if (days === null) return null;
  const age =
    days === Infinity
      ? "MatchTime has never managed to read this group's member list"
      : `MatchTime last read this group's member list ${days} days ago`;
  return (
    `${age}, so it cannot tell who is currently in the WhatsApp group. Players who joined ` +
    "since then can only mark themselves in on the app if we already have them in a squad " +
    "or have seen them post in the group. Everyone else should reply IN in the group, which " +
    "always works. Worth restarting the bot."
  );
}

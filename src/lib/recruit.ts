/**
 * Recruit recent players to the next match (2026-06-05).
 *
 * Admin-triggered DM blast: nudges everyone who played in the last few
 * completed matches but hasn't yet responded to the upcoming one, asking
 * them to grab a spot. Born from a real gap — the analyzer's LLM was
 * *claiming* "I'll DM the recent players" with no action behind it
 * (Kemal 2026-06-05). This is the real action so the claim becomes true.
 *
 * Authorisation is the CALLER's job (org admin/owner). This lib just does
 * the work for a given orgId.
 */
import { db } from "./db";
import { signMagicLinkToken, MAGIC_LINK_TTL } from "./magic-link";
import { buildShortMagicLinkUrl } from "./short-link";
import { formatLondon } from "./london-time";
import { getOrgFeatures } from "./org-features";
import { recruitDmLinkKey, RECRUIT_DM_LINK_KIND } from "./recruit-reaction";

/**
 * How many recent COMPLETED matches to pull attendees from.
 *
 * Widened 3 → 5 at the owner's request (2026-08-31). Measured pool sizes
 * for that club (12 completed matches, 73 active members):
 *   lookback 3 → 17 players, 5 → 22, 10 → 35, 12 → 39.
 * At 3, after excluding everyone already registered, only 9 invites went
 * out and the squad stayed short.
 *
 * DO NOT raise this default further. The bot runs on an UNOFFICIAL
 * WhatsApp client; a mass-DM risks the account being banned, which takes
 * the whole product down. `inviteRecentPlayers` takes a per-invocation
 * override so the window can be tuned for one blast without a deploy, and
 * that override is clamped to RECRUIT_LOOKBACK_MAX for the same reason.
 */
export const LOOKBACK_MATCHES = 5;

/** Hard ceiling on the per-invocation override. Ban-risk backstop. */
export const RECRUIT_LOOKBACK_MAX = 12;

/**
 * Sanitise a caller-supplied lookback: floor it, clamp it to
 * [1, RECRUIT_LOOKBACK_MAX], and fall back to the default when it is
 * missing or not a finite number.
 */
export function resolveLookbackMatches(requested?: number): number {
  if (requested === undefined || requested === null || !Number.isFinite(requested)) {
    return LOOKBACK_MATCHES;
  }
  return Math.min(RECRUIT_LOOKBACK_MAX, Math.max(1, Math.floor(requested)));
}

/** Does this message read like an EXPLICIT "we need more players" request?
 *  Used by both the in-group fast-path and the admin DM handler. Fires
 *  ONLY on (a) an explicit recruit verb (find/get/invite/recruit/grab/
 *  round up, or dm/message/text/nudge) sitting ADJACENT to a people/
 *  recency/spots noun, OR (b) an explicit shortage phrase ("we're short",
 *  "need N more players", "anyone free", "spots left", …) — adjacency
 *  required in both cases (proximity-anchored, not scattered words). A
 *  plain LIST/SHOW/who's-playing roster question is EXCLUDED — those are
 *  answered by the roster, never by a DM blast. */
export function looksLikeRecruitRequest(text: string): boolean {
  const t = text.toLowerCase();

  // Hard exclusions: plain roster list/show questions are answered by the
  // roster, never by a DM blast. If the message is fundamentally a
  // "list/show/who's playing" request, it's not a recruit request.
  const isListRequest =
    /\b(list|show|who(?:'s| is| are)?)\b[^.?!\n]*\b(playing|player|players|squad|team|roster|lineup|line-?up)\b/.test(
      t,
    );
  if (isListRequest) return false;

  // Explicit recruit verb adjacent to a people/recency/spots noun.
  // e.g. "get more players", "round up the lads", "invite recent players",
  //      "grab a couple of players", "dm the recent players".
  const recruitVerbNearPeople =
    /\b(?:find|get|grab|invite|recruit|round\s+up|dm|message|text|nudge)\b(?:\W+\w+){0,4}\W+(?:more\s+)?(?:players?|people|lads|recent(?:\s+(?:players?|attendees|lads))?|attendees|spots?|slots?)\b/.test(
      t,
    );

  // Explicit shortage / need phrasing adjacent to players/spots.
  const shortagePhrase =
    /\bwe(?:'re|\s+are)\s+short\b/.test(t) ||
    /\bneed(?:ing)?\b(?:\W+\w+){0,3}\W+(?:more\s+)?(?:players?|people|spots?|slots?|bodies)\b/.test(
      t,
    ) ||
    /\b(?:\d+|one|two|three|four|five|a\s+couple|a\s+few|some)\s+(?:more\s+)?(?:players?|spots?|slots?)\s+(?:needed|short|left|open|free|available)\b/.test(
      t,
    ) ||
    /\b(?:any(?:one|body))\s+(?:free|available|around|up\s+for\s+it)\b/.test(t) ||
    /\b(?:spots?|slots?)\s+(?:left|open|available|free)\b/.test(t) ||
    /\bneed\s+(?:more\s+)?players?\b/.test(t);

  return recruitVerbNearPeople || shortagePhrase;
}

/* ────────────────────────────────────────────────────────────────────
 * THE INVITE COPY
 *
 * Rewritten 2026-08-31 at the owner's instruction. The old invite led
 * with a magic link:
 *
 *   "👋 Abid — we're putting the squad together for *Tuesday 7-a-side*
 *    on Tue 1 Sept, 21:30 — 4 spots left. Fancy it?
 *
 *    Tap to grab a spot:
 *    <link>"
 *
 * Half of this club is older and not technical. They do not tap links;
 * they reply, or they tap the emoji their thumb is already near. So the
 * ASK now leads and the link is demoted to a trailing option.
 *
 * SAYING NO IS AS EASY AS SAYING YES (owner, same day). A chase-up DM
 * for silent players is being built alongside this; a player who cannot
 * make it but never answers gets chased for no reason. Offering *OUT*
 * and 👎 as plainly as *IN* and 👍 is what keeps the club considerate
 * rather than naggy — hence "I'll stop asking".
 *
 * The link is KEPT rather than dropped: some players do use the app, and
 * it doubles as their sign-in path (it is a magic link, so tapping it is
 * how a player gets an authenticated session at all).
 *
 * House style: no em dashes, no en dashes, no slashes in prose. Only the
 * URL contains a slash.
 * ──────────────────────────────────────────────────────────────────── */

export interface RecruitInviteCopy {
  firstName: string;
  matchName: string;
  /** "EEE d MMM, HH:mm" London. */
  matchWhen: string;
  /** Open slots. 0 means "suppressed or full" and the phrase is omitted. */
  spotsLeft: number;
  /** Short magic link, or null to omit the optional last line entirely. */
  link: string | null;
}

/** The invite for an org that tracks attendance in-app. */
export function buildRecruitInviteDm(c: RecruitInviteCopy): string {
  const spots =
    c.spotsLeft > 0 ? ` ${c.spotsLeft} ${c.spotsLeft === 1 ? "spot" : "spots"} left.` : "";
  const lines = [
    `👋 ${c.firstName}, we're putting the squad together for *${c.matchName}* on ${c.matchWhen}.${spots}`,
    "",
    "Playing? Reply *IN* or tap 👍 on this message.",
    "Can't make it? Reply *OUT* or tap 👎 and I'll stop asking 🙌",
  ];
  if (c.link) lines.push("", `Prefer the app? ${c.link}`);
  return lines.join("\n");
}

/**
 * The invite for a MoM/ratings-only org. There is no in-app squad, so an
 * RSVP link would do nothing and the group is where they join.
 */
export function buildRecruitGroupInviteDm(c: {
  firstName: string;
  matchName: string;
  matchWhen: string;
}): string {
  return (
    `👋 ${c.firstName}, we're putting the squad together for *${c.matchName}* on ${c.matchWhen}. ` +
    `Fancy it? Just reply *IN* in the group and you're sorted 🙌`
  );
}

export interface RecruitResult {
  ok: boolean;
  /** Set when ok=false — why nothing happened (for an admin-facing reply). */
  reason?: string;
  matchId?: string;
  matchName?: string;
  /** "EEE d MMM, HH:mm" London. */
  matchWhen?: string;
  /** Open slots on the upcoming match (maxPlayers − confirmed). */
  need?: number;
  /** How many invite DMs were newly queued this call. */
  invited?: number;
  /** Names invited (for the admin confirmation). */
  invitedNames?: string[];
  /** Candidates that existed but were SKIPPED this call purely because they
   *  were already invited for this match (idempotency). Lets the caller tell
   *  "already pinged everyone, awaiting replies" apart from "no candidates at
   *  all" — the two otherwise return identical (invited:0) shapes. */
  alreadyInvited?: number;
}

export async function inviteRecentPlayers(
  orgId: string,
  /** Override the number of recent completed matches to draw candidates
   *  from. Defaults to LOOKBACK_MATCHES; clamped to RECRUIT_LOOKBACK_MAX. */
  lookbackMatches?: number,
): Promise<RecruitResult> {
  const lookback = resolveLookbackMatches(lookbackMatches);
  // 1. The next upcoming match.
  const startToday = new Date();
  startToday.setUTCHours(0, 0, 0, 0);
  const next = await db.match.findFirst({
    where: {
      activity: { orgId },
      isHistorical: false,
      status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] },
      date: { gte: startToday },
    },
    orderBy: { date: "asc" },
    select: {
      id: true,
      date: true,
      maxPlayers: true,
      activity: { select: { name: true } },
      attendances: { select: { userId: true, status: true } },
    },
  });
  if (!next) return { ok: false, reason: "There's no upcoming match to invite players to." };

  // Anyone with ANY attendance row has already responded (in / bench /
  // explicitly out) — don't pester them. We only invite recent players
  // who haven't engaged with this match at all.
  const responded = new Set(next.attendances.map((a) => a.userId));
  const confirmedCount = next.attendances.filter((a) => a.status === "CONFIRMED").length;
  // Only meaningful when the org actually tracks attendance. For MoM/
  // ratings-only orgs (e.g. Sutton Lads) confirmed is always 0, so the
  // count would falsely read "14 spots left" in every invite — suppress it.
  const attendanceOn = (await getOrgFeatures(orgId)).attendance;
  // Real capacity, independent of the attendance feature flag. CONFIRMED
  // fills the squad, so open slots = maxPlayers − confirmed. `need` is kept
  // for DISPLAY copy (suppressed for ratings-only orgs) so the visible
  // "N spots left" behaviour is unchanged.
  const openSlots = Math.max(0, next.maxPlayers - confirmedCount);
  const need = attendanceOn ? openSlots : 0;

  // formatLondon needed both by the capacity-guard early return and the
  // normal return paths — compute it once, up front.
  const matchWhen = formatLondon(next.date, "EEE d MMM, HH:mm");

  // CAPACITY GUARD: if the confirmed squad is already full there are no
  // open spots to recruit for — bail before building the candidate map /
  // DM loop. Only applies when the org tracks capacity (maxPlayers > 0);
  // for attendance-off orgs confirmedCount is always 0 so openSlots stays
  // > 0 and this never blocks them (they recruit via the group, capacity
  // isn't really tracked) — desired behaviour.
  if (next.maxPlayers > 0 && openSlots <= 0) {
    return {
      ok: true,
      matchId: next.id,
      matchName: next.activity.name,
      matchWhen,
      need,
      invited: 0,
      invitedNames: [],
      reason: `The squad for *${next.activity.name}* is already full — no open spots to recruit for.`,
    };
  }

  // 2. Distinct CONFIRMED attendees from the last few completed matches.
  const recent = await db.match.findMany({
    where: { activity: { orgId }, isHistorical: false, status: "COMPLETED" },
    orderBy: { date: "desc" },
    take: lookback,
    select: {
      attendances: {
        where: { status: "CONFIRMED" },
        select: { userId: true, user: { select: { id: true, name: true, phoneNumber: true } } },
      },
    },
  });

  // Respect per-category DM subscriptions: anyone who opted OUT of match
  // invites (subMatchInviteDm=false on their membership for this org) is
  // excluded from the recruit blast. Default is subscribed, so only
  // explicit opt-outs are filtered.
  const inviteOptedOut = new Set(
    (
      await db.membership.findMany({
        where: { orgId, subMatchInviteDm: false },
        select: { userId: true },
      })
    ).map((mem) => mem.userId),
  );

  const candidates = new Map<string, { id: string; name: string | null; phone: string }>();
  for (const m of recent) {
    for (const a of m.attendances) {
      if (responded.has(a.userId)) continue; // already responded to next match
      if (inviteOptedOut.has(a.userId)) continue; // opted out of match-invite DMs
      if (!a.user.phoneNumber) continue; // can't DM without a number
      candidates.set(a.user.id, { id: a.user.id, name: a.user.name, phone: a.user.phoneNumber });
    }
  }

  if (candidates.size === 0) {
    return {
      ok: true,
      matchId: next.id,
      matchName: next.activity.name,
      matchWhen,
      need,
      invited: 0,
      invitedNames: [],
    };
  }

  // 3. Queue an invite DM per candidate, idempotent per match.
  const invitedNames: string[] = [];
  let alreadyInvited = 0;
  for (const c of candidates.values()) {
    const key = `${next.id}:recruit-dm:${c.id}`;
    const exists = await db.sentNotification.findUnique({ where: { key }, select: { id: true } });
    if (exists) {
      alreadyInvited++; // candidate existed but was pinged on an earlier call
      continue;
    }
    const first = c.name?.split(" ")[0] ?? "there";
    let text: string;
    if (attendanceOn) {
      // Org tracks attendance in-app → the magic link is worth offering,
      // as a trailing option and as this player's sign-in path.
      const token = signMagicLinkToken({
        userId: c.id,
        purpose: "sign-in",
        nextPath: `/matches/${next.id}`,
        ttlSeconds: MAGIC_LINK_TTL.actionNudge,
      });
      text = buildRecruitInviteDm({
        firstName: first,
        matchName: next.activity.name,
        matchWhen,
        spotsLeft: need,
        link: await buildShortMagicLinkUrl(token),
      });
    } else {
      // MoM/ratings-only org (no in-app squad) → an RSVP link does nothing.
      // Players join by posting in the group, so nudge them there.
      text = buildRecruitGroupInviteDm({
        firstName: first,
        matchName: next.activity.name,
        matchWhen,
      });
    }
    const job = await db.botJob.create({
      data: {
        orgId,
        kind: "dm",
        phone: c.phone.replace(/^\+/, ""),
        text,
      },
    });
    await db.sentNotification.create({
      data: { key, kind: "recruit-dm", matchId: next.id, targetUser: c.id },
    });
    // LINK ROW — how a 👍/👎 on this very DM finds its way back to this
    // player and this match. The reaction event carries only the WhatsApp
    // message id; /ack stamps that onto the `botjob-<id>` claim row, and
    // this row turns that BotJob id into (matchId, userId). Without it we
    // would be guessing from a phone number and a timestamp, and a 👍 on
    // a payment chase would silently sign someone up. See
    // src/lib/recruit-reaction.ts. Best-effort: a failure here loses the
    // reaction shortcut, never the invite itself.
    await db.sentNotification
      .create({
        data: {
          key: recruitDmLinkKey(job.id),
          kind: RECRUIT_DM_LINK_KIND,
          matchId: next.id,
          targetUser: c.id,
        },
      })
      .catch((err) => {
        console.error(
          `[recruit] could not link BotJob ${job.id} to the invite for ${c.id} — ` +
            `a 👍 on that DM will not be mappable. The reply path is unaffected.`,
          err,
        );
      });
    invitedNames.push(c.name ?? "Player");
  }

  return {
    ok: true,
    matchId: next.id,
    matchName: next.activity.name,
    matchWhen,
    need,
    invited: invitedNames.length,
    invitedNames,
    alreadyInvited,
  };
}

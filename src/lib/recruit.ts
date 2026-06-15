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

/** How many recent completed matches to pull attendees from. */
const LOOKBACK_MATCHES = 3;

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

export async function inviteRecentPlayers(orgId: string): Promise<RecruitResult> {
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
    take: LOOKBACK_MATCHES,
    select: {
      attendances: {
        where: { status: "CONFIRMED" },
        select: { userId: true, user: { select: { id: true, name: true, phoneNumber: true } } },
      },
    },
  });

  const candidates = new Map<string, { id: string; name: string | null; phone: string }>();
  for (const m of recent) {
    for (const a of m.attendances) {
      if (responded.has(a.userId)) continue; // already responded to next match
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
      // Org tracks attendance in-app → an RSVP link works.
      const token = signMagicLinkToken({
        userId: c.id,
        purpose: "sign-in",
        nextPath: `/matches/${next.id}`,
        ttlSeconds: MAGIC_LINK_TTL.actionNudge,
      });
      const shortLine = need > 0 ? ` — ${need} ${need === 1 ? "spot" : "spots"} left` : "";
      text =
        `👋 ${first} — we're putting the squad together for *${next.activity.name}* on ${matchWhen}${shortLine}. ` +
        `Fancy it?\n\nTap to grab a spot:\n${await buildShortMagicLinkUrl(token)}`;
    } else {
      // MoM/ratings-only org (no in-app squad) → an RSVP link does nothing.
      // Players join by posting in the group, so nudge them there.
      text =
        `👋 ${first} — we're putting the squad together for *${next.activity.name}* on ${matchWhen}. ` +
        `Fancy it? Just reply *IN* in the group and you're sorted 🙌`;
    }
    await db.botJob.create({
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

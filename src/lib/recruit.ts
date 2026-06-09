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

/** Does this message read like "DM recent players to join the next
 *  match"? Used by both the in-group fast-path and the admin DM handler.
 *  Needs all three senses: a send verb + a recruiting intent + a
 *  people/recency noun — so it won't fire on ordinary chat. */
export function looksLikeRecruitRequest(text: string): boolean {
  return (
    /\b(dm|message|text|invite|nudge|ask|send|get)\b/i.test(text) &&
    /\b(join|fill|play|come|spot|short|next match|squad)\b/i.test(text) &&
    /\b(recent|player|people|those|attend|lads|team|guys|everyone|others)\b/i.test(text)
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
  const need = attendanceOn ? Math.max(0, next.maxPlayers - confirmedCount) : 0;

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

  const matchWhen = formatLondon(next.date, "EEE d MMM, HH:mm");
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
  for (const c of candidates.values()) {
    const key = `${next.id}:recruit-dm:${c.id}`;
    const exists = await db.sentNotification.findUnique({ where: { key }, select: { id: true } });
    if (exists) continue; // already invited for this match
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
  };
}

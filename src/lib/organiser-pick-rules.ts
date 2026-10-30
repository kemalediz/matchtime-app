/**
 * ORGANISER PICK, THE PURE HALF (slice 2b, 2026-10-01).
 * Plan: MDs/friday-group-features-plan-2026-09-30.md, sections 2.7 to 2.11.
 *
 * In an organiser-pick club MatchTime never fills an open place by itself.
 * When a place is free and someone is waiting, the admin channel gets one
 * pick message (P1) with the numbered waiting list, and the first admin to
 * reply with a number, a name or an @tag brings that player in. This file
 * holds every decision that needs no database:
 *
 *   decidePickRound     open a round, supersede the open one, or wait;
 *   pickFallbackAt      when nobody has picked in time (D5);
 *   buildPickMessage    P1 and P5, in the club's language.
 *
 * NO MODEL HERE, AND NO READING OF WORDS. What an admin's reply means
 * ("2 3", "all", "none", a name, an @tag, YES) is read by the pick reader,
 * a model (`organiser-pick-reader.ts`, 2026-10-30: Kemal, "I don't want
 * any string parsing at all"); `organiser-pick-no-parsing.source.test.ts`
 * pins that nothing here reads text again.
 */
import { t } from "./i18n/t";
import { inMessageHours, type QuietHours } from "./message-hours";
import { standingPhrase, type StandingBand } from "./partner-guest-standing-rules";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/** At most one pick message per channel per hour per match: an open round
 *  that has gone stale is superseded only once its message is this old. */
export const PICK_SUPERSEDE_AFTER_MS = 60 * MINUTE_MS;
/** A reply older than this on arrival is not executed (same rule and value
 *  as `LATE_MESSAGE_AFTER_MS` in `late-message.ts`; a unit test pins the
 *  two together, and this module may not import that one: it pulls in the
 *  pipeline). */
export const PICK_LATE_REPLY_MS = 30 * MINUTE_MS;
/** How long an E1 "bring them in anyway? YES" question stays answerable. */
export const PICK_CONFIRM_TTL_MS = 30 * MINUTE_MS;
/** A reply that races a pick that has just filled the place still gets E3
 *  "Already filled" for this long after the round closed. */
export const PICK_RACE_WINDOW_MS = 30 * MINUTE_MS;

// ── When a round opens ──────────────────────────────────────────────────

/** Pick messages speak outside the club's quiet hours (by default London
 *  09:00 to 22:59), like every admin notice. */
export function isPickHour(now: Date, quiet?: QuietHours | null): boolean {
  return inMessageHours(now, quiet ?? undefined);
}

/**
 * D5: `min(opened + 24h, kickoff - 4h)`, never sooner than 1 hour after the
 * round opened. A superseding round keeps the earlier round's fallback
 * (`carried`), floored the same way.
 */
export function pickFallbackAt(openedAt: Date, kickoff: Date, carried?: Date | null): Date {
  const floor = openedAt.getTime() + HOUR_MS;
  const base = carried
    ? carried.getTime()
    : Math.min(openedAt.getTime() + 24 * HOUR_MS, kickoff.getTime() - 4 * HOUR_MS);
  return new Date(Math.max(base, floor));
}

export interface RoundSnapshot {
  createdAt: Date;
  listUserIds: string[];
  openPlaces: number;
  outcome?: string | null;
}

export type RoundDecision =
  | { action: "wait"; why: string }
  | { action: "open" }
  /** A new message replaces the open round's: a player dropped since it
   *  went out ("drop"), or somebody new is on the bench ("bench"). */
  | { action: "supersede"; news: "drop" | "bench" }
  /** The open round still answers as sent (the admins changed the count
   *  themselves): record the count on it, post nothing. */
  | { action: "refresh" };

/** Is anyone on the bench now who was not on the list as sent? */
const benchGained = (sent: readonly string[], now: readonly string[]) => {
  const was = new Set(sent);
  return now.some((id) => !was.has(id));
};

/**
 * How many offers the fallback opens: one per free place, but never more
 * than there are people waiting. A new club's first week can have sixteen
 * places free and two people on the list: the two can take a place each,
 * and an offer nobody is there to take would only keep the match in
 * "an offer is running" for no reason (2026-10-06).
 */
export function fallbackOfferCount(openPlaces: number, waiting: number): number {
  return Math.max(0, Math.min(openPlaces, waiting));
}

/**
 * P11: what the admins are told when the fallback offers places to the
 * waiting list. One place offered and none left over: the sentence it has
 * always been. Otherwise it says how many places were offered and, when
 * fewer people are waiting than places are open, how many are still open.
 */
export function buildPickFallbackOffered(p: {
  lang: string | null | undefined;
  activityName: string;
  /** Offers opened (`fallbackOfferCount`). */
  offered: number;
  /** Free places before the offers were opened. */
  openPlaces: number;
}): string {
  const s = t(p.lang);
  const stillOpen = Math.max(0, p.openPlaces - p.offered);
  if (p.offered <= 1 && stillOpen === 0) return s.pick_fallback_offered({ activityName: p.activityName });
  return s.pick_fallback_offered_many({ activityName: p.activityName, offered: p.offered, stillOpen });
}

/**
 * Should a pick round open for this match now (plan 2.7)? All of:
 * a free place, somebody waiting, the squad set (below), the club's
 * drop-out deadline passed (or none set), outside the club's quiet hours, and no
 * fallback offer running.
 *
 * THE SQUAD IS SET (2026-10-15, club rehearsal): at least one player is
 * confirmed, and no pasted list for this match is waiting for an admin's
 * YES. A pick round fills a gap in a squad the organisers have made. With
 * nobody confirmed there is no squad yet (a new club's first week: every
 * IN goes on the bench and the organisers paste the list), and a pasted
 * list waiting for YES is about to rewrite the squad, so a pick asked now
 * would answer a list that is about to change. "18 places open, bench: 1"
 * was noise.
 *
 * ONE MESSAGE PER OPENING (2026-10-15). `dropsSince` counts only news:
 * players who dropped since the open round (or the last closed one) went
 * out, never a change the admins made themselves in the admin group. With
 * an open round:
 *   - a player dropped since, or somebody new is on the bench: a new
 *     message replaces it, at most one an hour ("supersede");
 *   - only the count changed (the admins filled a place, or took a player
 *     out, themselves; or a listed player was brought in): the round as
 *     sent still answers, so it records the count and nothing is posted
 *     ("refresh");
 *   - nothing changed: wait.
 *
 * After a round has CLOSED (NONE from an admin, a fallback), a new one
 * opens only on news: a player's drop, or somebody new on the bench. A
 * round that closed "filled" always counts as changed, because a free
 * place after it means somebody left.
 */
export function decidePickRound(p: {
  now: Date;
  kickoff: Date;
  openPlaces: number;
  waitingUserIds: string[];
  /** CONFIRMED players now. */
  confirmed: number;
  /** A pasted squad list for this match is waiting for an admin's YES. */
  pastePending: boolean;
  dropOutDeadline: Date | null;
  openOffers: number;
  openRound: RoundSnapshot | null;
  lastClosedRound: RoundSnapshot | null;
  /** Players' CONFIRMED to DROPPED moves since the open round (or the last
   *  closed one) went out, leaving out those made in the admin group. */
  dropsSince: number;
  /** The club's quiet hours (absent: the default). */
  quiet?: QuietHours | null;
}): RoundDecision {
  if (p.now.getTime() >= p.kickoff.getTime()) return { action: "wait", why: "kicked off" };
  if (p.openPlaces <= 0) return { action: "wait", why: "no free place" };
  if (p.waitingUserIds.length === 0) return { action: "wait", why: "nobody waiting" };
  if (p.confirmed <= 0) return { action: "wait", why: "no squad yet" };
  if (p.pastePending) return { action: "wait", why: "a pasted list is waiting for YES" };
  if (p.dropOutDeadline && p.now.getTime() < p.dropOutDeadline.getTime()) return { action: "wait", why: "before the drop-out deadline" };
  if (!isPickHour(p.now, p.quiet)) return { action: "wait", why: "quiet hours" };
  if (p.openOffers > 0) return { action: "wait", why: "the fallback offer is running" };

  if (p.openRound) {
    const news = p.dropsSince > 0 ? "drop" : benchGained(p.openRound.listUserIds, p.waitingUserIds) ? "bench" : null;
    if (news) {
      if (p.now.getTime() - p.openRound.createdAt.getTime() < PICK_SUPERSEDE_AFTER_MS) {
        return { action: "wait", why: "at most one pick message an hour" };
      }
      return { action: "supersede", news };
    }
    if (p.openRound.openPlaces !== p.openPlaces) return { action: "refresh" };
    return { action: "wait", why: "the open round is current" };
  }
  const last = p.lastClosedRound;
  if (
    last &&
    last.outcome !== "filled" &&
    last.outcome !== "superseded" &&
    last.outcome !== "closed-at-kickoff" &&
    p.dropsSince === 0 &&
    !benchGained(last.listUserIds, p.waitingUserIds)
  ) {
    return { action: "wait", why: `nothing new since the last round closed (${last.outcome})` };
  }
  return { action: "open" };
}

// ── Who a reply can name ────────────────────────────────────────────────

/** A person a reply to a pick round can name. What the reply MEANS is read
 *  by the pick reader, a model (`organiser-pick-reader.ts`, 2026-10-30). */
export interface PickCandidate {
  userId: string;
  name: string;
}

// ── The pick message ────────────────────────────────────────────────────

export interface PickListRow {
  name: string;
  /** e.g. "GK", "GK/DEF"; null when none is set for this activity. */
  position: string | null;
  /** The club rating players see, e.g. 7.4; null for "new". */
  rating: number | null;
  /** A guest from a partner club (cross-club ask, slice S3): that club's
   *  name, shown beside his ("Ali K (Sutton FC)"). Never his phone.
   *  `rating` above is THIS club's; his standing at his own club is
   *  `fromStanding` (D7 changed by Kemal, 2026-10-22, option C). */
  fromClub?: string | null;
  /** His standing at HIS club (2026-10-22, option C): the band there, and
   *  his number there only when his club shares ratings. Shown beside his
   *  club: "Ali K (Sutton FC, top third there)". */
  fromStanding?: { band: StandingBand; rating: number | null } | null;
  /** A guest from the local player pool (L5a): no home club, so he is shown
   *  as "Ali K (MatchTime player pool)" in the club's language. */
  fromPool?: boolean;
}

/** "GK/DEF" from a player's positions for the activity, or null. */
export function positionLabel(positions: readonly string[] | null | undefined): string | null {
  const p = (positions ?? []).filter((x) => typeof x === "string" && x.trim()).slice(0, 2);
  return p.length > 0 ? p.join("/") : null;
}

export function buildPickListBlock(lang: string | null | undefined, rows: PickListRow[]): string {
  const s = t(lang);
  return [
    s.pick_waiting_header,
    ...rows.map((r, i) =>
      s.pick_list_row({
        n: i + 1,
        name: r.fromClub
          ? `${r.name} (${r.fromStanding ? standingPhrase(lang, { club: r.fromClub, ...r.fromStanding }) : r.fromClub})`
          : r.fromPool
            ? `${r.name} (${s.gst_source_pool})`
            : r.name,
        position: r.position,
        rating: r.rating === null ? null : r.rating.toFixed(1),
      }),
    ),
  ].join("\n");
}

/** "bench-update" (2026-10-15): a round that replaces an open one only
 *  because somebody new is on the bench. It names no drop again and does
 *  not repeat the fallback line (the time carries over unchanged). */
export type PickReason = "drop" | "open-place" | "deadline-summary" | "bench-update";

/** P1: the pick message, for a DM or the admin group. */
export function buildPickMessage(p: {
  lang: string | null | undefined;
  reason: PickReason;
  droppedNames: string[];
  /** Every one of the drops was after the drop-out deadline. */
  late: boolean;
  activityName: string;
  whenLabel: string;
  open: number;
  confirmed: number;
  maxPlayers: number;
  rows: PickListRow[];
  audience: "dm" | "group";
  fallback: "bench-offer" | "leave-empty";
  fallbackWhen: string;
  /** The drop-out deadline as a label, for the "deadline-summary" lead:
   *  it names the deadline and the kick-off each for what it is. */
  deadlineLabel: string;
}): string {
  const s = t(p.lang);
  const places = s.pick_places_line({ open: p.open, confirmed: p.confirmed, maxPlayers: p.maxPlayers });
  const instructions = p.audience === "group" ? s.pick_instructions_group : s.pick_instructions_dm;
  if (p.reason === "bench-update") {
    return [
      `${s.pick_lead_bench_update({ activityName: p.activityName, whenLabel: p.whenLabel })} ${places}`,
      "",
      buildPickListBlock(p.lang, p.rows),
      "",
      instructions,
    ].join("\n");
  }
  const lead =
    p.reason === "deadline-summary"
      ? `${s.pick_lead_deadline({ activityName: p.activityName, whenLabel: p.whenLabel, deadlineLabel: p.deadlineLabel })} ${places}`
      : p.reason === "drop" && p.droppedNames.length > 0
        ? `${s.pick_lead_drop({ names: p.droppedNames, activityName: p.activityName, whenLabel: p.whenLabel, late: p.late })} ${places}`
        : s.pick_lead_open_place({
            open: p.open,
            activityName: p.activityName,
            whenLabel: p.whenLabel,
            confirmed: p.confirmed,
            maxPlayers: p.maxPlayers,
          });
  return [
    lead,
    "",
    buildPickListBlock(p.lang, p.rows),
    "",
    instructions,
    p.fallback === "leave-empty" ? s.pick_fallback_leave({ when: p.fallbackWhen }) : s.pick_fallback_offer({ when: p.fallbackWhen }),
  ].join("\n");
}

/** P5: the list has changed since the message the admin answered. */
export function buildPickListChanged(p: {
  lang: string | null | undefined;
  rows: PickListRow[];
  audience: "dm" | "group";
}): string {
  const s = t(p.lang);
  return [
    s.pick_list_changed,
    "",
    buildPickListBlock(p.lang, p.rows),
    "",
    p.audience === "group" ? s.pick_instructions_group : s.pick_instructions_dm,
  ].join("\n");
}

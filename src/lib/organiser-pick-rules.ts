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
 *   parsePickReply      what an admin's reply means, deterministically;
 *   buildPickMessage    P1 and P5, in the club's language.
 *
 * NO MODEL, EVER. The reply parser is code: a whole-message number, name,
 * @tag, ALL, NONE, or YES to a pending question. This module imports only
 * the string table and the name folding, and the admin-group route that
 * reaches it is pinned model-free by `admin-group-model-door.source.test.ts`.
 */
import { t } from "./i18n/t";
import { inMessageHours, type QuietHours } from "./message-hours";
import { normaliseName } from "./name-normalise";
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
/** A range like "1-3" never expands beyond this many picks. */
const MAX_RANGE = 10;

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

// ── Reading a reply ──────────────────────────────────────────────────────

export interface PickCandidate {
  userId: string;
  name: string;
}

export interface PickReplyContext {
  /** The round's numbered list, as sent. */
  list: PickCandidate[];
  /** The match's CONFIRMED players (answer E2). */
  confirmed: PickCandidate[];
  /** The club's other active members (answer E1). */
  members: PickCandidate[];
  /** An E1 question is waiting for YES on this round. */
  pendingConfirm: boolean;
  /**
   * The real WhatsApp @tags in the message: the digits of the `@<digits>`
   * token the Pi left in the text, and who the server resolved it to
   * (null: nobody it can vouch for).
   */
  tags: Array<{ digits: string; userId: string | null }>;
}

export type PickReply =
  /** 1-based positions in the round's list. */
  | { kind: "numbers"; numbers: number[] }
  | { kind: "people"; userIds: string[] }
  | { kind: "all" }
  | { kind: "none" }
  | { kind: "yes" }
  /** E4: a real @tag MatchTime cannot identify. */
  | { kind: "unresolved-tag" }
  /** E5: a first name that fits several candidates. */
  | { kind: "ambiguous"; first: string; names: string[] }
  /** P6 (a DM only): shaped like a pick, but it does not resolve. */
  | { kind: "not-understood" }
  /** Chat, or anything else: not ours. */
  | { kind: "not-a-pick" };

/** Turkish-aware name folding: `normaliseName`, and dotless ı as i. */
export function foldPickText(s: string): string {
  return normaliseName(s).replace(/ı/g, "i");
}

const NONE_WORDS = new Set(["none", "nobody", "no one", "noone", "leave it", "hicbiri", "kimse"]);
const ALL_WORDS = new Set(["all", "hepsi"]);
const YES_WORDS = new Set(["yes", "evet"]);
const BOT_MENTION = /@\s*match\s*time\b/gi;
const TAG_TOKEN = /@(\d{5,})\b/g;
const TAG_MARK = (i: number) => `\u0001${i}\u0001`;
const TAG_MARK_RE = /^\u0001(\d+)\u0001$/;
const NUMBERS_SHAPE = /^\d+(\s*-\s*\d+)?(\s*(,|&|\band\b|\bve\b|\s)\s*\d+(\s*-\s*\d+)?)*$/;

function expandNumbers(folded: string): number[] | null {
  const out: number[] = [];
  for (const piece of folded.split(/\s*(?:,|&|\band\b|\bve\b|\s)\s*/).filter(Boolean)) {
    const range = /^(\d+)-(\d+)$/.exec(piece.replace(/\s+/g, ""));
    if (range) {
      const a = Number(range[1]);
      const b = Number(range[2]);
      if (b < a || b - a + 1 > MAX_RANGE) return null;
      for (let n = a; n <= b; n++) out.push(n);
    } else {
      out.push(Number(piece));
    }
  }
  return [...new Set(out)];
}

type NameHit = { kind: "hit"; userId: string } | { kind: "ambiguous"; names: string[] } | { kind: "miss" };

function resolveName(part: string, ctx: PickReplyContext): NameHit {
  for (const tier of [ctx.list, ctx.confirmed, ctx.members]) {
    const full = tier.filter((c) => foldPickText(c.name) === part);
    if (full.length === 1) return { kind: "hit", userId: full[0].userId };
    if (full.length > 1) return { kind: "ambiguous", names: full.map((c) => c.name) };
    if (!part.includes(" ")) {
      const first = tier.filter((c) => foldPickText(c.name).split(" ")[0] === part);
      if (first.length === 1) return { kind: "hit", userId: first[0].userId };
      if (first.length > 1) return { kind: "ambiguous", names: first.map((c) => c.name) };
    }
  }
  return { kind: "miss" };
}

/**
 * What an admin's reply to a pick message means. Deterministic, no model.
 *
 * Only a WHOLE-MESSAGE pick is read: after the bot mention and the edge
 * punctuation are stripped, the message must be numbers ("2", "2 3",
 * "2, 3", "2 and 3", "1-3"), names that all resolve ("Wasim", "Ali Khan,
 * Sam"), @tags, ALL, NONE, or YES while a question is pending. "Wasim
 * played well last week" is chat: `not-a-pick`.
 *
 * Numbers are checked against the list's length only; resolving them
 * against the round's stored list is the caller's job. A leading "@"
 * typed by hand ("@Wasim") reads as the name. A real @tag arrives as an
 * "@<digits>" token and is looked up in `ctx.tags`.
 *
 * In a DM, a message that does not resolve but LOOKS like a pick (it
 * holds a digit, or a word equal to a listed first name) is
 * `not-understood` (P6); anything else falls through to the DM's other
 * handlers. The admin group never gets P6: its admins talk to each other.
 */
export function parsePickReply(text: string, ctx: PickReplyContext, door: "dm" | "group"): PickReply {
  const tagIndex = new Map(ctx.tags.map((tg, i) => [tg.digits, i]));
  const extraTags: Array<{ digits: string; userId: null }> = [];
  let body = (typeof text === "string" ? text : "").replace(BOT_MENTION, " ");
  body = body.replace(TAG_TOKEN, (_m, digits: string) => {
    let i = tagIndex.get(digits);
    if (i === undefined) {
      i = ctx.tags.length + extraTags.length;
      extraTags.push({ digits, userId: null });
      tagIndex.set(digits, i);
    }
    return ` ${TAG_MARK(i)} `;
  });
  const allTags = [...ctx.tags, ...extraTags];
  const clean = body
    .replace(/^[\s.,!?;:]+|[\s.,!?;:]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return { kind: "not-a-pick" };
  const folded = foldPickText(clean);

  if (NONE_WORDS.has(folded)) return { kind: "none" };
  if (ALL_WORDS.has(folded)) return { kind: "all" };
  if (YES_WORDS.has(folded)) return ctx.pendingConfirm ? { kind: "yes" } : { kind: "not-a-pick" };

  if (NUMBERS_SHAPE.test(folded)) {
    const numbers = expandNumbers(folded);
    if (!numbers || numbers.some((n) => n < 1 || n > ctx.list.length)) {
      return door === "dm" ? { kind: "not-understood" } : { kind: "not-a-pick" };
    }
    return { kind: "numbers", numbers };
  }

  // Names and tags, separated by commas, "and", "ve", "&" (and tags also
  // by spaces).
  const parts: string[] = [];
  for (const raw of folded.split(/\s*(?:,|&|\band\b|\bve\b)\s*/).filter(Boolean)) {
    const pieces = raw.split(" ");
    if (pieces.every((p) => TAG_MARK_RE.test(p))) parts.push(...pieces);
    else parts.push(raw.replace(/^@+/, "").trim());
  }

  const userIds: string[] = [];
  let unresolvedTag = false;
  let ambiguous: { first: string; names: string[] } | null = null;
  let miss = false;
  for (const part of parts) {
    const mark = TAG_MARK_RE.exec(part);
    if (mark) {
      const tag = allTags[Number(mark[1])];
      if (tag?.userId) userIds.push(tag.userId);
      else unresolvedTag = true;
      continue;
    }
    if (!part || part.includes("\u0001")) {
      miss = true;
      continue;
    }
    const hit = resolveName(part, ctx);
    if (hit.kind === "hit") userIds.push(hit.userId);
    else if (hit.kind === "ambiguous") ambiguous = ambiguous ?? { first: displayFirst(clean, part), names: hit.names };
    else miss = true;
  }

  if (miss) {
    if (door === "group") return { kind: "not-a-pick" };
    return looksLikeAPick(folded, ctx) ? { kind: "not-understood" } : { kind: "not-a-pick" };
  }
  if (unresolvedTag) return { kind: "unresolved-tag" };
  if (ambiguous) return { kind: "ambiguous", ...ambiguous };
  return { kind: "people", userIds: [...new Set(userIds)] };
}

/** The part as the admin typed it, for E5 ("Two players are called *Ali*"). */
function displayFirst(clean: string, foldedPart: string): string {
  const word = clean
    .split(/\s*(?:,|&|\band\b|\bve\b)\s*/i)
    .map((w) => w.replace(/^@+/, "").trim())
    .find((w) => foldPickText(w) === foldedPart);
  return word ?? foldedPart;
}

/** P6's test in a DM: a digit, or a word equal to a listed first name. */
function looksLikeAPick(folded: string, ctx: PickReplyContext): boolean {
  if (/\d/.test(folded.replace(/\u0001\d+\u0001/g, ""))) return true;
  const firsts = new Set(ctx.list.map((c) => foldPickText(c.name).split(" ")[0]).filter(Boolean));
  return folded.split(/[\s,&]+/).some((w) => firsts.has(w.replace(/^@+/, "")));
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

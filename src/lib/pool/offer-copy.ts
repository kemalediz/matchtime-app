/**
 * THE POOL'S MESSAGES, COMPOSED (slice L5a, 2026-10-24). PURE: facts in,
 * text out. The words are `src/lib/i18n/pool-offer.{en,tr}.ts`; the facts
 * come from `offer-facts.ts` (the loader). Every message to a pool player
 * ends with his stop/manage link.
 *
 * Approved spec, "Offer": club, venue with address and map link, distance,
 * day/date/kickoff/length, sport and format, casual/competitive/mixed
 * (omitted when unset), club size and how often it plays (counts only),
 * fee ("free" when none), places needed. Never a group name, an
 * organiser's or member's name, or a phone number: `PoolOfferFacts` has no
 * field that could carry one.
 *
 * Since L6 reads replies in words (`reply.ts`), the offer says "Reply
 * here, or tap" (decision L5a.4 said to rewrite the line then).
 */
import { longDayTimeLabel } from "../i18n/dates";
import type { Lang } from "../i18n/lang";
import { poolCopy } from "../i18n/pool-offer";
import { t } from "../i18n/t";
import { joinList } from "../i18n/text";
import type { CandidateExclusion } from "./matching-rules";
import { sportLabel, type PoolSportKey } from "./sports";
import type { OfferPageState } from "./accept-rules";
import type { TurnUpRecord } from "./turn-up";
import type { PlayStyle } from "./vocab";

export type PoolFee = { kind: "free" } | { kind: "amount"; amount: string } | null;

export interface PoolOfferFacts {
  club: string;
  places: number;
  sport: PoolSportKey;
  /** Players per side, where the sport has formats; null otherwise. */
  format: number | null;
  kickoff: Date;
  durationMins: number;
  venueName: string;
  address: string | null;
  mapUrl: string | null;
  distanceMiles: number | null;
  playStyle: PlayStyle | null;
  /** Live ordinary members (guests not counted). */
  members: number;
  /** Games the club played in the last 8 weeks. */
  gamesLast8Weeks: number;
  /** "free" only when the club takes no fee at all; null when unknown. */
  fee: PoolFee;
}

export interface PoolLinks {
  tapLink: string;
  manageLink: string;
}

/** From this many games in 8 weeks the club "plays every week". */
export const WEEKLY_GAMES_IN_8_WEEKS = 7;

export function regularityOf(games: number): { kind: "weekly" } | { kind: "games"; games: number } | null {
  if (!Number.isFinite(games) || games <= 0) return null;
  return games >= WEEKLY_GAMES_IN_8_WEEKS ? { kind: "weekly" } : { kind: "games", games };
}

/** "1.8" / "1,8", at least 0.1, and whether it reads as one mile. */
export function milesLabel(lang: Lang, miles: number): { miles: string; one: boolean } {
  const rounded = Math.max(0.1, Math.round(miles * 10) / 10);
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return { miles: lang === "tr" ? text.replace(".", ",") : text, one: rounded === 1 };
}

function gameOf(lang: Lang, f: Pick<PoolOfferFacts, "sport" | "format">): string {
  const c = poolCopy(lang);
  const sport = sportLabel(f.sport, lang);
  return f.format ? c.game_with_format({ format: t(lang).sj_per_side_option({ perSide: f.format }), sport }) : c.game_plain({ sport });
}

function styleOf(lang: Lang, style: PlayStyle | null): string | null {
  const c = poolCopy(lang);
  if (style === "casual") return c.style_casual;
  if (style === "competitive") return c.style_competitive;
  if (style === "mixed") return c.style_mixed;
  return null;
}

/** "A regular group of 30 players, playing every week" (the offer and My invitations, L8). */
export function clubLineOf(lang: Lang, members: number, games: number): string | null {
  const c = poolCopy(lang);
  if (!(members > 0)) return null;
  const r = regularityOf(games);
  if (!r) return c.club_size({ members });
  return r.kind === "weekly" ? c.club_weekly({ members }) : c.club_games({ members, games: r.games });
}

function feeLineOf(lang: Lang, fee: PoolFee): string | null {
  const c = poolCopy(lang);
  if (!fee) return null;
  return fee.kind === "free" ? c.free : c.fee({ amount: fee.amount });
}

/** The offer's fact lines, as the DM and the offer page both show them. */
export function poolOfferLines(lang: Lang, f: PoolOfferFacts): string[] {
  const c = poolCopy(lang);
  const where = [
    `📍 *${f.venueName}*${f.address ? `, ${f.address}` : ""}`,
    f.distanceMiles != null ? c.distance(milesLabel(lang, f.distanceMiles)) : null,
    f.mapUrl ? c.map({ url: f.mapUrl }) : null,
  ]
    .filter(Boolean)
    .join(". ");
  const about = [styleOf(lang, f.playStyle), clubLineOf(lang, f.members, f.gamesLast8Weeks)].filter(Boolean).join(". ");
  const facts = [
    c.offer_head({ club: f.club, places: f.places, game: gameOf(lang, f) }),
    c.offer_when({ day: longDayTimeLabel(lang, f.kickoff), mins: f.durationMins }),
    where,
    about ? `🤝 ${about}` : null,
    feeLineOf(lang, f.fee),
  ].filter((x): x is string => !!x);
  return facts;
}

export function poolOfferText(lang: Lang, f: PoolOfferFacts, links: PoolLinks): string {
  const c = poolCopy(lang);
  return [poolOfferLines(lang, f).join("\n"), c.offer_cta({ link: links.tapLink }), c.footer({ link: links.manageLink })].join("\n\n");
}

export function poolPlacedText(
  lang: Lang,
  p: { club: string; kickoff: Date; venueName: string; bench: boolean; fee: PoolFee; offerLink: string; manageLink: string },
): string {
  const c = poolCopy(lang);
  const game = { club: p.club, day: longDayTimeLabel(lang, p.kickoff), venue: p.venueName };
  const lines = [
    p.bench ? c.placed_bench(game) : c.placed_in(game),
    p.fee?.kind === "amount" ? c.placed_fee({ amount: p.fee.amount }) : null,
    c.placed_pull_out({ link: p.offerLink }),
  ].filter((x): x is string => !!x);
  return [lines.join("\n"), c.footer({ link: p.manageLink })].join("\n\n");
}

export function poolReplyTapText(lang: Lang, p: PoolLinks): string {
  const c = poolCopy(lang);
  return [c.reply_tap({ link: p.tapLink }), c.footer({ link: p.manageLink })].join("\n\n");
}

export function poolReplyGoneText(lang: Lang, p: { club: string; manageLink: string }): string {
  const c = poolCopy(lang);
  return [c.reply_gone({ club: p.club }), c.footer({ link: p.manageLink })].join("\n\n");
}

// ── Replies in words (slice L6) ──────────────────────────────────────────

const withFooter = (lang: Lang, body: string, manageLink: string) => [body, poolCopy(lang).footer({ link: manageLink })].join("\n\n");

/** A question: the offer's own facts again and the way to answer it. Never
 *  an answer the facts do not hold (plan 5.3: "nothing invented"). */
export function poolReplyFactsText(
  lang: Lang,
  f: PoolOfferFacts,
  p: { state: "open" | "taken"; tapLink: string; manageLink: string },
): string {
  const c = poolCopy(lang);
  const end = p.state === "taken" ? c.placed_pull_out({ link: p.tapLink }) : c.offer_cta({ link: p.tapLink });
  return withFooter(lang, [[c.reply_facts_head, ...poolOfferLines(lang, f)].join("\n"), end].join("\n\n"), p.manageLink);
}

/** The one re-ask when the reader was not sure. */
export function poolReplyReaskText(lang: Lang, p: PoolLinks): string {
  return withFooter(lang, poolCopy(lang).reply_reask({ link: p.tapLink }), p.manageLink);
}

/** Two or more open offers and a plain reply: which one, never a guess. */
export function poolReplyWhichText(lang: Lang, p: { offers: Array<{ club: string; kickoff: Date; tapLink: string }>; manageLink: string }): string {
  const list = p.offers.map((o, i) => `${i + 1}. *${o.club}*, ${longDayTimeLabel(lang, o.kickoff)}: ${o.tapLink}`).join("\n");
  return withFooter(lang, poolCopy(lang).reply_which({ n: p.offers.length, list }), p.manageLink);
}

/** "Stop" in his own words: done (the manage link starts them again). */
export function poolReplyStoppedText(lang: Lang, manageLink: string): string {
  return poolCopy(lang).reply_stopped({ link: manageLink });
}

/** A yes or a question while his offers are paused or stopped. */
export function poolReplyProfileOffText(lang: Lang, manageLink: string): string {
  return poolCopy(lang).reply_profile_off({ link: manageLink });
}

/** What his yes, no or give-back by words came to: the offer page's own
 *  words for that state (one source for both), the manage link last. "in"
 *  and "bench" have none: the match details DM says it. */
export function poolReplyStateText(lang: Lang, state: Exclude<OfferPageState, "in" | "bench">, manageLink: string): string {
  const c = poolCopy(lang);
  const body: Record<Exclude<OfferPageState, "in" | "bench">, string> = {
    declined: c.page_declined,
    gone: c.page_gone,
    expired: c.page_expired,
    off: c.page_off,
    busy: c.page_busy,
    withdrawn: c.page_pulled_out,
    open: c.page_try_again,
    invalid: c.page_expired,
  };
  return withFooter(lang, body[state], manageLink);
}

export function poolPausedText(lang: Lang, p: { n: number; manageLink: string }): string {
  return poolCopy(lang).paused({ n: p.n, link: p.manageLink });
}

/** "Ali Kaya" to "Ali K": what a club sees of a pool guest (plan 6). */
export function shortDisplayName(displayName: string): string {
  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return parts[0] ?? "";
  const last = parts[parts.length - 1];
  return `${parts[0]} ${last.charAt(0).toLocaleUpperCase()}`;
}

/** The organisers' line about his record, from `turn-up.ts`. */
export function turnUpLine(lang: Lang, r: TurnUpRecord): string {
  const c = poolCopy(lang);
  const n = r.played + r.missed;
  if (n === 0) return c.turnup_new;
  return r.missed === 0 ? c.turnup_all({ n }) : c.turnup_some({ played: r.played, n });
}

/** The organisers are told: a name and the turn-up line, never a number. */
export function poolOrganiserNotice(lang: Lang, p: { name: string; day: string; bench: boolean; record: TurnUpRecord }): string {
  const c = poolCopy(lang);
  const args = { name: p.name, day: p.day, turnUp: turnUpLine(lang, p.record) };
  return p.bench ? c.notice_bench(args) : c.notice_in(args);
}

/** What a pool guest's place means, in a notice. */
export type PoolGuestNoticeKind = "in" | "bench" | "out";

/**
 * The players' group post about a pool guest, for a club whose only group
 * is its players' group (Kemal, 2026-10-29): worded for everyone, and
 * WITHOUT the turn-up record, which stays in HQ where only organisers read
 * it (another club's history about a stranger is not for the whole group).
 * On an organiser-pick club's bench it says how an organiser puts him in.
 */
export function poolGuestGroupNotice(lang: Lang, p: { name: string; day: string; kind: PoolGuestNoticeKind; organiserPicks: boolean }): string {
  const c = poolCopy(lang);
  const args = { name: p.name, day: p.day };
  if (p.kind === "out") return c.notice_out(args);
  if (p.kind === "in") return c.group_notice_in(args);
  return p.organiserPicks ? c.group_notice_bench_pick(args) : c.group_notice_bench(args);
}

/** Why the organisers' ask to the pool was refused, in their words. */
export function poolAskRefusalText(lang: Lang | string | null | undefined, refusal: string, placesOpen: number): string {
  const c = poolCopy(lang);
  switch (refusal) {
    case "pool-closed":
      return c.refused_closed;
    case "no-venue":
      return c.refused_no_venue;
    case "too-late":
      return c.refused_too_late;
    case "round-open":
      return c.refused_round_open;
    case "club-week-cap":
      return c.refused_week_cap;
    case "no-places":
      return c.refused_no_places;
    case "bad-number":
      return placesOpen > 0 ? c.refused_bad_number({ max: placesOpen }) : c.refused_no_places;
    case "none-near":
      return c.refused_none_near;
    default:
      return c.refused_generic;
  }
}

/** What a refused ask in words needs to say what to do next (2026-10-28):
 *  the club's name, the game's day, the cut-off, whether the club's own
 *  switch is what is off, and the links to the exact places to fix it. */
export interface PoolRefusalContext {
  club: string;
  day: string;
  cutoffHours: number;
  /** The platform pool is on and only this club's switch is off. */
  clubSwitchOff: boolean;
  links: { weeklyGame: string; poolSwitch: string; partnerSettings: string };
  /** The refused ask is kept and asked again once the venue is set. */
  willRetry?: boolean;
  /** The game's venue name, for "nobody new near <venue>". */
  venue?: string | null;
  /** On "none-near": how many pool players near the venue each rule left out. */
  excluded?: Partial<Record<CandidateExclusion, number>>;
}

/** The reasons an organiser can act on or understand, in the order they
 *  are said. Not active, no consent, no phone and a block are never said:
 *  they are not reachable pool players, and a block is private. */
const NOBODY_REASONS = [
  ["on_match", ["on-match"]],
  ["club", ["club-member"]],
  ["time", ["not-available"]],
  ["far", ["too-far"]],
  ["format", ["sport", "format", "level"]],
  ["busy", ["busy"]],
  ["offered", ["already-offered"]],
  ["caps", ["day-cap", "week-cap", "decline-cooldown"]],
] as const satisfies ReadonlyArray<readonly [string, readonly CandidateExclusion[]]>;

/** "Nobody new to ask", with why, when the counts say; null when no pool
 *  player near the venue was left out for a reason worth saying. */
export function poolNobodyNewText(lang: Lang | string | null | undefined, ctx: Pick<PoolRefusalContext, "club" | "venue" | "excluded">): string | null {
  const c = poolCopy(lang);
  const ex = ctx.excluded ?? {};
  const parts: string[] = [];
  let club = false;
  for (const [key, rules] of NOBODY_REASONS) {
    const n = rules.reduce((sum, r) => sum + (ex[r] ?? 0), 0);
    if (n <= 0) continue;
    if (key === "club") club = true;
    parts.push(key === "club" ? c.why_club({ n, club: ctx.club }) : c[`why_${key}`]({ n }));
  }
  if (parts.length === 0) return null;
  const near = ctx.venue ? c.near_venue({ venue: ctx.venue }) : c.near_pitch;
  return c.ask_refused_nobody_new({ near, reasons: joinList(lang, parts), clubTail: club });
}

/** What the organisers hear after asking the pool in words (HQ or the
 *  players' group), or a YES to the short-squad notice in HQ (L10). A
 *  refusal says what happened, why, and what to do next (its own chat
 *  wording, `ask_refused_*`; the match page keeps `poolAskRefusalText`). */
export function poolHqAskReply(
  lang: Lang | string | null | undefined,
  r:
    | { ok: true; places: number; day: string; withPartners: boolean; inHq?: boolean }
    | { ok: false; refusal: string; placesOpen: number; ctx: PoolRefusalContext },
): string {
  const c = poolCopy(lang);
  if (r.ok) return c.hq_asked({ places: r.places, day: r.day, withPartners: r.withPartners, inHq: r.inHq !== false });
  const { ctx } = r;
  switch (r.refusal) {
    case "pool-closed":
      return ctx.clubSwitchOff ? c.ask_refused_club_off({ link: ctx.links.poolSwitch }) : c.hq_closed;
    case "not-organiser":
      return c.ask_refused_not_organiser;
    case "match-not-open":
      return c.ask_refused_match_not_open({ day: ctx.day });
    case "no-venue":
      return c.ask_refused_no_venue({ club: ctx.club, link: ctx.links.weeklyGame, retry: ctx.willRetry === true });
    case "no-sport":
      return c.ask_refused_no_sport({ link: ctx.links.weeklyGame });
    case "too-late":
      return c.ask_refused_too_late({ hours: ctx.cutoffHours, link: ctx.links.partnerSettings });
    case "no-places":
    case "bad-number":
      return c.ask_refused_no_places;
    case "round-open":
      return c.ask_refused_round_open;
    case "club-week-cap":
      return c.ask_refused_week_cap;
    case "none-near":
      return poolNobodyNewText(lang, ctx) ?? c.ask_refused_none_near;
    default:
      return c.ask_refused_generic;
  }
}

/** The short-squad notice's extra line (`panel.ts` `poolNoticeBand`). */
export function withPoolOffer(
  text: string,
  band: "few" | "5+" | null,
  link: string,
  lang: Lang | string | null,
  /** Posted in the club's admin group (L10): a YES there asks the pool. */
  opts: { inHq?: boolean } = {},
): string {
  if (!band) return text;
  const c = poolCopy(lang);
  const args = { band: band === "5+" ? c.band_many : c.band_few, link };
  return `${text}\n\n${opts.inHq ? c.notice_offer_line_hq(args) : c.notice_offer_line(args)}`;
}

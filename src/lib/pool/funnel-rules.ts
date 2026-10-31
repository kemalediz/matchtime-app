/**
 * THE OWNER'S POOL FUNNEL (growth slice G2, 2026-10-24). PURE.
 *
 * Plan 11.4: by source and by week, how many people signed up and how far
 * they got. Counts only: nothing here carries a name, a number, an area or
 * a person's share code (a referral is counted, its code is never shown).
 * The thin loader is `funnel-loader.ts`; the page is
 * `src/app/admin/pool/funnel` (superadmin only).
 *
 * THE FUNNEL is a COHORT: the pool profiles created in the date range (and
 * matching the town, sport and source filters), followed to where they are
 * now. Each step needs the one before, so every conversion is at most 100%:
 *   signed up       a /play (or profile) sign-up was made. A sign-up never
 *                   confirmed is deleted after 7 days (decision #34) and a
 *                   deleted profile is erased, so neither is counted.
 *   verified        confirmed on WhatsApp (consent recorded).
 *   active          verified, and still in the pool (active or paused), or
 *                   was in it long enough for an offer to reach him. So
 *                   "verified but not active" = stopped before any offer.
 *   offered         at least one pool offer DELIVERED to him (the Pi's
 *                   "sent", decision L5a.22).
 *   accepted        took a guest place from an offer, whatever happened
 *                   next (the Guest players report's "accepted", L5b.3).
 *   played          played one of those games, by the Guest players page's
 *                   own rule (`settleGuestResult`).
 *   became members  a live ordinary member now of a club he played for as a
 *                   pool guest (L5b.3's "became members", platform-wide).
 * Conversion = this step / the step before; null (a dash) when the step
 * before is 0.
 *
 * WEEKS are London weeks from Monday 00:00, by sign-up time; each week's
 * row is that week's sign-ups (by source) and how far they got.
 *
 * SOURCE is first-touch (G1.1): web, profile (a club member from his
 * profile), referral (a friend's link, kept even when the referral itself
 * was not, G1.2), campaign (one of the owner's codes). No source stamped
 * reads as the web.
 *
 * THE EARLY SIGN-UP LIST is its size today: confirmed, not stopped, on the
 * list, whenever they signed up (the town, sport and source filters apply,
 * the dates do not).
 *
 * OFFER HEALTH counts what the dispatcher and the sweep recorded in the
 * date range, platform-wide (the filters on people do not apply):
 *   delivered          offers the Pi reported sent.
 *   caps hit           offers a player's own cap refused at dispatch (a
 *                      day cap, the week cap, or the cool-off after a no),
 *                      by the job's failure time. People a cap left out
 *                      when a wave was chosen are not recorded anywhere and
 *                      are not counted.
 *   quiet-hour holds   offer DMs queued in the range that had to wait for
 *                      the end of quiet hours (`sendAfter` set). The pool's
 *                      night hold was removed 2026-10-29, so this counts
 *                      only offers queued before then.
 *   ignored pauses     profiles paused now for three ignored offers in a
 *                      row, paused in the range. A pause he has since
 *                      lifted leaves no record and is not counted.
 *   platform cap hits  times a delivered offer filled the platform's hour
 *                      or London day (`platformRoom` left 0), so the next
 *                      one waited.
 */
import { formatLondon, londonDateTimeToUtc } from "../london-time";
import { platformRoom, type PlayerCapRefusal } from "./caps";
import { poolOfferCancelFailReason } from "./dispatch-rules";
import { csvCell, settleGuestResult, type AttendanceLike, type GuestMatchFacts } from "./guest-report";
import { POOL_SPORT_KEYS, sportLabel } from "./sports";
import { POOL_PROFILE_SOURCES, isOneOf, type GuestResult, type PoolProfileSource } from "./vocab";

// ── Facts (what the loader hands in) ───────────────────────────────────

/** One guest place he took from a pool offer. */
export interface FunnelPlaceFact {
  orgId: string;
  match: Pick<GuestMatchFacts, "kickoff" | "durationMins" | "status">;
  attendance: AttendanceLike | null;
  recorded: GuestResult | null;
  /** The result is final (slice L7, `GuestPlace.settledAt`). */
  settled?: boolean;
}

/** One pool profile, as the funnel reads it. No name, no number, no area. */
export interface FunnelProfileFact {
  createdAt: Date;
  status: string;
  /** Confirmed on WhatsApp (consent recorded). */
  verified: boolean;
  town: string | null;
  /** His catalogue sport keys. */
  sports: string[];
  source: string | null;
  /** Read only for a campaign sign-up: a referral's is a person's code. */
  sourceCode: string | null;
  earlyList: boolean;
  /** Pool offers delivered to him. */
  offersDelivered: number;
  /** Guest places he took from pool offers. */
  places: FunnelPlaceFact[];
  /** Clubs he is a live ordinary member of now. */
  memberOrgIds: string[];
}

export interface FunnelCampaign {
  code: string;
  label: string;
  source: string;
}

// ── Steps ──────────────────────────────────────────────────────────────

export const FUNNEL_STEPS = ["signedUp", "verified", "active", "offered", "accepted", "played", "becameMembers"] as const;
export type FunnelStep = (typeof FUNNEL_STEPS)[number];
export type FunnelCounts = Record<FunnelStep, number>;

export const FUNNEL_STEP_LABEL: Record<FunnelStep, string> = {
  signedUp: "Signed up",
  verified: "Confirmed on WhatsApp",
  active: "Active",
  offered: "Offered",
  accepted: "Accepted",
  played: "Played",
  becameMembers: "Became members",
};

const IN_POOL = new Set(["active", "paused"]);

/** How many steps of `FUNNEL_STEPS` he reached, in order (1 to 7). */
export function funnelStepsReached(p: FunnelProfileFact, now: Date): number {
  const played = p.places.filter((pl) => settleGuestResult(pl, now) === "played");
  const steps = [
    true,
    p.verified,
    IN_POOL.has(p.status) || p.offersDelivered > 0,
    p.offersDelivered > 0,
    p.places.length > 0,
    played.length > 0,
    played.some((pl) => p.memberOrgIds.includes(pl.orgId)),
  ];
  const firstMissed = steps.indexOf(false);
  return firstMissed === -1 ? steps.length : firstMissed;
}

const zero = (): FunnelCounts => ({ signedUp: 0, verified: 0, active: 0, offered: 0, accepted: 0, played: 0, becameMembers: 0 });

function countSteps(profiles: readonly FunnelProfileFact[], now: Date): FunnelCounts {
  const c = zero();
  for (const p of profiles) for (const step of FUNNEL_STEPS.slice(0, funnelStepsReached(p, now))) c[step]++;
  return c;
}

const ratio = (n: number, d: number): number | null => (d > 0 ? n / d : null);

export function conversionOf(c: FunnelCounts): Record<FunnelStep, number | null> {
  return Object.fromEntries(FUNNEL_STEPS.map((s, i) => [s, i === 0 ? null : ratio(c[s], c[FUNNEL_STEPS[i - 1]])])) as Record<FunnelStep, number | null>;
}

/** "75%", or null for none. */
export function percent(rate: number | null): string | null {
  return rate === null ? null : `${Math.round(rate * 100)}%`;
}

// ── Sources ────────────────────────────────────────────────────────────

export const SOURCE_LABEL: Record<PoolProfileSource, string> = {
  web: "Web",
  profile: "From a club profile",
  referral: "Referral",
  campaign: "Campaign",
  friend: "A member's friend link",
};

export const sourceOf = (p: Pick<FunnelProfileFact, "source">): PoolProfileSource => (isOneOf(POOL_PROFILE_SOURCES, p.source) ? p.source : "web");

const campaignCodeOf = (p: FunnelProfileFact): string | null => (sourceOf(p) === "campaign" ? p.sourceCode : null);

// ── Dates and weeks ────────────────────────────────────────────────────

const DAY_MS = 24 * 3600_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const FUNNEL_DEFAULT_WEEKS = 12;
/** About two years: the longest range the page reads. */
export const FUNNEL_MAX_DAYS = 730;

/** A "yyyy-MM-dd" moved by whole days (calendar arithmetic, no zone). */
function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function isRealDate(s: string): boolean {
  return DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);
}

/** The Monday of a London date ("yyyy-MM-dd"). */
function mondayOf(date: string): string {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 Sunday
  return addDays(date, -((dow + 6) % 7));
}

/** The London week (from Monday 00:00) an instant falls in. */
export function londonWeekStart(d: Date): { key: string; start: Date } {
  const key = mondayOf(formatLondon(d, "yyyy-MM-dd"));
  return { key, start: londonDateTimeToUtc(key, "00:00") };
}

/** Every London week touching `from`..`to` (London dates), newest first. */
export function weekStarts(from: string, to: string): { key: string; start: Date }[] {
  const out: { key: string; start: Date }[] = [];
  for (let k = mondayOf(to); k >= mondayOf(from); k = addDays(k, -7)) out.push({ key: k, start: londonDateTimeToUtc(k, "00:00") });
  return out;
}

/** The instants a London date range covers: [from 00:00, the day after `to` 00:00). */
export function rangeInstants(q: { from: string; to: string }): { start: Date; end: Date } {
  return { start: londonDateTimeToUtc(q.from, "00:00"), end: londonDateTimeToUtc(addDays(q.to, 1), "00:00") };
}

const within = (d: Date | null, r: { start: Date; end: Date }) => d !== null && d.getTime() >= r.start.getTime() && d.getTime() < r.end.getTime();

// ── The query ──────────────────────────────────────────────────────────

/** `town`: a town slug, "_first" for the first town (NULL), null for all.
 *  `source`: a source, "campaign:<code>", or null for all. */
export interface FunnelQuery {
  from: string;
  to: string;
  town: string | null;
  sport: string | null;
  source: string | null;
}

export const FIRST_TOWN = "_first";
const TOWN_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CAMPAIGN_RE = /^campaign:[a-z0-9]+(?:-[a-z0-9]+)*$/;

type Query = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined): string => (Array.isArray(v) ? (v[0] ?? "") : (v ?? "")).trim();

export function parseFunnelQuery(q: Query, now: Date): FunnelQuery {
  const today = formatLondon(now, "yyyy-MM-dd");
  const defaultFrom = addDays(mondayOf(today), -7 * (FUNNEL_DEFAULT_WEEKS - 1));
  let from = isRealDate(first(q.from)) ? first(q.from) : defaultFrom;
  let to = isRealDate(first(q.to)) ? first(q.to) : today;
  if (from > to) [from, to] = [to, from];
  const earliest = addDays(to, -FUNNEL_MAX_DAYS);
  if (from < earliest) from = earliest;
  const town = first(q.town);
  const sport = first(q.sport);
  const source = first(q.source);
  return {
    from,
    to,
    town: town === FIRST_TOWN || TOWN_RE.test(town) ? town : null,
    sport: (POOL_SPORT_KEYS as readonly string[]).includes(sport) ? sport : null,
    source: isOneOf(POOL_PROFILE_SOURCES, source) || CAMPAIGN_RE.test(source) ? source : null,
  };
}

/** The filters on people (not the dates). */
function matchesPeople(p: FunnelProfileFact, q: FunnelQuery): boolean {
  if (q.town && (q.town === FIRST_TOWN ? p.town !== null : p.town !== q.town)) return false;
  if (q.sport && !p.sports.includes(q.sport)) return false;
  if (q.source) {
    if (q.source.startsWith("campaign:")) return campaignCodeOf(p) === q.source.slice("campaign:".length);
    if (sourceOf(p) !== q.source) return false;
  }
  return true;
}

// ── The report ─────────────────────────────────────────────────────────

export interface FunnelWeek {
  key: string;
  start: Date;
  bySource: Record<PoolProfileSource, number>;
  counts: FunnelCounts;
}

export interface FunnelReport {
  total: FunnelCounts;
  conversion: Record<FunnelStep, number | null>;
  /** Became members / signed up. */
  overall: number | null;
  /** Nobody signed up in the range (with these filters). */
  empty: boolean;
  weeks: FunnelWeek[];
  bySource: { source: PoolProfileSource; counts: FunnelCounts }[];
  /** Campaign codes that brought sign-ups in the range; `label` null for a
   *  code no longer in the table. */
  byCampaign: { code: string; label: string | null; counts: FunnelCounts }[];
  earlyList: number;
  options: { towns: string[]; sports: string[]; sources: string[] };
}

export function buildFunnelReport(
  input: { profiles: readonly FunnelProfileFact[]; campaigns: readonly FunnelCampaign[]; now: Date },
  q: FunnelQuery,
): FunnelReport {
  const { now } = input;
  const range = rangeInstants(q);
  const people = input.profiles.filter((p) => matchesPeople(p, q));
  const cohort = people.filter((p) => within(p.createdAt, range));
  const total = countSteps(cohort, now);

  const weeks: FunnelWeek[] = weekStarts(q.from, q.to).map((w) => {
    const mine = cohort.filter((p) => londonWeekStart(p.createdAt).key === w.key);
    const bySource = Object.fromEntries(POOL_PROFILE_SOURCES.map((s) => [s, mine.filter((p) => sourceOf(p) === s).length])) as Record<PoolProfileSource, number>;
    return { ...w, bySource, counts: countSteps(mine, now) };
  });

  const labels = new Map(input.campaigns.map((c) => [c.code, c.label]));
  const codes = [...new Set(cohort.map(campaignCodeOf).filter((c): c is string => !!c))];
  const byCampaign = codes
    .map((code) => ({ code, label: labels.get(code) ?? null, counts: countSteps(cohort.filter((p) => campaignCodeOf(p) === code), now) }))
    .sort((a, b) => b.counts.signedUp - a.counts.signedUp || a.code.localeCompare(b.code));

  const towns = [...new Set(input.profiles.map((p) => p.town ?? FIRST_TOWN))].sort((a, b) => (a === FIRST_TOWN ? -1 : b === FIRST_TOWN ? 1 : a.localeCompare(b)));

  return {
    total,
    conversion: conversionOf(total),
    overall: ratio(total.becameMembers, total.signedUp),
    empty: total.signedUp === 0,
    weeks,
    bySource: POOL_PROFILE_SOURCES.map((source) => ({ source, counts: countSteps(cohort.filter((p) => sourceOf(p) === source), now) })),
    byCampaign,
    earlyList: people.filter((p) => p.earlyList && p.verified && IN_POOL.has(p.status)).length,
    options: {
      towns,
      sports: [...POOL_SPORT_KEYS],
      sources: [...POOL_PROFILE_SOURCES, ...input.campaigns.map((c) => `campaign:${c.code}`)],
    },
  };
}

// ── Offer health ───────────────────────────────────────────────────────

const PLAYER_CAP_REFUSALS = ["day-cap", "week-cap", "decline-cooldown"] as const satisfies readonly PlayerCapRefusal[];
// Every refusal `playerCapRefusal` can give is listed (a new one is a tsc error here).
const _allCapRefusals: Exclude<PlayerCapRefusal, (typeof PLAYER_CAP_REFUSALS)[number]> extends never ? true : never = true;
void _allCapRefusals;

export interface OfferHealthFacts {
  /** Pool-offer platform jobs created or failed in the range. */
  offerJobs: { createdAt: Date; sendAfter: Date | null; failReason: string | null; failedAt: Date | null }[];
  /** When delivered offers went, from a day before the range to its end. */
  delivered: Date[];
  /** `pausedAt` of every profile paused now for ignored offers. */
  ignoredPausedAt: Date[];
}

export interface OfferHealth {
  delivered: number;
  capsHit: { total: number; dayCap: number; weekCap: number; declineCooldown: number };
  quietHourHolds: number;
  ignoredPauses: number;
  platformCapHits: number;
}

export function buildOfferHealth(facts: OfferHealthFacts, q: { from: string; to: string }): OfferHealth {
  const range = rangeInstants(q);
  const reasonOf = new Map<string, PlayerCapRefusal>(PLAYER_CAP_REFUSALS.map((r) => [poolOfferCancelFailReason(r), r]));
  const capped = facts.offerJobs.filter((j) => within(j.failedAt, range)).flatMap((j) => (j.failReason && reasonOf.has(j.failReason) ? [reasonOf.get(j.failReason)!] : []));

  const sent = [...facts.delivered].sort((a, b) => a.getTime() - b.getTime());
  let platformCapHits = 0;
  sent.forEach((t, i) => {
    if (within(t, range) && platformRoom(sent.slice(0, i + 1), t) === 0) platformCapHits++;
  });

  return {
    delivered: sent.filter((t) => within(t, range)).length,
    capsHit: {
      total: capped.length,
      dayCap: capped.filter((r) => r === "day-cap").length,
      weekCap: capped.filter((r) => r === "week-cap").length,
      declineCooldown: capped.filter((r) => r === "decline-cooldown").length,
    },
    quietHourHolds: facts.offerJobs.filter((j) => j.sendAfter !== null && within(j.createdAt, range)).length,
    ignoredPauses: facts.ignoredPausedAt.filter((d) => within(d, range)).length,
    platformCapHits,
  };
}

export const OFFER_HEALTH_ROWS: { label: string; value: (h: OfferHealth) => number }[] = [
  { label: "Offers delivered", value: (h) => h.delivered },
  { label: "Caps hit (a player's own cap)", value: (h) => h.capsHit.total },
  { label: "Caps hit: one a day", value: (h) => h.capsHit.dayCap },
  { label: "Caps hit: two a week", value: (h) => h.capsHit.weekCap },
  { label: "Caps hit: cool-off after a no", value: (h) => h.capsHit.declineCooldown },
  { label: "Held for quiet hours", value: (h) => h.quietHourHolds },
  { label: "Paused for ignoring offers", value: (h) => h.ignoredPauses },
  { label: "Platform cap hits", value: (h) => h.platformCapHits },
];

// ── Labels and the CSV ─────────────────────────────────────────────────

export function townLabel(town: string): string {
  return town === FIRST_TOWN ? "First town (no town set)" : town;
}

export function sourceFilterLabel(source: string): string {
  return source.startsWith("campaign:") ? `Campaign ${source.slice("campaign:".length)}` : SOURCE_LABEL[source as PoolProfileSource] ?? source;
}

export function sportFilterLabel(sport: string): string {
  return isOneOf(POOL_SPORT_KEYS, sport) ? sportLabel(sport, "en") : sport;
}

const stepCells = (c: FunnelCounts) => FUNNEL_STEPS.map((s) => c[s]);
const STEP_HEADERS = FUNNEL_STEPS.map((s) => FUNNEL_STEP_LABEL[s]);

/** The whole page as CSV (RFC 4180, CRLF), one section after another. */
export function funnelCsv(r: FunnelReport, h: OfferHealth, q: FunnelQuery): string {
  const row = (cells: readonly (string | number)[]) => cells.map(csvCell).join(",");
  const lines: string[] = [
    row([
      "Pool funnel",
      `From ${q.from}`,
      `To ${q.to}`,
      `Town: ${q.town ? townLabel(q.town) : "all"}`,
      `Sport: ${q.sport ? sportFilterLabel(q.sport) : "all"}`,
      `Source: ${q.source ? sourceFilterLabel(q.source) : "all"}`,
    ]),
    "",
    row(["Step", "People", "Conversion from the step before"]),
    ...FUNNEL_STEPS.map((s) => row([FUNNEL_STEP_LABEL[s], r.total[s], percent(r.conversion[s]) ?? ""])),
    "",
    row(["Week from", STEP_HEADERS[0], ...POOL_PROFILE_SOURCES.map((s) => SOURCE_LABEL[s]), ...STEP_HEADERS.slice(1)]),
    ...r.weeks.map((w) => row([w.key, w.counts.signedUp, ...POOL_PROFILE_SOURCES.map((s) => w.bySource[s]), ...stepCells(w.counts).slice(1)])),
    "",
    row(["Source", ...STEP_HEADERS]),
    ...r.bySource.map((s) => row([SOURCE_LABEL[s.source], ...stepCells(s.counts)])),
    "",
    row(["Campaign code", "What it is for", ...STEP_HEADERS]),
    ...r.byCampaign.map((c) => row([c.code, c.label ?? "", ...stepCells(c.counts)])),
    "",
    row(["Offer health", "Count"]),
    ...OFFER_HEALTH_ROWS.map((o) => row([o.label, o.value(h)])),
    "",
    row(["Early sign-up list", r.earlyList]),
  ];
  return lines.map((l) => `${l}\r\n`).join("");
}

/** The query as a URL search string ("from=...&to=..."), for the CSV link. */
export function funnelSearch(q: FunnelQuery): string {
  const p = new URLSearchParams({ from: q.from, to: q.to });
  if (q.town) p.set("town", q.town);
  if (q.sport) p.set("sport", q.sport);
  if (q.source) p.set("source", q.source);
  return p.toString();
}

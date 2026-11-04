/**
 * THE SHORT /play FORM (Kemal, 2026-11-04). PURE and CLIENT-SAFE.
 *
 * "Too long for someone arriving from Facebook on a phone" (24 opens, 0
 * sent). The /play sign-up now asks three things: his name, his postcode
 * area and the days he can play. Everything else a profile holds takes
 * the default below until he tells MatchTime more on WhatsApp, in his own
 * words (`details-rules.ts`, the welcome's question), or on his manage
 * page, which keeps the full form.
 *
 * THE DEFAULTS, and what each does to who is offered what
 * (`matching-rules.ts` `candidateExclusion`):
 *   maxMiles 3      the pool's own default travel (rules.ts
 *                   DEFAULT_POOL_TRAVEL_MILES): a venue within 3 miles of
 *                   his postcode area's centre.
 *   00:00 to 24:00  on each day he ticked: any game that starts and ends on
 *                   that day covers him (`availability.ts`). A game past
 *                   midnight needs the next day ticked too, as before.
 *   football, []    the one live sport (`sports.ts` LIVE_SPORTS) with no
 *                   format: "any format" (decision L4.7), so a 5, 7 or
 *                   11-a-side game all match him.
 *   level null      "not saying": he is left out only of an ask that names
 *                   levels (decision L4.8), never ranked down.
 * The per-player caps (rules.ts POOL_CAPS: 2 a week, 1 a day, 1 per match,
 * 14 days after a decline, a pause after 3 ignored) and a round's 8 offers
 * are unchanged, so a wider profile is offered more games to choose from,
 * never more messages.
 *
 * One validator still decides: a short payload is EXPANDED here into the
 * fields `profile-fields.ts` checks, so the browser and the server run the
 * same rules on the same shape. A full payload (the manage page, the
 * partner invite, the sandboxed scenarios) passes through untouched.
 */
import { WEEK_ORDER } from "./form-state";
import type { PoolArea } from "./rules";
import { DEFAULT_POOL_TRAVEL_MILES } from "./rules";
import { DEFAULT_POOL_SPORT } from "./sports";

export const SHORT_FORM_DEFAULTS = Object.freeze({
  maxMiles: DEFAULT_POOL_TRAVEL_MILES,
  from: "00:00",
  to: "24:00",
  sport: DEFAULT_POOL_SPORT,
  formats: Object.freeze([]) as readonly number[],
  level: null,
});

/** What the short form holds in the browser. */
export interface ShortFormValue {
  name: string;
  /** His postcode district as typed. */
  district: string;
  /** Weekdays ticked (0 = Sunday, as `Activity.dayOfWeek`), Monday first. */
  days: number[];
}

export function emptyShortForm(name = ""): ShortFormValue {
  return { name, district: "", days: [] };
}

export function toggleShortDay(v: ShortFormValue, day: number): ShortFormValue {
  const on = v.days.includes(day) ? v.days.filter((d) => d !== day) : [...v.days, day];
  return { ...v, days: WEEK_ORDER.filter((d) => on.includes(d)) };
}

/** The three answers as the sign-up route reads them. */
export function toShortPayload(v: ShortFormValue): { name: string; area: PoolArea; days: number[] } {
  return { name: v.name, area: { kind: "district", district: v.district }, days: [...v.days] };
}

/** A short sign-up carries a `days` list and no hours. */
export function isShortSignup(raw: unknown): boolean {
  return !!raw && typeof raw === "object" && Array.isArray((raw as { days?: unknown }).days);
}

/**
 * The short payload as the full fields, with the defaults above. Anything
 * a crafted short payload sends for a defaulted field is ignored.
 */
export function expandShortSignup(raw: unknown): unknown {
  if (!isShortSignup(raw)) return raw;
  const { days, availability: _a, sports: _s, maxMiles: _m, ...rest } = raw as Record<string, unknown> & { days: unknown[] };
  void _a;
  void _s;
  void _m;
  return {
    ...rest,
    maxMiles: SHORT_FORM_DEFAULTS.maxMiles,
    availability: days.map((day) => ({ day, from: SHORT_FORM_DEFAULTS.from, to: SHORT_FORM_DEFAULTS.to })),
    sports: [{ sport: SHORT_FORM_DEFAULTS.sport, formats: [...SHORT_FORM_DEFAULTS.formats], level: SHORT_FORM_DEFAULTS.level, levelText: null }],
  };
}

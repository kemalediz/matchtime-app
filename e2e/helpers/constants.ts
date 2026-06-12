/**
 * Pure fixture constants shared by the seed (tsx/Prisma world) and the
 * specs (Playwright world). NO Prisma imports here — the Prisma 7
 * generated client is ESM-TS that Playwright's transpiler can't load,
 * so specs must stay client-free (they use the pg helper instead).
 */
import { fromZonedTime } from "date-fns-tz";

export const U = {
  admin: "e2e-user-admin", // Alex Admin — OWNER
  collector: "e2e-user-collector", // Colin Collector — money collector
  player: "e2e-user-player", // Pat Player
  rater: "e2e-user-rater", // Riley Rater
  bench: "e2e-user-bench", // Ben Bench — on the bench (upcoming)
  opt: "e2e-user-opt", // Olivia Opty — rating-DM opt-out cases
  stale: "e2e-user-stale", // Sam Stale — deleted mid-flow in rate spec
  third: "e2e-user-third", // Tom Third — target of "move X to bench"
  fresh: "e2e-user-fresh", // Ian Innes — not yet registered (IN test)
  extra: "e2e-user-extra", // Zara Zest — overflow IN test
  guest: "e2e-user-guest", // Gary Guest — NO phone
  omar1: "e2e-user-omar1", // Omar One — ambiguity pair
  omar2: "e2e-user-omar2", // Omar Two — ambiguity pair
  dup: "e2e-user-dup", // Danny Dup — merge-flow source
  walt: "e2e-user-walt", // Walt Whatsapp — provisional NEW row
} as const;

export const PHONE = {
  admin: "+447700900001",
  collector: "+447700900002",
  player: "+447700900003",
  rater: "+447700900004",
  bench: "+447700900005",
  opt: "+447700900006",
  stale: "+447700900007",
  third: "+447700900008",
  fresh: "+447700900009",
  extra: "+447700900010",
  omar1: "+447700900011",
  omar2: "+447700900012",
  dup: "+447700900013",
  walt: "+447700900014",
} as const;

export const NAME: Record<keyof typeof U, string> = {
  admin: "Alex Admin",
  collector: "Colin Collector",
  player: "Pat Player",
  rater: "Riley Rater",
  bench: "Ben Bench",
  opt: "Olivia Opty",
  stale: "Sam Stale",
  third: "Tom Third",
  fresh: "Ian Innes",
  extra: "Zara Zest",
  guest: "Gary Guest",
  omar1: "Omar One",
  omar2: "Omar Two",
  dup: "Danny Dup",
  walt: "Walt Whatsapp",
};

export const ORG_ID = "e2e-org";
export const SPORT_ID = "e2e-sport";
export const ACTIVITY_ID = "e2e-activity";
export const MATCH = {
  pay: "e2e-match-pay",
  rate: "e2e-match-rate",
  upcoming: "e2e-match-upcoming",
} as const;

export const FEE = 8; // £ base per player on the pay match

/** A wall-clock instant in Europe/London, `daysOffset` days from today. */
export function londonAt(daysOffset: number, hour: number, minute = 0): Date {
  const d = new Date(Date.now() + daysOffset * 24 * 60 * 60 * 1000);
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const ymd = fmt.format(d); // "YYYY-MM-DD"
  const hh = String(hour).padStart(2, "0");
  const mm = String(minute).padStart(2, "0");
  return fromZonedTime(`${ymd}T${hh}:${mm}:00`, "Europe/London");
}

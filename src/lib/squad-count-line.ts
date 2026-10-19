/**
 * THE SQUAD COUNT, WITH THE BENCH (FNF HQ, 2026-10-18). Pure, no Prisma.
 *
 * An organiser wrote "Akram out" in the admin group and MatchTime answered
 * "Done: Akram out. 17 of 18." while Uncle Najib was on the bench: it read
 * as if nobody was waiting. Every count line MatchTime says (the admin
 * group's "Done" and pasted-list replies, the count answer in either
 * group, the late drop-out notice, the pick fallback) takes its bench
 * words from here, so they all say the bench whenever anyone is on it.
 *
 *   benchClause          ", 1 on the bench (Uncle Najib)", or "" with an
 *                        empty bench; names up to BENCH_NAMES_SHOWN, then
 *                        the count alone;
 *   buildSquadCountLine  "17 of 18, 1 on the bench (Uncle Najib).";
 *   buildBenchPickHint   in an organiser-pick club with a place free and
 *                        someone waiting: the command that brings one of
 *                        them in from the admin group (the same squad
 *                        change path that read "Akram out"). Null in an
 *                        automatic (first-come) club: there the bench
 *                        offer fills the place, and nothing is to be done.
 */
import { t } from "./i18n/t";
import { normaliseBenchPickMode } from "./squad-capacity";

/** Up to this many bench names are listed; past it, the count alone. */
export const BENCH_NAMES_SHOWN = 3;

export function benchClause(
  lang: string | null | undefined,
  bench: readonly string[],
  opts: { names?: boolean } = {},
): string {
  if (bench.length === 0) return "";
  const names = opts.names !== false && bench.length <= BENCH_NAMES_SHOWN ? [...bench] : [];
  return `, ${t(lang).sq_bench({ count: bench.length, names })}`;
}

export function buildSquadCountLine(p: {
  lang: string | null | undefined;
  confirmed: number;
  maxPlayers: number;
  /** Who is on the bench, in bench order. */
  bench: readonly string[];
}): string {
  return t(p.lang).ag_sq_count({ confirmed: p.confirmed, max: p.maxPlayers, bench: benchClause(p.lang, p.bench) });
}

export function buildBenchPickHint(p: {
  lang: string | null | undefined;
  confirmed: number;
  maxPlayers: number;
  bench: readonly string[];
  benchPickMode: string | null | undefined;
}): string | null {
  const open = p.maxPlayers - p.confirmed;
  if (normaliseBenchPickMode(p.benchPickMode) !== "organiser" || open <= 0 || p.bench.length === 0) return null;
  return t(p.lang).sq_pick_hint({ open, name: p.bench[0] });
}

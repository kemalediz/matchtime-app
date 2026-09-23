/**
 * THE STATS TABLES IN THE GROUP, ANSWERED BY CODE (2026-09-23).
 *
 * ═══════════════════════════════════════════════════════════════════════
 * THE INCIDENT
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Kemal, in Sutton FC's group: "@Match Time please share the leaderboard
 * of ratings, top 10". MatchTime: "Most appearances in the last 30 days:
 * 1. Mustafa Cayir, 4 matches; 2. Habib, 4; 3. Mojib, 4". A correct
 * answer to a question nobody asked. `QuestionFacts` had no field for
 * WHICH table and none for HOW MANY, so the extractor could only tick
 * `stats`, and the composer answered from the one stats list it held.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * THE DESIGN KEMAL CHOSE: A HYBRID
 * ═══════════════════════════════════════════════════════════════════════
 *
 *   KNOWN TABLES, EXACTLY, BY CODE. The model names the table
 *   (`QuestionFacts.table`), the size and top-or-bottom. This module
 *   renders ratings, Man of the Match, Elo, Team of the Season, the
 *   biggest climbers, a player's chemistry and the Mr Reliable holders
 *   from a `StatsSnapshot`, which `load-stats.ts` fills from the same
 *   functions `/profile/stats` reads. No name and no number here is
 *   model-authored, which is the rule the old mega-prompt broke in a
 *   live group.
 *
 *   EVERYTHING ELSE, GROUNDED. A stats question no known table answers
 *   goes to one generic prompt (`stats-generic.ts`), fed the same
 *   snapshot, and its reply is rejected unless every name and number in
 *   it appears in what it was fed (`stats-grounding.ts`). A rejection is
 *   MatchTime's own error: the group gets the safe line, never a
 *   question about it.
 *
 *   ASK, DO NOT GUESS. A name the squad does not have, or one that fits
 *   two members, is a question back to the poster
 *   (`ask_stats_person`). One clear match is answered directly.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * THE RULES, EACH ONE KEMAL'S (2026-09-23)
 * ═══════════════════════════════════════════════════════════════════════
 *
 *   "Leaderboard" on its own means RATINGS. (The extractor's prompt.)
 *   Top of a table only, capped at ten. A bigger number is served as ten
 *   and says so. A request for the BOTTOM names nobody.
 *   Ratings: three rated matches to appear. A one-game guest with one
 *   high score must not top the club's public table (Izzet E sat second
 *   on 8.0 from one game on the website that morning). The website still
 *   shows him, flagged "1 game".
 *   Team of the Season: the WEBSITE'S minimum, two, so the group and the
 *   website cannot name different teams.
 *   Elo: three matches, now applied to the top board at its source
 *   (`match-history.ts`, `ELO_TOP_MIN_MATCHES`), so the DM Q&A agrees.
 *   Man of the Match: no minimum. It is a count of wins; one match can
 *   add at most one, so a guest cannot outrank anybody on a single game.
 *   Mr Reliable is the stats page's BADGE (`mr-reliable.ts`), never
 *   appearances, so the group cannot contradict the page.
 *   Chemistry: exactly what the page shows, best partner by win rate and
 *   by rating, on the page's own two-games-together minimum. There is no
 *   longer list and none is invented. The page's minimum is kept rather
 *   than raised to three because this answer describes ONE player's
 *   pairings, not a ranking of the club, and a different threshold here
 *   would make "Idris's best partner" disagree with Idris's own page.
 *   The nemesis is only ever told to the player it is about, in the
 *   group too, unless `NEMESIS_IN_GROUP_FOR_OTHERS` is flipped.
 *
 *
 * ═══════════════════════════════════════════════════════════════════════
 * THE PERIOD (2026-09-23)
 * ═══════════════════════════════════════════════════════════════════════
 *
 * "@Match Time who has played most matches in the last 1 year?" was
 * answered "Most appearances in the last 30 days", three names: the
 * appearances answer read a fixed 30-day window and had nowhere to put a
 * period. Appearances is now a table like the others, on the club's full
 * record, and every table takes the question's `period`:
 *
 *   CUT BY THE PERIOD: appearances, ratings, Man of the Match. The data
 *   is per match, so the table is recomputed over the period's matches
 *   (`load-stats.ts`'s `loadStatsPeriod`) and the header names it.
 *   NOT CUT, AND SAYS SO: Elo (a running rating), Team of the Season and
 *   Mr Reliable (whole-record awards), chemistry (the page's pairings).
 *   A first line says what IS shown and why. The climbers already say
 *   they are "since the last match" whatever was asked.
 *   OLDER THAN THE RECORDS: a period that starts before the club's first
 *   recorded match says where the records start, by month, read from the
 *   data, and the header says "since my records began".
 *   NO PERIOD: the whole record, and appearances SAYS "since my records
 *   began in <month>". Ratings and the rest keep the header they had.
 *
 * NEVER A DIFFERENT PERIOD WITHOUT SAYING SO. That is the rule this
 * section exists for (Kemal, 2026-09-23).
 *
 * Appearances follows the three-month inactivity rule, exactly as the
 * attendance leaderboard in `match-history.ts` does
 * (`ATTENDANCE_TABLE_FOLLOWS_ACTIVITY_RULE`): the same counting function
 * feeds both. Inactivity is judged on the whole record, never on the
 * period: a period changes the count, not who is still here.
 *
 * PURE. No Prisma, no clock: `compose.ts` imports this, and it has to
 * stay loadable in the Playwright worker.
 */
import { resolvePerson } from "./identity";
import { normaliseName } from "../name-normalise";
import { MR_RELIABLE_MIN_AVG, MR_RELIABLE_MIN_GAMES } from "../mr-reliable";
import { t } from "../i18n/t";
import { joinChoice, oneDecimal } from "../i18n/text";
import { monthYearLabel } from "../i18n/dates";
import type { Lang } from "../i18n/lang";
import { cutsTheRecord, periodKey } from "./stats-period";
import type { Member, QuestionFacts, SpeechIntent, StatsPeriod, StatsSnapshot, StatsTable } from "./types";

export { clarificationSubject } from "./awaiting-answer";

/** The most rows any list in the group carries (Kemal, 2026-09-23). */
export const GROUP_LIST_CAP = 10;
/** Rated matches a player needs to appear in the group's ratings list. */
export const GROUP_RATINGS_MIN_GAMES = 3;
/** Team of the Season's minimum: the website's own (`/profile/stats`). */
export const TEAM_OF_SEASON_MIN_GAMES = 2;
/** Mirrors `ELO_TOP_MIN_MATCHES` in `match-history.ts`, which applies it;
 *  repeated here only because this module may not import that one. */
export const ELO_TOP_MIN_MATCHES_SHOWN = 3;
/**
 * May the group be told ANOTHER player's nemesis?
 *
 * NO, by Kemal's decision of 2026-09-23. Today a nemesis is shown only on
 * that player's own stats page. A player asking about themselves ("my
 * chemistry", "who's my nemesis") hears it; asked about anybody else,
 * the group hears the best team-mates only. One constant, so the call is
 * his to flip.
 */
export const NEMESIS_IN_GROUP_FOR_OTHERS = false;

const DEFAULT_SIZE: Record<Exclude<StatsTable, "other" | "chemistry" | "team_of_season">, number> = {
  ratings: 10,
  mom: 10,
  elo: 10,
  mr_reliable: 10,
  movers: 5,
  // Ten, like every other table (2026-09-23). The old top three was the
  // 30-day answer's, retired the same day.
  appearances: 10,
};

/** The tables whose data is per match and can be cut to a period. */
export const TABLES_CUT_BY_PERIOD: ReadonlySet<StatsTable> = new Set(["appearances", "ratings", "mom"]);

/** PURE. How many rows the group gets for `table`, given what was asked. */
export function groupListSize(table: keyof typeof DEFAULT_SIZE, requested: number | null | undefined): number {
  const n = typeof requested === "number" && requested >= 1 ? Math.floor(requested) : DEFAULT_SIZE[table];
  return Math.min(n, GROUP_LIST_CAP);
}

// ── Who a stats question is about ─────────────────────────────────────

const SELF_REFS = new Set(["me", "my", "myself", "mine", "i", "ben", "benim", "beni", "bana", "kendim"]);
/** An English possessive or a Turkish case suffix after an apostrophe:
 *  "Idris's", "Idris'in", "Idris’le". Never part of the name. */
const APOSTROPHE_SUFFIX = /['’]\p{L}*$/u;

export type StatsPersonResolution =
  | { kind: "resolved"; member: Member; self: boolean }
  | { kind: "ambiguous"; candidates: Member[] }
  | { kind: "unknown"; ref: string }
  /** The asker means themselves and is not on the roster. */
  | { kind: "self-unresolved" };

/**
 * PURE. Who `ref` means, for a stats answer. An admin-curated alias wins
 * (`UserAlias`, the same precedence `resolve-sender.ts` gives it), then
 * the pipeline's `resolvePerson`, whose tightened near-miss rule is what
 * keeps "Sami" from resolving to Samir.
 */
export function resolveStatsPerson(
  ref: string,
  roster: Member[],
  aliases: StatsSnapshot["aliases"],
  senderUserId: string | null,
): StatsPersonResolution {
  const raw = (ref ?? "").trim().replace(/^@/, "").replace(APOSTROPHE_SUFFIX, "").trim();
  if (SELF_REFS.has(raw.toLocaleLowerCase("tr")) || SELF_REFS.has(raw.toLowerCase())) {
    const me = senderUserId ? roster.find((m) => m.userId === senderUserId) : undefined;
    return me ? { kind: "resolved", member: me, self: true } : { kind: "self-unresolved" };
  }
  const key = normaliseName(raw);
  const alias = aliases.find((a) => a.alias === key);
  const aliased = alias ? roster.find((m) => m.userId === alias.userId) : undefined;
  if (aliased) return { kind: "resolved", member: aliased, self: aliased.userId === senderUserId };
  const r = resolvePerson(raw, roster);
  if (r.kind === "resolved") return { kind: "resolved", member: r.member, self: r.member.userId === senderUserId };
  if (r.kind === "ambiguous") return { kind: "ambiguous", candidates: r.candidates };
  return { kind: "unknown", ref: raw || ref };
}

// ── What to do with a stats question ──────────────────────────────────

export type StatsPlan =
  | { kind: "bottom" }
  | {
      kind: "table";
      table: Exclude<StatsTable, "other">;
      size: number;
      requested: number | null;
      personUserId: string | null;
      self: boolean;
      period: StatsPeriod | null;
    }
  | { kind: "generic"; personUserId: string | null; self: boolean; period: StatsPeriod | null }
  | { kind: "ask"; ref: string; candidates: string[] }
  | { kind: "none"; why: string };

/**
 * PURE. The whole decision for one `stats` question, in one place, so
 * `answer-batch.ts` (which must know whose chemistry to load, and which
 * messages need the generic call) and `engine.ts` (which decides what to
 * say) cannot disagree about it.
 */
export function planStatsQuestion(
  facts: QuestionFacts,
  roster: Member[],
  aliases: StatsSnapshot["aliases"],
  senderUserId: string | null,
): StatsPlan {
  // No table named is the appearances table: what a stats question with
  // no measure has always been answered with, now on the full record and
  // saying its period (2026-09-23).
  const table = facts.table ?? "appearances";
  const period = facts.period ?? null;
  if (facts.listEnd === "bottom") return { kind: "bottom" };

  const ref = (facts.personRef ?? "").trim();
  let personUserId: string | null = null;
  let self = false;
  if (table === "chemistry" || ref) {
    if (!ref && !senderUserId) {
      return { kind: "none", why: "chemistry asked by an unresolved sender who named nobody" };
    }
    const r = resolveStatsPerson(ref || "me", roster, aliases, senderUserId);
    if (r.kind === "unknown") return { kind: "ask", ref: r.ref, candidates: [] };
    if (r.kind === "ambiguous") return { kind: "ask", ref, candidates: r.candidates.map((m) => m.name) };
    if (r.kind === "self-unresolved") return { kind: "none", why: "the asker means themselves and is not on the roster" };
    personUserId = r.member.userId;
    self = r.self;
  }
  // A named player on a club-wide table ("what's Sait's rating?") is not
  // a table: printing the top ten would not answer it. Grounded prompt.
  if (table === "other" || (personUserId !== null && table !== "chemistry")) {
    return { kind: "generic", personUserId, self, period };
  }
  const requested = typeof facts.listSize === "number" && facts.listSize >= 1 ? Math.floor(facts.listSize) : null;
  const size =
    table === "chemistry" || table === "team_of_season" ? GROUP_LIST_CAP : groupListSize(table, requested);
  return { kind: "table", table, size, requested, personUserId, self, period };
}

// ── Rendering ─────────────────────────────────────────────────────────

type TableSpeech = Extract<SpeechIntent, { kind: "answer_stats_table" }>;

function firstToken(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

/**
 * PURE. The span one table's answer covers, and the line that goes above
 * it: which rows to use, what the header says about the period, and the
 * honest first line when the period asked for is not the one shown.
 * `null` when a cut period was asked for and was not loaded, which the
 * composer turns into an operator note: never a silently different table.
 */
function periodView(
  sp: TableSpeech,
  snap: StatsSnapshot,
  lang: Lang,
): { rows: { appearances: StatsSnapshot["appearances"]; ratings: StatsSnapshot["ratings"]; mom: StatsSnapshot["mom"] }; when: string; lead: string | null } | null {
  const s = t(lang);
  const period = sp.period ?? null;
  const start = sp.table === "mom" ? snap.recordsStart.mom : snap.recordsStart.matches;
  const since = start ? monthYearLabel(lang, start) : null;
  const whole = { appearances: snap.appearances, ratings: snap.ratings, mom: snap.mom };

  if (!TABLES_CUT_BY_PERIOD.has(sp.table)) {
    // Whole-record by nature. A cut period is answered with the whole
    // table and a first line that says so; the climbers' header already
    // says what they are, whatever was asked.
    const lead =
      cutsTheRecord(period) && sp.table !== "movers"
        ? s.stats_period_not_cut({ table: sp.table as "elo" | "team_of_season" | "mr_reliable" | "chemistry", since, span: s.stats_span({ period }) })
        : null;
    return { rows: whole, when: "", lead };
  }
  if (cutsTheRecord(period)) {
    const cut = snap.periods[periodKey(period)];
    if (!cut) return null;
    // Asked further back than the records go: say where they start, and
    // head the table with that, not with the period asked for.
    const unreached = start !== null && start.getTime() > cut.since.getTime();
    return {
      rows: cut,
      when: unreached ? s.stats_when({ period: null, since }) : s.stats_when({ period, since: null }),
      lead: unreached && since ? s.stats_period_unreached({ since, span: s.stats_span({ period }) }) : null,
    };
  }
  // The whole record. Appearances always says so; ratings and Man of the
  // Match only when a period was asked for, so an answer to a question
  // with no period reads exactly as it did before this change.
  const when = period !== null || sp.table === "appearances" ? s.stats_when({ period, since }) : "";
  return { rows: whole, when, lead: null };
}

/** PURE. The honest line after a grounded generic answer when the
 *  question asked for a period the tables it was given do not cut to.
 *  `null` when there is nothing to say. */
export function genericPeriodNote(period: StatsPeriod | null | undefined, snap: StatsSnapshot, lang: Lang): string | null {
  if (!cutsTheRecord(period)) return null;
  const s = t(lang);
  const start = snap.recordsStart.matches;
  return s.stats_period_not_cut({ table: "generic", since: start ? monthYearLabel(lang, start) : null, span: s.stats_span({ period }) });
}

/** PURE. The exact text for one known table. "" when there is nothing
 *  loaded to render (the composer turns that into an operator note). */
export function renderStatsTable(sp: TableSpeech, snap: StatsSnapshot, lang: Lang): string {
  const view = periodView(sp, snap, lang);
  if (!view) return "";
  const body = renderTableBody(sp, snap, lang, view);
  return body && view.lead ? `${view.lead}\n${body}` : body;
}

function renderTableBody(
  sp: TableSpeech,
  snap: StatsSnapshot,
  lang: Lang,
  view: NonNullable<ReturnType<typeof periodView>>,
): string {
  const s = t(lang);
  const url = snap.fullTableUrl;
  const capped = sp.requested !== null && sp.requested > GROUP_LIST_CAP;
  const withCap = (text: string) => (capped ? `${text}\n\n${s.stats_capped({ cap: GROUP_LIST_CAP, url })}` : text);
  const d = (x: number) => oneDecimal(lang, x);
  const when = view.when;

  switch (sp.table) {
    case "appearances": {
      const rows = view.rows.appearances.slice(0, sp.size);
      // Nothing to count over the whole record is "nothing yet"; nothing
      // in a period says the period.
      if (rows.length === 0) return s.stats_apps_empty({ when: cutsTheRecord(sp.period) ? when : "" });
      return withCap(
        [
          s.stats_apps_head({ when }),
          ...rows.map((r, i) => s.stats_apps_row({ rank: i + 1, name: r.name, matches: r.matches })),
        ].join("\n"),
      );
    }
    case "ratings": {
      const rows = view.rows.ratings.slice(0, sp.size);
      if (rows.length === 0) return s.stats_ratings_empty({ minGames: GROUP_RATINGS_MIN_GAMES, url, when: when || undefined });
      return withCap(
        [
          s.stats_ratings_head({ n: rows.length, minGames: GROUP_RATINGS_MIN_GAMES, when: when || undefined }),
          ...rows.map((r) => s.stats_ratings_row({ rank: r.rank, name: r.name, avg: d(r.avg), games: r.games })),
        ].join("\n"),
      );
    }
    case "mom": {
      const rows = view.rows.mom.slice(0, sp.size);
      if (rows.length === 0) return when ? s.stats_mom_empty_when({ when }) : s.stats_mom_empty;
      return withCap(
        [
          when ? s.stats_mom_head_when({ when }) : s.stats_mom_head,
          ...rows.map((r, i) => s.stats_mom_row({ rank: i + 1, name: r.name, wins: r.wins })),
        ].join("\n"),
      );
    }
    case "elo": {
      const rows = snap.elo.slice(0, sp.size);
      if (rows.length === 0) return s.stats_elo_empty({ minMatches: ELO_TOP_MIN_MATCHES_SHOWN });
      return withCap(
        [
          s.stats_elo_head({ n: rows.length, minMatches: ELO_TOP_MIN_MATCHES_SHOWN }),
          ...rows.map((r, i) => s.stats_elo_row({ rank: i + 1, name: r.name, rating: r.rating, matches: r.matches })),
        ].join("\n"),
      );
    }
    case "team_of_season": {
      const tots = snap.teamOfSeason;
      if (!tots || tots.slots.length === 0) return s.stats_tots_empty({ minGames: TEAM_OF_SEASON_MIN_GAMES });
      return [
        s.stats_tots_head({ sportName: tots.sportName, minGames: TEAM_OF_SEASON_MIN_GAMES }),
        ...tots.slots.map((x, i) =>
          s.stats_tots_row({
            n: i + 1,
            name: x.name,
            position: x.position && x.position !== "ANY" ? x.position : null,
            avg: d(x.avg),
            games: x.games,
          }),
        ),
      ].join("\n");
    }
    case "movers": {
      // `loadRatingLeaderboard`'s own week-on-week movement, the arrows on
      // the website. NOT a new "last N matches" trend: three matches is
      // too small a sample, and the header says plainly what this is,
      // whatever window the question named.
      const climbers = snap.ratings
        .filter((r) => (r.delta ?? 0) > 0)
        .sort((a, b) => (b.delta ?? 0) - (a.delta ?? 0) || a.rank - b.rank)
        .slice(0, sp.size);
      if (climbers.length === 0) return s.stats_movers_empty;
      return withCap(
        [
          s.stats_movers_head,
          ...climbers.map((r, i) =>
            s.stats_movers_row({
              n: i + 1,
              name: r.name,
              delta: r.delta ?? 0,
              // Top of the table only: a climber still outside the top
              // ten is named for climbing, never given his position.
              rank: r.rank <= GROUP_LIST_CAP ? r.rank : null,
              games: r.games,
            }),
          ),
        ].join("\n"),
      );
    }
    case "mr_reliable": {
      const minAvg = d(MR_RELIABLE_MIN_AVG);
      const rows = snap.mrReliable.slice(0, sp.size);
      if (rows.length === 0) return s.stats_reliable_empty({ minAvg, minGames: MR_RELIABLE_MIN_GAMES });
      return withCap(
        [
          s.stats_reliable_head({ minAvg, minGames: MR_RELIABLE_MIN_GAMES }),
          ...rows.map((r, i) => s.stats_reliable_row({ n: i + 1, name: r.name, avg: d(r.avg), games: r.games })),
        ].join("\n"),
      );
    }
    case "chemistry": {
      const c = sp.personUserId ? snap.chemistry[sp.personUserId] : undefined;
      if (!c) return "";
      const player = firstToken(c.name);
      const lines: string[] = [];
      if (c.bestByWinRate) {
        lines.push(
          s.stats_chem_winrate({
            partner: c.bestByWinRate.name,
            wins: c.bestByWinRate.wins,
            games: c.bestByWinRate.gamesTogether,
            pct: Math.round(c.bestByWinRate.winRate * 100),
          }),
        );
      }
      if (c.bestByRating && !c.bestByRating.sameAsWinRate) {
        lines.push(s.stats_chem_rating({ partner: c.bestByRating.name, player, avg: d(c.bestByRating.myAvgWith) }));
      }
      if (c.nemesis && (sp.self || NEMESIS_IN_GROUP_FOR_OTHERS)) {
        lines.push(s.stats_chem_nemesis({ name: c.nemesis.name, player, wins: c.nemesis.wins, games: c.nemesis.gamesAgainst }));
      }
      if (lines.length === 0) return s.stats_chem_empty({ name: c.name });
      return [s.stats_chem_head({ name: c.name }), ...lines].join("\n");
    }
  }
}

/** PURE. A request for the bottom of a table: nobody named, the site linked. */
export function renderStatsBottom(snap: StatsSnapshot, lang: Lang): string {
  return t(lang).stats_bottom({ url: snap.fullTableUrl });
}

/** PURE. What the generic path says when its reply cannot be trusted. */
export function renderStatsGenericSafeLine(snap: StatsSnapshot, lang: Lang): string {
  return t(lang).stats_generic_safe({ url: snap.fullTableUrl });
}

/** PURE. The honest question back to the poster. */
export function renderAskPerson(
  a: { askerName: string | null; ref: string; candidates: string[] },
  lang: Lang,
): string {
  const s = t(lang);
  const asker = a.askerName ? firstToken(a.askerName) : null;
  return a.candidates.length > 0
    ? s.stats_ask_ambiguous({ asker, choices: joinChoice(lang, a.candidates) })
    : s.stats_ask_unknown({ asker, ref: a.ref });
}

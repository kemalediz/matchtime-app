/**
 * The labels of the match context header (Kemal, 2026-10-18).
 *
 * The payments page (/collect/<match>) and the team management page
 * (/admin/matches/<match>/teams) are reached from a match, but used to
 * name only the game: no day, no kickoff, no venue. An organiser with
 * two games a week could not tell which one they were looking at. The
 * header (`components/match/match-context-header.tsx`) reads its words
 * from here, so both pages say the same thing the same way.
 *
 * Pure: the day and the kickoff are London wall clock in the club's
 * language (`i18n/dates`), the rest comes from the string tables. The
 * date may arrive as a Date (server page) or as JSON (the teams page
 * reads /api/matches/<id>).
 */
import { dayLabel, timeLabel } from "./i18n/dates";
import { t } from "./i18n/t";
import { hasScore } from "./score-entry";
import type { Lang } from "./i18n/lang";

export type MatchContextInput = {
  date: Date | string;
  status: string;
  redScore: number | null;
  yellowScore: number | null;
  /** Resolved display labels: [RED slot, YELLOW slot]. */
  teamLabels: [string, string];
  lang: Lang | string | null | undefined;
};

export type MatchContext = {
  dateLabel: string;
  timeLabel: string;
  kickoffLabel: string;
  statusLabel: string;
  /** Tailwind classes for the status pill, as the match page colours it. */
  statusTone: string;
  backLabel: string;
  score: { redLabel: string; red: number; yellowLabel: string; yellow: number } | null;
};

const TONE: Record<string, string> = {
  COMPLETED: "bg-green-100 text-green-700",
  TEAMS_PUBLISHED: "bg-blue-100 text-blue-700",
  TEAMS_GENERATED: "bg-amber-100 text-amber-700",
  CANCELLED: "bg-red-100 text-red-700",
};

export function matchContext(input: MatchContextInput): MatchContext {
  const d = typeof input.date === "string" ? new Date(input.date) : input.date;
  const s = t(input.lang);
  const time = timeLabel(d);
  return {
    dateLabel: dayLabel(input.lang, d),
    timeLabel: time,
    kickoffLabel: s.mch_kickoff({ time }),
    statusLabel: s.mch_status({ status: input.status }),
    statusTone: TONE[input.status] ?? "bg-slate-100 text-slate-600",
    backLabel: s.mch_back_to_match,
    score: hasScore(input)
      ? {
          redLabel: input.teamLabels[0],
          red: input.redScore as number,
          yellowLabel: input.teamLabels[1],
          yellow: input.yellowScore as number,
        }
      : null,
  };
}

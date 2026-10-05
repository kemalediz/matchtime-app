/**
 * F3, LEARNED SETUP: THE ORGANISER'S ONE DM, AND THE WORDS THE SETTINGS
 * PAGE SHOWS FOR EACH ITEM (2026-10-05). Pure: the links arrive minted.
 *
 * The DM, in the club's language:
 *   intro (what MatchTime did)
 *   per switched setting: what it does now, one chat quote, its undo link
 *   "worth a check": the weekly game or language the chat disagrees with,
 *     changed nowhere, with a link to change it
 *   the monthly list, when seen: noted, nothing changed for it, and the
 *     monthly squad mode is coming (the organiser will be told)
 *   outro: the settings page, where every item and its evidence lives
 */
import { t } from "../i18n/t";
import { normaliseLang } from "../i18n/lang";
import type { AppliedItem, DayTimeValue, LearnedKey, NotedPattern, Suggestion } from "./rules";

/** The line for one switched setting, in `lang`. */
export function appliedLine(lang: string, key: LearnedKey, to: unknown): string {
  const s = t(lang);
  const v = to && typeof to === "object" ? (to as DayTimeValue) : null;
  return s.setup_applied_line({
    key,
    day: v ? s.wd_weekday({ dow: v.day }) : "",
    time: v ? v.time : "",
  });
}

/** The line for one suggestion, in `lang`, with its values worded. */
export function suggestionLine(lang: string, sg: Suggestion): string {
  const s = t(lang);
  const word = (v: string): string => {
    if (sg.key === "weeklyGameDay") return s.wd_weekday({ dow: Number(v) });
    if (sg.key === "language") return s.setup_lang_name({ key: normaliseLang(v) });
    return v;
  };
  return s.setup_suggestion_line({ key: sg.key, current: word(sg.current), detected: word(sg.detected) });
}

/** The monthly-list sentence fragment, in `lang`. */
export function monthlyPattern(lang: string, n: NotedPattern): string {
  return t(lang).setup_monthly_pattern({
    prepay: n.prepayForMonth,
    payg: n.payAsYouGoFillIns,
    credits: n.creditForMissedGames,
  });
}

export interface SetupDmInput {
  lang: string;
  group: string | null;
  applied: Array<AppliedItem & { undoUrl: string }>;
  suggestions: Suggestion[];
  noted: NotedPattern[];
  /** Where the weekly game is changed (/admin/activities). */
  scheduleUrl: string;
  /** /admin/settings, highlighting the learned panel. */
  settingsUrl: string;
}

export function composeSetupDm(p: SetupDmInput): string {
  const s = t(p.lang);
  const blocks: string[] = [];
  blocks.push(p.applied.length > 0 ? s.sj_dm_setup_intro({ group: p.group }) : s.sj_dm_setup_intro_nothing({ group: p.group }));

  for (const a of p.applied) {
    const lines = [`✅ ${appliedLine(p.lang, a.key, a.to)}`];
    if (a.evidence[0]) lines.push(s.sj_dm_setup_from({ quote: a.evidence[0] }));
    lines.push(s.sj_dm_setup_undo({ url: a.undoUrl }));
    blocks.push(lines.join("\n"));
  }

  if (p.suggestions.length > 0) {
    const lines = [s.sj_dm_setup_check_head];
    for (const sg of p.suggestions) lines.push(`🔎 ${suggestionLine(p.lang, sg)}`);
    const gameKeys = p.suggestions.some((sg) => sg.key !== "language");
    lines.push(s.sj_dm_setup_check_link({ url: gameKeys ? p.scheduleUrl : p.settingsUrl }));
    blocks.push(lines.join("\n"));
  }

  for (const n of p.noted) {
    blocks.push(
      s.sj_dm_setup_monthly({ pattern: monthlyPattern(p.lang, n), heldPaymentTracking: n.heldPaymentTracking }),
    );
  }

  blocks.push(s.sj_dm_setup_outro({ url: p.settingsUrl }));
  return blocks.join("\n\n");
}

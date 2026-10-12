/**
 * F3, LEARNED SETUP: THE ORGANISER'S ONE DM, AND THE WORDS THE SETTINGS
 * PAGE SHOWS FOR EACH ITEM (2026-10-05). Pure: the links arrive minted.
 *
 * The DM, in the club's language:
 *   intro (what MatchTime did)
 *   per switched setting: what it does now, one chat quote, its undo link
 *   "worth a check": the weekly game or language the chat disagrees with,
 *     changed nowhere, with a link to change it; then "organisers pick",
 *     which is never switched from the chat (rules.ts, rule 4): what it
 *     looks like, one chat quote, and a link to the setting
 *   (the match fee, when the chat or the group description states one the
 *     weekly game does not have, sits between those two: asked, never
 *     set, with its quote and a link to where the fee is entered)
 *   the monthly list, when seen: noted, nothing changed for it, and a
 *     pointer to Monthly squad in Settings, which only the organiser
 *     ever switches on
 *   outro: the settings page, where every item and its evidence lives
 *
 * WHERE A QUOTE CAME FROM (go-live slice D3, 2026-10-12). A quote found
 * in the GROUP DESCRIPTION is shown under its own label, "From your group
 * description", never as a message somebody sent. An item backed by a
 * message and the description shows one line of each. An item with no
 * description evidence reads word for word as it did before that slice.
 */
import { t } from "../i18n/t";
import { normaliseLang } from "../i18n/lang";
import type { AppliedItem, DayTimeValue, Evidenced, LearnedKey, NotedPattern, Suggestion } from "./rules";

/**
 * An item's quotes by where they were found. `fromDescription` names the
 * quotes that are the description's; each takes ONE matching quote out of
 * the chat's (the last, since a quote stands for a message first), so the
 * same words found in a message and in the description show under both.
 */
export function splitEvidence(item: Evidenced): { chat: string[]; description: string[] } {
  const chat = [...(Array.isArray(item.evidence) ? item.evidence : [])];
  const description: string[] = [];
  for (const q of Array.isArray(item.fromDescription) ? item.fromDescription : []) {
    const i = chat.lastIndexOf(q);
    if (i < 0) continue;
    chat.splice(i, 1);
    description.push(q);
  }
  return { chat, description };
}

/** The DM's "why" lines for one item: one chat quote, then one description quote. */
export function evidenceLines(lang: string, item: Evidenced): string[] {
  const s = t(lang);
  const { chat, description } = splitEvidence(item);
  return [
    ...(chat[0] ? [s.sj_dm_setup_from({ quote: chat[0] })] : []),
    ...(description[0] ? [s.sj_dm_setup_from_description({ quote: description[0] })] : []),
  ];
}

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
  /** /admin/settings, at the "organisers pick" suggestion, which leads to
   *  the setting. Used only when that suggestion is in `suggestions`. */
  organiserPicksUrl: string;
  /** Where the match fee is entered. Used only when that suggestion is in
   *  `suggestions`; without it the fee line links to `scheduleUrl`, the
   *  weekly game page, which is where the fee is. */
  feeUrl?: string | null;
}

/**
 * The findings, block by block: the intro, each switched setting, the
 * things worth a check, the monthly list. Everything `composeSetupDm`
 * says except its closing line. Shared with the setup DM of a club that
 * is held until its organiser says GO (club-setup-dm-rules.ts), which
 * carries the same findings between its own head and its own links.
 */
export function setupFindingsBlocks(p: SetupDmInput): string[] {
  const s = t(p.lang);
  const blocks: string[] = [];
  blocks.push(p.applied.length > 0 ? s.sj_dm_setup_intro({ group: p.group }) : s.sj_dm_setup_intro_nothing({ group: p.group }));

  for (const a of p.applied) {
    const lines = [`✅ ${appliedLine(p.lang, a.key, a.to)}`];
    lines.push(...evidenceLines(p.lang, a));
    lines.push(s.sj_dm_setup_undo({ url: a.undoUrl }));
    blocks.push(lines.join("\n"));
  }

  if (p.suggestions.length > 0) {
    const lines = [s.sj_dm_setup_check_head];
    // What the organiser entered and the chat disagrees with: one link for all of it.
    const entered = p.suggestions.filter((sg) => sg.key !== "organiserPicks" && sg.key !== "matchFee");
    for (const sg of entered) lines.push(`🔎 ${suggestionLine(p.lang, sg)}`);
    if (entered.length > 0) {
      const gameKeys = entered.some((sg) => sg.key !== "language");
      lines.push(s.sj_dm_setup_check_link({ url: gameKeys ? p.scheduleUrl : p.settingsUrl }));
    }
    // The match fee: asked, with its quote and its own link to the fee.
    for (const sg of p.suggestions.filter((x) => x.key === "matchFee")) {
      lines.push(`🔎 ${suggestionLine(p.lang, sg)}`);
      lines.push(...evidenceLines(p.lang, sg));
      lines.push(s.sj_dm_setup_fee_link({ url: p.feeUrl || p.scheduleUrl }));
    }
    // Organisers pick: asked, with a quote and its own link to the setting.
    for (const sg of p.suggestions.filter((x) => x.key === "organiserPicks")) {
      lines.push(`🔎 ${suggestionLine(p.lang, sg)}`);
      lines.push(...evidenceLines(p.lang, sg));
      lines.push(s.sj_dm_setup_pick_link({ url: p.organiserPicksUrl }));
    }
    blocks.push(lines.join("\n"));
  }

  for (const n of p.noted) {
    blocks.push(
      s.sj_dm_setup_monthly({ pattern: monthlyPattern(p.lang, n), heldPaymentTracking: n.heldPaymentTracking }),
    );
  }

  return blocks;
}

export function composeSetupDm(p: SetupDmInput): string {
  return [...setupFindingsBlocks(p), t(p.lang).sj_dm_setup_outro({ url: p.settingsUrl })].join("\n\n");
}

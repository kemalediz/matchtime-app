/**
 * The organiser ⓘ popups (F1, 2026-10-05): which copy each one reads,
 * and the two display-side wording fixes on /finish-setup.
 *
 * The words live in the string tables (`info_<key>_title` and
 * `info_<key>_body`, src/lib/i18n/strings.{en,tr}.ts). This file only
 * knows the keys, so it stays pure and client-safe (no DB, no server
 * imports): the settings page and the finish-setup form are client
 * components.
 */
import { t, type Strings } from "./i18n/t";
import type { Lang } from "./i18n/lang";
import type { ToggleableKey } from "./org-features-meta";

/** Every popup key: `fs_players` for `info_fs_players_title` / `_body`. */
export type InfoKey = {
  [K in keyof Strings]: K extends `info_${infer R}_title` ? R : never;
}[keyof Strings];

/** The popup's title and its paragraphs (a blank line separates them). */
export function infoCopy(lang: Lang | string | null | undefined, key: InfoKey): { title: string; paragraphs: string[] } {
  const s = t(lang) as unknown as Record<string, string>;
  const title = s[`info_${key}_title`];
  const body = s[`info_${key}_body`];
  return {
    title,
    paragraphs: body
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter(Boolean),
  };
}

/** Every key the English table defines, for the copy tests. */
export function allInfoKeys(): InfoKey[] {
  const en = t("en") as unknown as Record<string, unknown>;
  return Object.keys(en)
    .filter((k) => /^info_.+_title$/.test(k))
    .map((k) => k.slice("info_".length, -"_title".length) as InfoKey);
}

/**
 * One popup per switch in the settings page's Bot features section,
 * including the badge row that is not in `FEATURE_META`. A new switch
 * without a popup is a `tsc` error here.
 */
export const FEATURE_INFO: Record<ToggleableKey, InfoKey> = {
  attendance: "feat_attendance",
  bench: "feat_bench",
  teamBalancing: "feat_teams",
  momVoting: "feat_mom",
  playerRating: "feat_rating",
  reminders: "feat_reminders",
  statsQa: "feat_stats",
  paymentTracking: "feat_pay_tracking",
  paymentCollection: "feat_pay_collect",
  payByBank: "feat_pay_bank",
  payCard: "feat_pay_card",
  payDirect: "feat_pay_direct",
  badgeAnnouncements: "feat_badges",
};

// ── /finish-setup ──────────────────────────────────────────────────────

export type ConfidenceLevel = "high" | "med" | "low";

/**
 * The badge on each proposed player. It is how sure the chat analyser was
 * about the guessed position and seed rating, NOT a rating of the player:
 * Kemal read a red "low" as "a low-rated player" (2026-09-30), so low now
 * reads as a guess to check.
 */
export function confidenceBadge(
  confidence: number,
  lang: Lang | string | null | undefined,
): { level: ConfidenceLevel; label: string; cls: string } {
  const s = t(lang);
  if (confidence >= 0.66) return { level: "high", label: s.fs_conf_high, cls: "bg-green-50 text-green-700 border-green-200" };
  if (confidence >= 0.33) return { level: "med", label: s.fs_conf_med, cls: "bg-amber-50 text-amber-700 border-amber-200" };
  return { level: "low", label: s.fs_conf_low, cls: "bg-amber-50 text-amber-800 border-amber-300" };
}

/**
 * The analyser's "no evidence" note, as the prompt and the reconcile
 * fallback write it ("No clear signal in chat — defaulting to neutral"),
 * matched loosely: the model sometimes swaps the dash or drops it.
 */
const NO_SIGNAL_RE = /^\s*no clear signal in (?:the )?chat\b/i;

/**
 * What the evidence line shows. The analyser's stock "no clear signal"
 * note becomes a plain sentence in the club's language; anything else
 * (a real quote from the chat) is shown as written. Display side only,
 * so the analyser's prompt is untouched.
 */
export function displayEvidence(evidence: string | null | undefined, lang: Lang | string | null | undefined): string {
  const e = (evidence ?? "").trim();
  if (e === "" || NO_SIGNAL_RE.test(e)) return t(lang).fs_evidence_none;
  return e;
}

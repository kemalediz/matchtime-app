/**
 * THE POOL'S DM TEXT (slice L2). PURE. The words are in the string tables
 * (`pool_dm_*` in src/lib/i18n/strings.*.ts); the numbers in them come from
 * `rules.ts` and the links from the paths, so nothing is typed twice.
 */
import { appUrl } from "../app-url";
import { PRIVACY_PATH } from "../privacy-policy";
import { t } from "../i18n/t";
import type { Lang } from "../i18n/lang";
import { poolDetailsCopy } from "../i18n/pool-details";
import { joinChoice, joinList } from "../i18n/text";
import type { DetailsSummary } from "./details-rules";
import { WEEK_ORDER } from "./form-state";
import { poolPageCopy } from "./page-copy";
import { POOL_PLAY_PATH } from "./paths";
import { POOL_CAPS } from "./rules";
import { DEFAULT_POOL_SPORT, formatsOf } from "./sports";

export function poolFirstName(displayName: string | null | undefined): string | null {
  const first = (displayName ?? "").trim().split(/\s+/)[0];
  return first ? first : null;
}

/** The ONE reply to the message that confirmed his sign-up. `details`: the
 *  question about his times and formats (`poolDetailsQuestion`), when his
 *  profile still holds only the short form's days (2026-11-04). */
export function poolWelcomeText(lang: Lang, p: { displayName: string; earlyList: boolean; manageLink: string; details?: string | null }): string {
  const s = t(lang);
  const args = {
    name: poolFirstName(p.displayName),
    perWeek: POOL_CAPS.perPlayerPerWeek,
    manageLink: p.manageLink,
    privacyLink: appUrl(PRIVACY_PATH),
    details: p.details ?? null,
  };
  return p.earlyList ? s.pool_dm_welcome_early(args) : s.pool_dm_welcome(args);
}

// ── His times and formats, asked on WhatsApp (2026-11-04) ─────────────

/** His days in words, Monday first: "Tuesday and Saturday". */
export function daysInWords(lang: Lang, days: readonly number[]): string {
  const names = poolPageCopy(lang).fields.dayNames;
  return joinList(lang, WEEK_ORDER.filter((d) => days.includes(d)).map((d) => names[d]));
}

/** Football's formats as the question offers them: "5, 7, 8, 9 or 11-a-side". */
export function formatsChoice(lang: Lang): string {
  return poolDetailsCopy(lang).formatsChoice(joinChoice(lang, formatsOf(DEFAULT_POOL_SPORT).map(String)));
}

/** The welcome's question about his times and formats on his `days`. */
export function poolDetailsQuestion(lang: Lang, days: readonly number[]): string {
  return poolDetailsCopy(lang).question({ days: daysInWords(lang, days), formats: formatsChoice(lang) });
}

/** The ONE later question, if he never answered the welcome's. */
export function poolDetailsAskText(lang: Lang, p: { displayName: string | null; days: readonly number[]; manageLink: string }): string {
  return poolDetailsCopy(lang).ask({ name: poolFirstName(p.displayName), days: daysInWords(lang, p.days), formats: formatsChoice(lang), manageLink: p.manageLink });
}

/** After his answer was saved: what his profile says now. */
export function poolDetailsSavedText(lang: Lang, summary: DetailsSummary, manageLink: string): string {
  const c = poolDetailsCopy(lang);
  const names = poolPageCopy(lang).fields.dayNames;
  const days = joinList(
    lang,
    summary.days.map((d) =>
      d.any ? c.dayAnyTime(names[d.day]) : c.dayRanges(names[d.day], joinList(lang, d.ranges.map((r) => c.range(r.from, r.to, r.to === "24:00")))),
    ),
  );
  const formats = summary.formats && summary.formats.length ? c.formatsSaved(joinList(lang, summary.formats.map(String))) : c.anyFormat;
  return c.saved({ days, formats, manageLink });
}

/** His answer could not be read for sure: once, what he meant. */
export function poolDetailsReaskText(lang: Lang, manageLink: string): string {
  return poolDetailsCopy(lang).reask({ manageLink });
}

/** He has a profile already and sent a waiting sign-up's code: his own
 *  profile stays his (a stopped one is started again from his link). */
export function poolAlreadyText(lang: Lang, status: "active" | "paused" | "stopped", manageLink: string): string {
  return status === "stopped" ? t(lang).pool_dm_already_stopped({ manageLink }) : t(lang).pool_dm_already({ manageLink });
}

/** A code that did not work. Never carries a code: nobody learns one. */
export function poolCodeReplyText(kind: "expired" | "wrong-code" | "not-yours", lang: Lang): string {
  if (kind === "not-yours") return t(lang).pool_dm_code_not_yours;
  const playLink = appUrl(POOL_PLAY_PATH);
  return kind === "expired" ? t(lang).pool_dm_code_expired({ playLink }) : t(lang).pool_dm_code_wrong({ playLink });
}

/** Slice L3: the one line to a number that sent a member's code. Names no
 *  account and no person; the member finishes on his own page. */
export function poolClaimWaitText(lang: Lang): string {
  return t(lang).pool_dm_claim_wait;
}

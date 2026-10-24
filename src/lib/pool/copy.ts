/**
 * THE POOL'S DM TEXT (slice L2). PURE. The words are in the string tables
 * (`pool_dm_*` in src/lib/i18n/strings.*.ts); the numbers in them come from
 * `rules.ts` and the links from the paths, so nothing is typed twice.
 */
import { appUrl } from "../app-url";
import { PRIVACY_PATH } from "../privacy-policy";
import { t } from "../i18n/t";
import type { Lang } from "../i18n/lang";
import { POOL_PLAY_PATH } from "./paths";
import { POOL_CAPS, POOL_QUIET_HOURS } from "./rules";

export function poolFirstName(displayName: string | null | undefined): string | null {
  const first = (displayName ?? "").trim().split(/\s+/)[0];
  return first ? first : null;
}

/** The ONE reply to the message that confirmed his sign-up. */
export function poolWelcomeText(lang: Lang, p: { displayName: string; earlyList: boolean; manageLink: string }): string {
  const s = t(lang);
  const args = {
    name: poolFirstName(p.displayName),
    perWeek: POOL_CAPS.perPlayerPerWeek,
    quietFrom: POOL_QUIET_HOURS.from,
    quietTo: POOL_QUIET_HOURS.to,
    manageLink: p.manageLink,
    privacyLink: appUrl(PRIVACY_PATH),
  };
  return p.earlyList ? s.pool_dm_welcome_early(args) : s.pool_dm_welcome(args);
}

/** He is in the pool already and sent a new sign-up's code. */
export function poolAlreadyText(lang: Lang, manageLink: string): string {
  return t(lang).pool_dm_already({ manageLink });
}

/** A code that did not work. Never carries a code: nobody learns one. */
export function poolCodeReplyText(kind: "expired" | "wrong-code", lang: Lang): string {
  const playLink = appUrl(POOL_PLAY_PATH);
  return kind === "expired" ? t(lang).pool_dm_code_expired({ playLink }) : t(lang).pool_dm_code_wrong({ playLink });
}

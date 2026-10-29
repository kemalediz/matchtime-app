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
import { POOL_CAPS } from "./rules";

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
    manageLink: p.manageLink,
    privacyLink: appUrl(PRIVACY_PATH),
  };
  return p.earlyList ? s.pool_dm_welcome_early(args) : s.pool_dm_welcome(args);
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

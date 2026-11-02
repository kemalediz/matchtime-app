/**
 * The partner pool invite, in the language asked for (2026-11-02). The
 * tables are `pool-partner-invite.en.ts` and `pool-partner-invite.tr.ts`;
 * anything unknown is English, as `t()` does.
 */
import { normaliseLang, type Lang } from "./lang";
import { poolPartnerInviteEn, type PoolPartnerInviteStrings } from "./pool-partner-invite.en";
import { poolPartnerInviteTr } from "./pool-partner-invite.tr";

export type { PoolPartnerInviteStrings };

export const POOL_PARTNER_INVITE_TABLES: Readonly<Record<Lang, PoolPartnerInviteStrings>> = { en: poolPartnerInviteEn, tr: poolPartnerInviteTr };

export function partnerInviteCopy(lang: Lang | string | null | undefined): PoolPartnerInviteStrings {
  return POOL_PARTNER_INVITE_TABLES[normaliseLang(lang)];
}

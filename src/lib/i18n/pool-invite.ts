/**
 * Joining a club's group, in the language asked for (pool L8). The tables
 * are `pool-invite.en.ts` and `pool-invite.tr.ts`; anything unknown is
 * English, as `t()` does.
 */
import { normaliseLang, type Lang } from "./lang";
import { poolInviteEn, type PoolInviteStrings } from "./pool-invite.en";
import { poolInviteTr } from "./pool-invite.tr";

export type { PoolInviteStrings };

export const POOL_INVITE_TABLES: Readonly<Record<Lang, PoolInviteStrings>> = { en: poolInviteEn, tr: poolInviteTr };

export function inviteCopy(lang: Lang | string | null | undefined): PoolInviteStrings {
  return POOL_INVITE_TABLES[normaliseLang(lang)];
}

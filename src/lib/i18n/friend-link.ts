/**
 * The friend link's words in the language asked for (2026-10-31). Tables:
 * `friend-link.en.ts`, `friend-link.tr.ts`; anything unknown is English.
 */
import { normaliseLang, type Lang } from "./lang";
import { friendLinkEn, type FriendLinkStrings } from "./friend-link.en";
import { friendLinkTr } from "./friend-link.tr";

export type { FriendLinkStrings };

export const FRIEND_LINK_TABLES: Readonly<Record<Lang, FriendLinkStrings>> = { en: friendLinkEn, tr: friendLinkTr };

export function friendLinkCopy(lang: Lang | string | null | undefined): FriendLinkStrings {
  return FRIEND_LINK_TABLES[normaliseLang(lang)];
}

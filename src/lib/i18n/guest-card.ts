/**
 * Bringing a guest by contact card, in the language asked for (2026-11-17).
 * Tables: `guest-card.en.ts`, `guest-card.tr.ts`; anything unknown is English.
 */
import { normaliseLang, type Lang } from "./lang";
import { guestCardEn, type GuestCardStrings } from "./guest-card.en";
import { guestCardTr } from "./guest-card.tr";

export type { GuestCardStrings };

export const GUEST_CARD_TABLES: Readonly<Record<Lang, GuestCardStrings>> = { en: guestCardEn, tr: guestCardTr };

export function guestCardCopy(lang: Lang | string | null | undefined): GuestCardStrings {
  return GUEST_CARD_TABLES[normaliseLang(lang)];
}

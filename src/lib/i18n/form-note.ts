/**
 * A form note with its amount (Kemal, 2026-11-10): what MatchTime says when
 * it stores how much a player's rating moves for one match, so the player
 * or an organiser can change it. Never a rating, only the adjustment
 * (`form-note-rules.ts` composes the line from these pieces).
 *
 * One object per language, typed by `FormNoteCopy`, so a line missing in
 * either language is a `tsc` error. House rules (unit tested in
 * `__tests__/form-note-rules.test.ts`): no em or en dashes, no slash as a
 * separator. Turkish places the name before "için", which needs no suffix.
 */
import { normaliseLang, type Lang } from "./lang";
import { FORM_NOTE_EN } from "./form-note.en";
import { FORM_NOTE_TR } from "./form-note.tr";

export interface FormNoteCopy {
  /** One player's part: "-0.5 for Kemal (tired)". `amount` is signed. */
  amountFor: (p: { amount: string; name: string; reason: string }) => string;
  /** One player's part when the note is no adjustment (a cancel). */
  noneFor: (p: { name: string }) => string;
  /** A new note. `parts` is the players' parts joined; `day` the weekday. */
  saved: (p: { parts: string; day: string }) => string;
  /** A note changed (one was already stored for every player in it). */
  changed: (p: { parts: string; day: string }) => string;
  /** An amount past the cap was asked for and clamped. */
  capped: string;
  /** The teams are already made: it counts only if they are made again. */
  teamsMade: string;
  /** The message also spoke about somebody whose note it could not set. */
  others: string;
  /** How to change it, with an amount different from the one stated. */
  amendHint: (p: { example: string }) => string;
}

const BY_LANG: Record<Lang, FormNoteCopy> = { en: FORM_NOTE_EN, tr: FORM_NOTE_TR };

export function formNoteCopy(lang: Lang | string | null | undefined): FormNoteCopy {
  return BY_LANG[normaliseLang(lang)];
}

/**
 * How the admin roster pages label a player row (2026-10-23).
 *
 * Prod, MT Test: a partner guest with `User.name` NULL. `/api/players`
 * hides a guest's email (null, by design), so the page's
 * `(p.name ?? p.email).charAt(0)` threw in the browser and the whole
 * players page showed "This page couldn't load".
 *
 * Client-safe (no db import), unlike `player-display-name.ts`.
 */
import { t } from "./i18n/t";
import type { Lang } from "./i18n/lang";

export interface AdminPlayerLabelFacts {
  name: string | null | undefined;
  /** Null for a partner club's guest: his email is never sent. */
  email: string | null | undefined;
  /** A partner guest's home club name, else null/absent. */
  guestFrom?: string | null;
}

function clean(v: string | null | undefined): string {
  return (v ?? "").trim();
}

/** The row's readable label: name, else "Guest from <club>" for a guest,
 *  else the email, else the club language's "(unnamed)". Never empty. */
export function adminPlayerLabel(p: AdminPlayerLabelFacts, lang?: Lang | string | null): string {
  const name = clean(p.name);
  if (name) return name;
  const club = clean(p.guestFrom);
  if (club) return t(lang).xask_guest_badge({ club });
  const email = clean(p.email);
  if (email) return email;
  return t(lang).unnamed;
}

/** The avatar letter: the name's or the email's first character, else "?". */
export function adminPlayerInitial(p: AdminPlayerLabelFacts): string {
  const src = clean(p.name) || clean(p.email);
  return src ? src.charAt(0).toUpperCase() : "?";
}

/** Roster search: does the (already lower-cased) query hit the name or email? */
export function adminPlayerMatches(p: AdminPlayerLabelFacts, q: string): boolean {
  return clean(p.name).toLowerCase().includes(q) || clean(p.email).toLowerCase().includes(q);
}

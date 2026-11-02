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
import { formatPhoneForDisplay } from "./phone";
import { isPlaceholderEmail } from "./cross-club-link-rules";
import { phoneFromPlaceholderEmail } from "./own-phone-rules";

export interface AdminPlayerLabelFacts {
  name: string | null | undefined;
  /** Null for a partner club's guest: his email is never sent. */
  email: string | null | undefined;
  /** A partner guest's home club name, else null/absent. */
  guestFrom?: string | null;
  /** E.164. Null for any guest: `/api/players` never sends a guest's phone. */
  phoneNumber?: string | null;
}

function clean(v: string | null | undefined): string {
  return (v ?? "").trim();
}

/** A real address, never one MatchTime minted (`wa-sync+…@matchtime.local`,
 *  `phone+…@matchtime.local`, `wa-<digits>@placeholder.matchtime`). */
function realEmail(p: AdminPlayerLabelFacts): string {
  const email = clean(p.email);
  return email && !isPlaceholderEmail(email) ? email : "";
}

/** The phone to show: the stored one, else the number a
 *  `wa-<digits>@placeholder.matchtime` email encodes. */
function phoneOf(p: AdminPlayerLabelFacts): string {
  return clean(p.phoneNumber) || phoneFromPlaceholderEmail(p.email) || "";
}

/** The row's readable label (2026-11-02): name, else "Guest from <club>"
 *  for a guest, else the phone (a WhatsApp-imported member has a phone but
 *  no name until he posts), else a real email, else the club language's
 *  "(unnamed)". A placeholder email is never shown. Never empty. */
export function adminPlayerLabel(p: AdminPlayerLabelFacts, lang?: Lang | string | null): string {
  const name = clean(p.name);
  if (name) return name;
  const club = clean(p.guestFrom);
  if (club) return t(lang).xask_guest_badge({ club });
  const phone = phoneOf(p);
  if (phone) return formatPhoneForDisplay(phone);
  const email = realEmail(p);
  if (email) return email;
  return t(lang).unnamed;
}

/** The avatar letter: the name's or a real email's first character, else "?".
 *  Never a placeholder email's ("w" for every imported member). */
export function adminPlayerInitial(p: AdminPlayerLabelFacts): string {
  const src = clean(p.name) || realEmail(p);
  return src ? src.charAt(0).toUpperCase() : "?";
}

/** Roster search: does the (already lower-cased) query hit the name, a real
 *  email (never a placeholder) or the phone's digits ("7700 900", "+44 7700" and "07700" style
 *  queries all compare digits only)? */
export function adminPlayerMatches(p: AdminPlayerLabelFacts, q: string): boolean {
  if (clean(p.name).toLowerCase().includes(q) || realEmail(p).toLowerCase().includes(q)) return true;
  const qDigits = q.replace(/\D/g, "");
  if (!qDigits) return false;
  const phoneDigits = phoneOf(p).replace(/\D/g, "");
  if (!phoneDigits) return false;
  if (phoneDigits.includes(qDigits)) return true;
  // A UK local "07700…" query against a stored "+447700…".
  return qDigits.startsWith("0") && phoneDigits.startsWith("44") && phoneDigits.slice(2).includes(qDigits.slice(1));
}

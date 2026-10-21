/**
 * THE ASK REFERENCE A VOLUNTEER SENDS MATCHTIME PRIVATELY (cross-club ask,
 * Kemal 2026-10-21). Pure: no database, no clock, no model.
 *
 * Volunteering must not add noise to the partner club's group, so the ask
 * posted there carries a tap-to-DM link to MatchTime's own number. The
 * link opens WhatsApp with a prefilled "IN (ref K7Q2)" (Turkish
 * "VARIM (ref K7Q2)"). K7Q2 is a code MatchTime derived from the ask's id:
 * a pointer the code issued, read back as structured data, the same way
 * the connect DM reads its code (`connect-dm-rules.ts`). It says WHICH ask
 * the DM is about; whether he is IN or OUT is still the DM resolver's
 * decision (`resolveDmSelfAttendance`), on his text with the reference
 * taken out. Nothing here reads a player's words.
 *
 * The code is derived, not stored: four characters of the connect
 * alphabet from a hash of the ask id (923,521 values). It is matched only
 * against the few asks posted in the last fortnight, so two of them
 * sharing a code is vanishingly rare; if they ever do, the DM is treated
 * as carrying no code (`partner-guest-dm.ts`), never guessed.
 */
import { createHash } from "node:crypto";
import { CONNECT_CODE_ALPHABET, waMeLink } from "./club-connect-rules";
import { t } from "./i18n/t";
import type { Lang } from "./i18n/lang";

/** The ask's four-character reference. Stable for the same id. */
export function askRefCode(askId: string): string {
  const digest = createHash("sha256").update(`xask-ref:${askId}`).digest();
  let n = digest.readUInt32BE(0);
  let code = "";
  for (let i = 0; i < 4; i++) {
    code += CONNECT_CODE_ALPHABET[n % CONNECT_CODE_ALPHABET.length];
    n = Math.floor(n / CONNECT_CODE_ALPHABET.length);
  }
  return code;
}

const CODE_CHARS = CONNECT_CODE_ALPHABET.replace(/[A-Z]/g, (c) => c + c.toLowerCase());
/** "ref", any punctuation or spacing, then four characters of the code
 *  alphabet standing alone. Case does not matter. */
const REF_SOURCE = `(?<![\\p{L}\\p{N}])ref(?![\\p{L}\\p{N}])[^\\p{L}\\p{N}]*([${CODE_CHARS}]{4})(?![\\p{L}\\p{N}])`;

/** Every code after "ref", uppercased, last first (the prefill ends with
 *  it), no repeats. The caller takes one that names a real ask. */
export function askRefCandidates(text: string | null | undefined): string[] {
  if (typeof text !== "string" || text.length === 0 || text.length > 500) return [];
  const found = [...text.matchAll(new RegExp(REF_SOURCE, "giu"))].map((m) => m[1].toUpperCase());
  const out: string[] = [];
  for (const c of found.reverse()) if (!out.includes(c)) out.push(c);
  return out;
}

/** His text without the reference MatchTime issued (and the brackets
 *  around it), for the resolver to read. */
export function stripAskRef(text: string): string {
  return text
    .replace(new RegExp(`\\(\\s*${REF_SOURCE}\\s*\\)`, "giu"), " ")
    .replace(new RegExp(REF_SOURCE, "giu"), " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The prefilled DM, in the partner club's language. */
export function askDmPrefill(lang: Lang | string | null | undefined, ref: string): string {
  return t(lang).xask_dm_prefill({ ref });
}

/** The tap-to-DM link, or null when MatchTime's number is not configured
 *  (the copy then tells him what to send instead). */
export function askDmLink(p: { number: string | null; lang: Lang | string | null | undefined; askId: string }): string | null {
  if (!p.number) return null;
  return waMeLink(p.number, askDmPrefill(p.lang, askRefCode(p.askId)));
}

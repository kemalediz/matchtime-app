/**
 * A PLAYER'S OWN NUMBER IS NEVER WIPED BY A FORM (2026-10-18, FNF).
 *
 * `completeOnboarding` (/welcome) and `updateProfile` (/profile) used to
 * write `phoneNumber: parsed.phoneNumber || null`, and the phone field is
 * optional. A WhatsApp-created player who already had a number (FNF's
 * Feroz) left it blank, his stored number became NULL, and he could no
 * longer sign in by WhatsApp code or receive any DM.
 *
 * The rule, pure, in one place:
 *
 *   - blank or omitted never touches the stored number;
 *   - a stored number is the number this person signs in with
 *     (`verifyPhoneSignIn` finds the user by `User.phoneNumber`, and it is
 *     the only sign-in the product shows), so a form cannot change it.
 *     There is no verify-the-new-number flow, and changing a sign-in
 *     number without proving the new one would lock the person out or
 *     hand their DMs to a stranger. The same number in another spelling
 *     is a no-op;
 *   - with no stored number, a valid number may be added. The caller
 *     still checks nobody else holds it (the uniqueness rule from
 *     player-account-guard.ts: a refusal names nobody).
 *
 * Pure: no database, so the script and both actions share it.
 */
import { normalisePhone } from "./phone";

export type OwnPhoneRefusal = "invalid" | "locked" | "taken";

export type OwnPhoneDecision =
  | { kind: "keep" }
  | { kind: "set"; phone: string }
  | { kind: "refuse"; reason: Exclude<OwnPhoneRefusal, "taken"> };

export function decideOwnPhoneWrite(args: {
  current: string | null | undefined;
  submitted: string | null | undefined;
}): OwnPhoneDecision {
  const raw = (args.submitted ?? "").trim();
  if (!raw) return { kind: "keep" };
  const next = normalisePhone(raw);
  const current = args.current ? normalisePhone(args.current) ?? args.current : null;
  if (current) {
    return next === current ? { kind: "keep" } : { kind: "refuse", reason: "locked" };
  }
  if (!next) return { kind: "refuse", reason: "invalid" };
  return { kind: "set", phone: next };
}

/** The synthetic address the bot gives a player it met in a group. */
const WA_PLACEHOLDER = /^wa-(\d+)@placeholder\.matchtime$/i;

/** The E.164 number encoded in a `wa-<digits>@placeholder.matchtime` email, or null. */
export function phoneFromPlaceholderEmail(email: string | null | undefined): string | null {
  const m = WA_PLACEHOLDER.exec((email ?? "").trim());
  if (!m) return null;
  return normalisePhone(`+${m[1]}`);
}

export type RestoreDecision =
  | { kind: "restore"; phone: string }
  | { kind: "skip"; reason: "has-phone" | "no-placeholder-number" | "held-by-other" };

/**
 * scripts/restore-phone-from-placeholder.ts: may this user's number be put
 * back from their placeholder email? Only when it is NULL now, the email
 * encodes a valid E.164 number, and no other user holds that number.
 * `holderId` is the id of whoever holds the derived number today, if anyone.
 */
export function decidePhoneRestore(args: {
  user: { id: string; email: string | null; phoneNumber: string | null };
  holderId: string | null;
}): RestoreDecision {
  if (args.user.phoneNumber) return { kind: "skip", reason: "has-phone" };
  const phone = phoneFromPlaceholderEmail(args.user.email);
  if (!phone) return { kind: "skip", reason: "no-placeholder-number" };
  if (args.holderId && args.holderId !== args.user.id) return { kind: "skip", reason: "held-by-other" };
  return { kind: "restore", phone };
}

/** "+447700900003" to "+44*******003": enough to recognise, not to dial. */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/^\+/, "");
  if (digits.length <= 5) return "+" + "*".repeat(digits.length);
  return "+" + digits.slice(0, 2) + "*".repeat(digits.length - 5) + digits.slice(-3);
}

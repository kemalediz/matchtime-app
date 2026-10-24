/**
 * CONFIRMING A /play SIGN-UP ON WHATSAPP: the PURE rules (slice L2,
 * 2026-10-24). No database, no clock of its own, NO MODEL.
 *
 * The /play form ends by opening WhatsApp with a prefilled message, "Hi
 * MatchTime, sign me up to play. Code K7QP" (Turkish: "Merhaba MatchTime,
 * oynamak için kaydet. Kod K7QP"). The person's own message is what makes
 * the profile live: it proves the number, and MatchTime never messages
 * anyone first. `confirm.ts` is the thin I/O adapter that runs this at the
 * top of the DM route.
 *
 * READING THE CODE is a token lookup, never reading what someone means:
 * the five characters after "code" or "kod". The self-join connect code is
 * FOUR characters after the same words (`connect-dm-rules.ts`), so the two
 * readers can never take each other's code: a bare "Code 7KQ2" is the
 * connect handler's, never the pool's.
 * A code that names a waiting sign-up confirms it, whatever words surround
 * it. Only a code that names NOTHING looks at the words, and only to
 * decide whether the "that code did not work" reply is owed: the text must
 * be our own prefilled message (or the code phrase alone) with the code
 * taken out, so a member asking "what's the code then?" is never answered
 * about the pool.
 */
import { randomInt } from "node:crypto";
import { t } from "../i18n/t";
import { LANGS, type Lang } from "../i18n/lang";
import { POOL_CONFIRM, POOL_CONFIRM_CODE_ALPHABET, POOL_CONFIRM_CODE_LENGTH } from "./rules";

const DAY_MS = 24 * 60 * 60 * 1000;

// ── The code ───────────────────────────────────────────────────────────

/** A fresh code from the pool's alphabet. `rand` is injectable for tests. */
export function generatePoolConfirmCode(rand: (max: number) => number = randomInt): string {
  let code = "";
  for (let i = 0; i < POOL_CONFIRM_CODE_LENGTH; i++) code += POOL_CONFIRM_CODE_ALPHABET[rand(POOL_CONFIRM_CODE_ALPHABET.length)];
  return code;
}

/** When a code issued at `now` stops working. */
export function poolCodeExpiry(now: Date): Date {
  return new Date(now.getTime() + POOL_CONFIRM.codeTtlDays * DAY_MS);
}

/** The message WhatsApp opens with, in the sign-up's language. */
export function poolConfirmPrefill(lang: Lang, code: string): string {
  return t(lang).pool_confirm_prefill({ code });
}

const CODE_CHARS = POOL_CONFIRM_CODE_ALPHABET.replace(/[A-Z]/g, (c) => c + c.toLowerCase());
/** "code" or "kod" (also "kodu", "kodum"), any punctuation or spacing, then
 *  exactly POOL_CONFIRM_CODE_LENGTH code characters standing alone. */
const CODE_RE = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:code|kodum|kodu|kod)(?![\\p{L}\\p{N}])[^\\p{L}\\p{N}]*([${CODE_CHARS}]{${POOL_CONFIRM_CODE_LENGTH}})(?![\\p{L}\\p{N}])`,
  "giu",
);

/**
 * Every pool-code-shaped token after "code" or "kod", last first (the
 * prefilled text ends with the code), no repeats. The self-join connect
 * message ("Connect Riverside FC, code 7KQ2") carries a FOUR-character code,
 * so it gives nothing here: the length alone keeps the two apart.
 */
export function poolCodeCandidates(text: string | null | undefined): string[] {
  if (typeof text !== "string" || text.length === 0 || text.length > 500) return [];
  const out: string[] = [];
  for (const m of [...text.matchAll(CODE_RE)].reverse()) {
    const c = m[1].toUpperCase();
    if (!out.includes(c)) out.push(c);
  }
  return out;
}

const squash = (s: string) =>
  s
    .toLocaleLowerCase("tr")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ı/g, "i")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** Our prefilled text in every language, squashed, with the code removed. */
const PREFILLS: ReadonlyArray<{ lang: Lang; text: string }> = LANGS.map((lang) => ({ lang, text: squash(poolConfirmPrefill(lang, "")) }));
const CODE_WORDS: Readonly<Record<string, Lang>> = { code: "en", kod: "tr", kodu: "tr", kodum: "tr" };

/**
 * Is this our own confirm message (edited only in case, spacing or
 * punctuation), or just the code phrase ("Code K7QP")? Its language when it
 * is; null when it is not. Used ONLY for a code that names no sign-up:
 * whether it earns a reply, and in which language.
 */
export function readPoolConfirmMessage(text: string | null | undefined): { lang: Lang } | null {
  const candidates = poolCodeCandidates(text);
  if (candidates.length === 0) return null;
  let rest = squash(text as string);
  for (const c of candidates) rest = rest.replace(new RegExp(`(^| )${c.toLowerCase()}( |$)`, "g"), " ").trim();
  rest = rest.replace(/\s+/g, " ");
  const prefill = PREFILLS.find((p) => p.text === rest);
  if (prefill) return { lang: prefill.lang };
  const word = CODE_WORDS[rest];
  return word ? { lang: word } : null;
}

export function looksLikePoolConfirm(text: string | null | undefined): boolean {
  return readPoolConfirmMessage(text) !== null;
}

// ── The decision ───────────────────────────────────────────────────────

/** The waiting sign-up a code named, as the rule reads it. */
export interface PendingRow {
  expiresAt: Date | null;
}

/** The sender's own profile, when the sending number already has one. */
export type SenderProfile = { status: "active" | "paused" | "stopped" } | null;

export type PoolConfirmDecision =
  /** Make the waiting sign-up live for this number. */
  | { action: "confirm" }
  /** He has a profile already (of any status): it stays his, the waiting
   *  sign-up is NOT attached (a code belongs to the sign-up that made it),
   *  he is told how to manage his own, and the attempt counts. */
  | { action: "already-signed-up"; status: "active" | "paused" | "stopped" }
  /** Record a failed attempt, and reply if `codeReplyAllowed` says so. */
  | { action: "failed"; reply: "expired" | "wrong-code" }
  /** Nothing is sent and nothing below in the DM route reads it. */
  | { action: "ignore"; reason: "no-phone" | "locked" | "already-in-pool" }
  /** Not the pool's: the DM goes on exactly as before. */
  | { action: "pass" };

/**
 * What one DM carrying a pool code does. In this order:
 *   not our message and no sign-up named   not the pool's
 *   no phone (a LID alone)                 nothing recorded, nothing sent
 *   his own spent code again               silent, not counted (he was
 *                                          welcomed once; not a guess)
 *   too many failures in 24 hours          locked, for EVERYONE, a right
 *                                          code too
 *   no sign-up named                       failed: wrong code (counted for
 *                                          strangers and members alike, so
 *                                          nobody can guess for free)
 *   expired                                failed: expired
 *   he has a profile already               already-signed-up (counted)
 *   otherwise                              confirm
 */
export function decidePoolConfirm(args: {
  row: PendingRow | null;
  hasPhone: boolean;
  sender: SenderProfile;
  /** The code is one that once confirmed the sender's own profile. */
  ownCode: boolean;
  failuresToday: number;
  looksLikeConfirm: boolean;
  now: Date;
}): PoolConfirmDecision {
  const { row, sender, now } = args;
  if (!row && !args.looksLikeConfirm) return { action: "pass" };
  if (!args.hasPhone) return { action: "ignore", reason: "no-phone" };
  if (!row && args.ownCode && sender) return { action: "ignore", reason: "already-in-pool" };
  if (args.failuresToday >= POOL_CONFIRM.wrongCodesPerDay) return { action: "ignore", reason: "locked" };
  if (!row) return { action: "failed", reply: "wrong-code" };
  if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) return { action: "failed", reply: "expired" };
  if (sender) return { action: "already-signed-up", status: sender.status };
  return { action: "confirm" };
}

/**
 * May a "that code did not work" reply go to this number now? `sentAt`:
 * when the earlier ones went (any order). At most one per
 * `replyThrottleMins` and `repliesPerDay` in 24 hours, so a flood of codes
 * costs one message.
 */
export function codeReplyAllowed(sentAt: readonly Date[], now: Date): boolean {
  const t0 = now.getTime();
  const lastDay = sentAt.filter((d) => t0 - d.getTime() < DAY_MS);
  if (lastDay.length >= POOL_CONFIRM.repliesPerDay) return false;
  return !lastDay.some((d) => t0 - d.getTime() < POOL_CONFIRM.replyThrottleMins * 60_000);
}

/** The window the two counts above look back over. */
export function confirmWindowStart(now: Date): Date {
  return new Date(now.getTime() - DAY_MS);
}

/** Failed attempts older than this are deleted. */
export function attemptPurgeBefore(now: Date): Date {
  return new Date(now.getTime() - POOL_CONFIRM.attemptKeepDays * DAY_MS);
}

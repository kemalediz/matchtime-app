/**
 * Environment for the Baileys entry point, plus the pairing decision.
 * Pure: the env is passed in, so every branch is testable.
 *
 * ── Where the session lives, and why it matters ─────────────────────
 * `.wwebjs_auth/` is a Chromium user-data directory. `.baileys_auth/` is a
 * set of Signal protocol keys in JSON, written by `useMultiFileAuthState`.
 * They are different artefacts, they are not convertible, and WhatsApp
 * treats them as two separate linked devices. So the two directories sit
 * side by side and neither knows about the other.
 *
 * Expect the Baileys one to be large and file-heavy: HomeTenant's is about
 * 11 MB across 2,832 files, mostly pre-keys and LID mappings that arrived
 * from the pairing-time app-state sync. It is created `mode 0700` and it
 * must never be deleted by a deploy script.
 *
 * ── Pairing, and the reason it is rationed to once ──────────────────
 * A crash loop that calls `requestPairingCode` hammers WhatsApp's pairing
 * endpoint from one number, and losing the bot's number is far worse than
 * being down for an hour (`MDs/whatsapp-outage-2026-09-16-runbook.md` §5).
 * `decidePairingAction` returns `"none"` on any repeat, so one socket asks
 * exactly once; a fresh socket gets a fresh code, which is what we want
 * because codes expire in a minute or two.
 *
 * `normalisePairPhone` rejects anything too short to be a phone rather
 * than passing it to WhatsApp to find out.
 */
import { isAbsolute, resolve } from "node:path";
import { LEVELS, type LogLevel } from "./logging.js";

export interface BaileysConfig {
  /** Absolute path to the multi-file auth state. */
  authDir: string;
  /** How loud Baileys itself is allowed to be. */
  logLevel: LogLevel;
  /** Digits only, or "" for the QR route. */
  pairPhone: string;
  /**
   * Phase 1 sends nothing, starts no scheduler and calls no server. This
   * is a value rather than a comment so the guard is something a reader
   * can find, and so the day it becomes false is a visible change.
   */
  observeOnly: true;
}

function clean(v: string | undefined): string {
  return typeof v === "string" ? v.trim() : "";
}

export function resolveBaileysConfig(
  env: Record<string, string | undefined>,
  botDir: string,
): BaileysConfig {
  const override = clean(env.BAILEYS_AUTH_DIR);
  const authDir = override
    ? isAbsolute(override)
      ? override
      : resolve(botDir, override)
    : resolve(botDir, ".baileys_auth");

  const wanted = clean(env.WA_BAILEYS_LOG_LEVEL).toLowerCase();
  const logLevel = (LEVELS as readonly string[]).includes(wanted) ? (wanted as LogLevel) : "warn";

  return {
    authDir,
    logLevel,
    pairPhone: normalisePairPhone(env.WA_PAIR_PHONE ?? env.PAIR_PHONE),
    observeOnly: true,
  };
}

/** One line for the startup log, so the journal says what was configured. */
export function describeBaileysConfig(c: BaileysConfig): string {
  return (
    `Baileys session: ${c.authDir} | log level ${c.logLevel} | ` +
    `login ${c.pairPhone ? `pairing code for ${c.pairPhone}` : "QR"} | ` +
    `mode: OBSERVE-ONLY (no sends, no scheduler, no server calls)`
  );
}

/**
 * Digits only, or "" when there is no usable number.
 *
 * Shorter than six digits is not a phone number and must not be handed to
 * WhatsApp's pairing endpoint to find out.
 */
export function normalisePairPhone(v: string | undefined): string {
  const digits = clean(v).replace(/\D/g, "");
  return /^\d{6,15}$/.test(digits) ? digits : "";
}

export type PairingAction = "show-qr" | "request-code" | "none";

/**
 * What to do with the `qr` field on a `connection.update`.
 *
 * Baileys emits it repeatedly while unpaired. With a pair phone set we ask
 * for a code once per socket and ignore the rest; without one we print the
 * QR every time, because a QR does expire and reprinting is harmless.
 */
export function decidePairingAction(opts: {
  pairPhone: string;
  codeRequested: boolean;
}): PairingAction {
  if (!opts.pairPhone) return "show-qr";
  return opts.codeRequested ? "none" : "request-code";
}

/** Impossible to miss while scrolling a journal. */
export function pairingCodeBanner(phone: string, code: string): string {
  const bar = "=".repeat(52);
  return [
    "",
    bar,
    `  PAIRING CODE for ${phone}: ${code}`,
    "  WhatsApp > Settings > Linked devices > Link with phone number",
    "  Codes expire within a couple of minutes; a restart issues a new one.",
    bar,
    "",
  ].join("\n");
}

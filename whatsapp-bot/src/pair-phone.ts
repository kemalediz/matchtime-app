/**
 * Mobile-friendly WhatsApp login: pairing codes instead of a QR code.
 *
 * ── Why (2026-08-29) ─────────────────────────────────────────────────
 * The bot could only authenticate by scanning an ASCII-art QR code printed
 * to `~/matchtime-bot/bot.log`. Re-pairing therefore needed a screen showing
 * that log AND the burner phone in hand at the same time. The owner is
 * frequently on mobile only, so whenever the session dropped the bot stayed
 * logged out and the whole product was dead.
 *
 * That stopped being a rare event: since the whatsapp-web.js injected-code
 * breakage (see MDs/SESSION-HANDOFF-2026-08-27.md §"the QR outage" and
 * MDs/whatsapp-web-version-pinning.md) the session has been dropping on
 * restarts, so re-pairing is a recurring operation. It has to be doable from
 * a phone alone.
 *
 * WhatsApp's "Link with phone number instead" flow solves this: WhatsApp Web
 * hands out an 8-character code, you type it into the burner phone, done. No
 * camera, no second screen. whatsapp-web.js@1.34.6 supports it.
 *
 * ── Env vars ─────────────────────────────────────────────────────────
 *   WA_PAIR_PHONE          The BOT's own WhatsApp number in international
 *                          format, digits only, no '+' (e.g. 447700900123).
 *                          NOT the admin's number. Unset → QR only, exactly
 *                          as before.
 *   WA_PAIR_INTERVAL_SEC   How often a fresh code is generated. Default 180
 *                          (WhatsApp's own expiry). Clamped to 30..3600.
 *   WA_PAIR_NOTIFY         "0"/"false" to suppress the push notification
 *                          WhatsApp sends to the burner phone. Default on.
 *
 * ── Design notes ─────────────────────────────────────────────────────
 * We use the `pairWithPhoneNumber` CONSTRUCTOR option rather than calling
 * `client.requestPairingCode()` by hand. Reasons, all verified against
 * node_modules/whatsapp-web.js/src/Client.js:
 *
 *  - The library only enters the pairing branch inside `if (needAuthentication)`
 *    (Client.js:141), i.e. when AppState is UNPAIRED / UNPAIRED_IDLE. A good
 *    existing session is untouched — setting this var does NOT force a
 *    re-pair.
 *  - The library owns the refresh loop (Client.js:394 `requestPairingCode`
 *    sets a `setInterval` that stops as soon as the state leaves UNPAIRED),
 *    so a lapsed code is replaced automatically.
 *  - `requestPairingCode()` called by hand from our own `qr` handler would
 *    throw: it calls `window.onCodeReceivedEvent`, which the library only
 *    exposes on the page inside the pairing branch (Client.js:162).
 *
 * TRADE-OFF, be aware: the library treats QR and pairing code as mutually
 * exclusive (Client.js:161 `if (pairWithPhoneNumber.phoneNumber) … else …`
 * registers the QR listener only in the else). So while WA_PAIR_PHONE is
 * set, NO QR is printed. To get the laptop/QR route back, unset the var and
 * redeploy. With the var unset, nothing here changes anything at all.
 *
 * Everything in this module is pure and takes its env explicitly, so it is
 * unit-testable and cannot take the bot down at startup.
 */

/** WhatsApp's own pairing-code lifetime, and the library default. */
export const DEFAULT_PAIRING_INTERVAL_MS = 180_000;

/** Bounds for WA_PAIR_INTERVAL_SEC. Outside these we keep the default. */
export const MIN_PAIRING_INTERVAL_SEC = 30;
export const MAX_PAIRING_INTERVAL_SEC = 3600;

/**
 * The one distinctive token that makes the code greppable over SSH:
 *
 *   grep WA_PAIRING_CODE ~/matchtime-bot/bot.log | tail -1
 */
export const PAIRING_CODE_LOG_PREFIX = "WA_PAIRING_CODE:";

/**
 * The same token WITHOUT the trailing colon, for use in prose (the startup
 * one-liner, the banner's own grep hint). Prose must not carry the exact
 * prefix, or `grep 'WA_PAIRING_CODE:'` returns those lines too and the
 * "newest code" one-liner stops being trustworthy.
 */
const PAIRING_CODE_GREP_HINT = PAIRING_CODE_LOG_PREFIX.replace(":", "");

const MIN_DIGITS = 10;
const MAX_DIGITS = 15; // E.164 maximum

export type PairPhoneResult =
  | { ok: true; phoneNumber: string }
  | { ok: false; configured: boolean; reason: string };

/**
 * Validate and normalise WA_PAIR_PHONE into the digits-only international
 * form WhatsApp wants (country code first, no '+', no leading zeros).
 *
 * Separators humans naturally type — a leading '+', spaces, dashes, dots,
 * brackets — are stripped. Anything else is rejected rather than guessed at:
 * a wrong number here means the pairing notification goes to a stranger.
 */
export function normalisePairPhone(raw: string | undefined | null): PairPhoneResult {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (trimmed.length === 0) {
    return { ok: false, configured: false, reason: "not set" };
  }

  // A single leading '+' is a legitimate international marker; anywhere else
  // it is a typo.
  const body = trimmed.startsWith("+") ? trimmed.slice(1) : trimmed;
  const stripped = body.replace(/[\s\-.()]/g, "");

  if (stripped.length === 0) {
    return { ok: false, configured: true, reason: "contains no digits" };
  }
  if (!/^[0-9]+$/.test(stripped)) {
    return {
      ok: false,
      configured: true,
      reason:
        "must be digits only after stripping '+', spaces, dashes, dots and brackets",
    };
  }
  if (stripped.startsWith("00")) {
    return {
      ok: false,
      configured: true,
      reason:
        "starts with the 00 international dialling prefix — drop it and start with the bare country code (44…, not 0044…)",
    };
  }
  if (stripped.startsWith("0")) {
    return {
      ok: false,
      configured: true,
      reason:
        "starts with a national trunk 0 — the country code is required (447700900123, not 07700900123)",
    };
  }
  if (stripped.length < MIN_DIGITS || stripped.length > MAX_DIGITS) {
    return {
      ok: false,
      configured: true,
      reason: `has ${stripped.length} digits; expected ${MIN_DIGITS}-${MAX_DIGITS}`,
    };
  }

  return { ok: true, phoneNumber: stripped };
}

/** The subset of whatsapp-web.js ClientOptions this module controls. */
export interface PairingClientOptions {
  pairWithPhoneNumber?: {
    phoneNumber: string;
    showNotification: boolean;
    intervalMs: number;
  };
}

export interface PairingDecision {
  /** "qr" = unchanged legacy behaviour. "pairing-code" = phone-number login. */
  mode: "qr" | "pairing-code";
  /** Spread straight into `new Client({...})`. `{}` when mode is "qr". */
  clientOptions: PairingClientOptions;
  /** Present only when the operator configured something broken. */
  criticalLog?: string;
  /** Echoed into the banner so the log states the real expiry. */
  intervalMs: number;
  /** Kept for the startup one-liner; never the full number. */
  maskedPhone?: string;
}

function resolveIntervalMs(raw: string | undefined): number {
  const n = Number.parseInt((raw ?? "").trim(), 10);
  if (!Number.isFinite(n)) return DEFAULT_PAIRING_INTERVAL_MS;
  if (n < MIN_PAIRING_INTERVAL_SEC || n > MAX_PAIRING_INTERVAL_SEC) {
    return DEFAULT_PAIRING_INTERVAL_MS;
  }
  return n * 1000;
}

function resolveNotify(raw: string | undefined): boolean {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return true;
}

/** Show only the last 4 digits — bot.log is copied around in support threads. */
function mask(phoneNumber: string): string {
  const tail = phoneNumber.slice(-4);
  return `${"*".repeat(Math.max(0, phoneNumber.length - 4))}${tail}`;
}

/**
 * Decide how the client should authenticate, from the environment alone.
 *
 * Deliberately total: every failure path degrades to plain QR, because the
 * bot must never fail to start over this feature.
 */
export function resolvePairingOptions(
  env: Record<string, string | undefined>,
): PairingDecision {
  const phone = normalisePairPhone(env.WA_PAIR_PHONE);

  if (!phone.ok) {
    if (!phone.configured) {
      // Not opted in — byte-for-byte the old behaviour.
      return { mode: "qr", clientOptions: {}, intervalMs: DEFAULT_PAIRING_INTERVAL_MS };
    }
    return {
      mode: "qr",
      clientOptions: {},
      intervalMs: DEFAULT_PAIRING_INTERVAL_MS,
      criticalLog:
        `CRITICAL: WA_PAIR_PHONE is set but unusable (${phone.reason}). ` +
        "Phone-number pairing is DISABLED and the bot has fallen back to the QR code, " +
        "which needs a screen plus the burner phone. Fix the value in " +
        "~/matchtime-bot/.env — the bot's own WhatsApp number in international format, " +
        "digits only, no '+' (e.g. 447700900123) — then redeploy with scripts/deploy-pi.sh.",
    };
  }

  const intervalMs = resolveIntervalMs(env.WA_PAIR_INTERVAL_SEC);

  return {
    mode: "pairing-code",
    intervalMs,
    maskedPhone: mask(phone.phoneNumber),
    clientOptions: {
      pairWithPhoneNumber: {
        phoneNumber: phone.phoneNumber,
        showNotification: resolveNotify(env.WA_PAIR_NOTIFY),
        intervalMs,
      },
    },
  };
}

/** Human-readable one-liner for the startup log. */
export function describePairingOptions(d: PairingDecision): string {
  if (d.mode === "qr") {
    return "WhatsApp login: QR code (scan from the log). Set WA_PAIR_PHONE to log in from a phone alone.";
  }
  return (
    `WhatsApp login: pairing code for ${d.maskedPhone}, refreshed every ` +
    `${Math.round(d.intervalMs / 1000)}s. Grep the log for '${PAIRING_CODE_GREP_HINT}'.`
  );
}

/** "ABCDEFGH" → "ABCD-EFGH", which is how WhatsApp displays it on the phone. */
function groupCode(code: string): string {
  const c = code.trim().toUpperCase();
  return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
}

/**
 * The single greppable line. Kept on ONE line, with one distinctive prefix,
 * so the whole recovery procedure over SSH is:
 *
 *   grep WA_PAIRING_CODE ~/matchtime-bot/bot.log | tail -1
 */
export function pairingCodeLogLine(code: string): string {
  return `${PAIRING_CODE_LOG_PREFIX} ${groupCode(code)}`;
}

/**
 * The unmissable banner around that line. Exactly one line inside carries
 * PAIRING_CODE_LOG_PREFIX so the grep above returns one result per code.
 */
export function formatPairingCodeBanner(
  code: string,
  intervalMs: number = DEFAULT_PAIRING_INTERVAL_MS,
): string {
  const secs = Math.round(intervalMs / 1000);
  const rule = "=".repeat(64);
  return [
    "",
    rule,
    ` ${pairingCodeLogLine(code)}`,
    "",
    " On the burner phone: WhatsApp > Linked devices > Link a device >",
    ' "Link with phone number instead", then type the code above.',
    "",
    ` Expires in ~${secs}s; a fresh one is printed automatically if it lapses.`,
    ` Grep the newest:  grep ${PAIRING_CODE_GREP_HINT} ~/matchtime-bot/bot.log | tail -1`,
    rule,
    "",
  ].join("\n");
}

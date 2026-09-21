/**
 * What to do when the Baileys socket closes. Pure, so it can be tested
 * without opening one.
 *
 * ── The difference from whatsapp-web.js ─────────────────────────────
 * whatsapp-web.js owns its own reconnection. Baileys does not: a closed
 * socket is normal, and the caller is expected to make a new one. Network
 * blips, WhatsApp-side restarts and a deliberate `515` straight after
 * pairing all arrive here. Today's bot has no policy at all: it stops its
 * timers on `disconnected` and waits for a human or for systemd.
 *
 * ── Exit rather than retry, on anything fatal ───────────────────────
 * A `process.exit(1)` shows up in `systemctl status` and in the journal.
 * An internal retry loop that can never succeed is invisible, and on
 * 2026-08-30 an invisible failure cost a paying customer three days of
 * attendance. So: reconnect what is worth reconnecting, and exit loudly
 * for everything else, with a sentence that says what the operator has to
 * do.
 *
 * ── Two rules that are never broken ─────────────────────────────────
 * We never call `logout()` and we never delete the auth folder, whatever
 * the status code. `logout()` unlinks the device; deleting the folder
 * destroys the Signal keys. Either costs a re-pair, which needs a human
 * with the phone in hand. The tests assert that no message here even
 * SUGGESTS deleting the session, because a runbook line written in a panic
 * is how sessions get destroyed.
 */

/** Consecutive failed reconnects before we hand over to systemd. */
export const MAX_RECONNECT_FAILURES = 10;

/** The backoff ceiling. Beyond a minute the bot is simply missing. */
export const MAX_RECONNECT_DELAY_MS = 60_000;

export type CloseDecision =
  | { action: "reconnect"; delayMs: number }
  | { action: "exit"; code: 1; reason: string };

/**
 * Status codes there is no point reconnecting on, and what each one means
 * for whoever is reading the journal.
 *
 * These are Baileys' `DisconnectReason` values. They are written out as
 * numbers rather than imported so this module stays dependency-free.
 */
const FATAL: Record<number, string> = {
  401:
    "logged out: the bot's phone no longer lists this linked device. Re-pair it " +
    "(MDs/baileys-migration-plan-2026-09-21.md, Phase 6). The auth folder is left exactly as it is.",
  403: "forbidden: WhatsApp refused this session outright.",
  411: "multi-device mismatch: WhatsApp refused this session.",
  440:
    "connection replaced: another process is connected with this same session. Find the " +
    "duplicate before restarting. Two live bots is how a customer group got 30 copies of " +
    "the same message on 2026-07-19. Use scripts/deploy-pi.sh, never a bare systemctl restart.",
  500: "bad session: the stored session could not be used. Re-pair if this repeats.",
};

/** WhatsApp asks for a reconnect immediately after pairing. Not a failure. */
const RESTART_REQUIRED = 515;

export function decideOnClose(
  statusCode: number | undefined,
  consecutiveFailures: number,
): CloseDecision {
  // A named cause beats a failure count: it tells the operator what to do.
  const fatal = statusCode !== undefined ? FATAL[statusCode] : undefined;
  if (fatal) return { action: "exit", code: 1, reason: `${fatal} (status ${statusCode})` };

  if (consecutiveFailures >= MAX_RECONNECT_FAILURES) {
    return {
      action: "exit",
      code: 1,
      reason:
        `${consecutiveFailures} reconnects in a row without a working connection ` +
        `(last status ${statusCode ?? "unknown"}). Exiting so systemd restarts the bot rather ` +
        `than flapping silently.`,
    };
  }

  if (statusCode === RESTART_REQUIRED) return { action: "reconnect", delayMs: 0 };

  return {
    action: "reconnect",
    delayMs: Math.min(1000 * 2 ** consecutiveFailures, MAX_RECONNECT_DELAY_MS),
  };
}

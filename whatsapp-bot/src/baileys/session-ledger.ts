/**
 * What a Baileys session must remember across restarts, beyond its keys.
 *
 * ── The pairing-code budget ─────────────────────────────────────────
 * `requestPairingCode` asks WhatsApp's pairing endpoint for a code for the
 * bot's own number. A loop that does it on every socket hammers that
 * endpoint from one number, and losing the number is far worse than being
 * down for an hour (`MDs/whatsapp-outage-2026-09-16-runbook.md` §5).
 *
 * Phase 1's rule, once per socket, bounds one socket. It does not bound a
 * process: an unpaired socket's QR refs expire, Baileys closes with 408,
 * the reconnect policy builds a new socket, and the new socket asks again,
 * up to ten times before the process exits. Nor does it bound systemd,
 * which restarts the process and starts the count again. So the requests
 * are recorded ON DISK, in the auth folder, and rationed:
 *
 *   - at least PAIRING_MIN_GAP_MS apart (a code lives a minute or two, so
 *     asking sooner only replaces a code nobody has typed yet);
 *   - at most PAIRING_MAX_PER_HOUR in any rolling hour.
 *
 * Past the budget the caller shows the QR instead, which costs WhatsApp
 * nothing extra and still lets a human with the phone link the device.
 *
 * ── The logged-out latch ────────────────────────────────────────────
 * A `401` means the phone no longer lists this linked device. No reconnect
 * can fix that, which is why `connection.ts` exits rather than retrying.
 * But exiting only moves the loop: systemd restarts the bot, the new
 * process connects with the same dead session, gets 401, exits, and round
 * it goes. The latch breaks it. After a 401 the next start refuses to
 * connect at all and says what to do instead.
 *
 * ── What is never done ──────────────────────────────────────────────
 * Nothing here deletes anything. The ledger file is written, and read, and
 * that is all; the recovery for a latched session is to move the auth
 * folder aside and pair afresh, a step for a human, never for code.
 *
 * Pure apart from `fileLedgerIO`, which is the only part that touches disk.
 */
import { readFileSync, writeFileSync } from "node:fs";

/** At least this long between two code requests, across processes. */
export const PAIRING_MIN_GAP_MS = 60_000;

/** At most this many code requests in any rolling hour, across processes. */
export const PAIRING_MAX_PER_HOUR = 5;

const HOUR_MS = 60 * 60_000;

export interface LedgerState {
  /** Epoch ms of each pairing-code request in the last hour. */
  pairingRequestsMs: number[];
  /** Set when WhatsApp logged this device out. Cleared only by a human. */
  loggedOut?: { atIso: string; status: number };
}

export interface LedgerIO {
  /** The stored state, or null when there is none or it is unreadable. */
  load(): LedgerState | null;
  /** May throw; the ledger carries on in memory if it does. */
  save(state: LedgerState): void;
}

export type PairingDecision = { ok: true } | { ok: false; reason: string; retryAfterMs: number };

export interface SessionLedger {
  /** Ask to spend one pairing-code request. Records it when allowed. */
  tryPairingRequest(): PairingDecision;
  /** Latch the session as logged out. */
  recordLoggedOut(status: number): void;
  /** The latch, if set. */
  loggedOut(): { atIso: string; status: number } | null;
}

export function createSessionLedger(io: LedgerIO, now: () => number = Date.now): SessionLedger {
  // Loaded once and kept in memory, so a ledger whose file cannot be
  // written still bounds the process that holds it.
  const state: LedgerState = normalise(safeLoad(io)) ?? { pairingRequestsMs: [] };

  function persist(): void {
    try {
      io.save({ ...state, pairingRequestsMs: [...state.pairingRequestsMs] });
    } catch {
      /* in-memory state still bounds this process */
    }
  }

  return {
    tryPairingRequest() {
      const t = now();
      state.pairingRequestsMs = state.pairingRequestsMs.filter((ms) => t - ms < HOUR_MS);
      const last = state.pairingRequestsMs.length
        ? Math.max(...state.pairingRequestsMs)
        : Number.NEGATIVE_INFINITY;
      if (t - last < PAIRING_MIN_GAP_MS) {
        return {
          ok: false,
          reason: `the last pairing code was requested ${Math.round((t - last) / 1000)}s ago`,
          retryAfterMs: PAIRING_MIN_GAP_MS - (t - last),
        };
      }
      if (state.pairingRequestsMs.length >= PAIRING_MAX_PER_HOUR) {
        const oldest = Math.min(...state.pairingRequestsMs);
        return {
          ok: false,
          reason: `${state.pairingRequestsMs.length} pairing codes were requested in the last hour`,
          retryAfterMs: HOUR_MS - (t - oldest),
        };
      }
      state.pairingRequestsMs.push(t);
      persist();
      return { ok: true };
    },

    recordLoggedOut(status) {
      state.loggedOut = { atIso: new Date(now()).toISOString(), status };
      persist();
    },

    loggedOut() {
      return state.loggedOut ? { ...state.loggedOut } : null;
    },
  };
}

function safeLoad(io: LedgerIO): unknown {
  try {
    return io.load();
  } catch {
    return null;
  }
}

/** Keep only well-typed fields: the file is ours, but it is still input. */
function normalise(raw: unknown): LedgerState | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const out: LedgerState = {
    pairingRequestsMs: Array.isArray(r.pairingRequestsMs)
      ? r.pairingRequestsMs.filter((n): n is number => typeof n === "number" && Number.isFinite(n))
      : [],
  };
  const lo = r.loggedOut as Record<string, unknown> | undefined;
  if (lo && typeof lo === "object" && typeof lo.atIso === "string" && typeof lo.status === "number") {
    out.loggedOut = { atIso: lo.atIso, status: lo.status };
  }
  return out;
}

/** The ledger as a small JSON file. A missing or corrupt file reads as empty. */
export function fileLedgerIO(path: string): LedgerIO {
  return {
    load() {
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch {
        return null;
      }
      try {
        return normalise(JSON.parse(text));
      } catch {
        return null;
      }
    },
    save(state) {
      writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    },
  };
}

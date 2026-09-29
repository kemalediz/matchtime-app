/**
 * Messages Baileys could not decrypt, until their content turns up.
 *
 * ── What Baileys 7.0.0-rc14 does with a message it cannot decrypt ─────
 *
 * `decode-wa-message.js` catches the decrypt error and turns the message
 * into a CIPHERTEXT stub (`messageStubType` 2, no `message`, the error text
 * in `messageStubParameters[0]`). `messages-recv.js` `handleMessage` then:
 *
 *   - sends ONE retry receipt to the sender (`sendRetryRequest`), asking
 *     its device to re-encrypt and re-send the message;
 *   - schedules a placeholder-resend request to our OWN primary phone
 *     3s later (`MessageRetryManager.schedulePhoneRequest`), which only
 *     answers if that phone is online;
 *   - upserts the stub itself as `notify` (or `append` when offline).
 *
 * Whichever answer comes back arrives as a NEW `messages.upsert` carrying
 * the SAME message id: `notify` (or `append`) for the sender's re-send,
 * `notify` with a `requestId` for the phone's placeholder resend
 * (`process-message.js`). There is no `messages.update` for it.
 *
 * So a stub is a promise, not a message. This module holds each one until
 * its content arrives, and says so loudly if it never does: before
 * 2026-09-29 a stub was logged as "a system notice" and forgotten, and an
 * admin's "generate the teams" disappeared on match day without a trace.
 */
import { proto, type WAMessage } from "baileys";

/** How long a stub may wait for its content before it is reported lost. */
export const UNDECRYPTABLE_GRACE_MS = 60_000;
/** Bounded, like everything else a long-running bot remembers. */
export const UNDECRYPTABLE_MAX = 500;

const CIPHERTEXT = proto.WebMessageInfo.StubType.CIPHERTEXT;

/** Baileys' failed-decrypt placeholder: stub type 2 and no content. */
export function isCiphertextStub(m: WAMessage | null | undefined): boolean {
  if (!m || m.message) return false;
  const t = (m as { messageStubType?: unknown }).messageStubType;
  return t === CIPHERTEXT || t === "CIPHERTEXT";
}

export interface UndecryptableEntry {
  id: string;
  chat: string;
  /** The author as the envelope named it (often a device LID). */
  sender: string | null;
  /** Baileys' decrypt error, e.g. "No session found to decrypt message". */
  reason: string;
  firstSeenAt: number;
  upsertType: string;
  /** True when this id was already pending (a retry that failed again). */
  repeat?: boolean;
}

export interface Resolution {
  entry: UndecryptableEntry;
  waitedMs: number;
  /** The content arrived after the entry had already been reported lost. */
  late: boolean;
}

export interface UndecryptableTracker {
  /** Record a stub. Null when it is not a CIPHERTEXT stub, or its id was already delivered. */
  noteStub(m: WAMessage, upsertType: string): UndecryptableEntry | null;
  /** The content for `id` arrived. Null when `id` was never a stub. */
  resolve(id: string): Resolution | null;
  /** `id` was handed up, so a later stub for it is a stray copy, not a loss. */
  delivered(id: string): void;
  pendingCount(): number;
}

type Schedule = (fn: () => void, ms: number) => { cancel(): void };

export function createUndecryptableTracker(opts: {
  onUnrecovered(entry: UndecryptableEntry): void;
  schedule: Schedule;
  now?: () => number;
  graceMs?: number;
  max?: number;
}): UndecryptableTracker {
  const now = opts.now ?? Date.now;
  const graceMs = opts.graceMs ?? UNDECRYPTABLE_GRACE_MS;
  const max = opts.max ?? UNDECRYPTABLE_MAX;
  const pending = new Map<string, { entry: UndecryptableEntry; timer: { cancel(): void } }>();
  const givenUp = new Map<string, UndecryptableEntry>();
  const deliveredIds = new Set<string>();

  function bound<K, V>(m: Map<K, V> | Set<K>, onEvict?: (k: K) => void): void {
    while (m.size > max) {
      const oldest = m.keys().next().value as K | undefined;
      if (oldest === undefined) return;
      onEvict?.(oldest);
      m.delete(oldest);
    }
  }

  return {
    noteStub(m, upsertType) {
      if (!isCiphertextStub(m)) return null;
      const id = m.key?.id;
      if (!id || deliveredIds.has(id)) return null;
      const existing = pending.get(id);
      if (existing) return { ...existing.entry, repeat: true };
      const params = (m as { messageStubParameters?: unknown }).messageStubParameters;
      const entry: UndecryptableEntry = {
        id,
        chat: m.key?.remoteJid ?? "?",
        sender: m.key?.participant || null,
        reason: Array.isArray(params) && params.length > 0 ? String(params[0]) : "unknown",
        firstSeenAt: now(),
        upsertType,
      };
      const timer = opts.schedule(() => {
        const held = pending.get(id);
        if (!held) return;
        pending.delete(id);
        givenUp.set(id, held.entry);
        bound(givenUp);
        opts.onUnrecovered(held.entry);
      }, graceMs);
      pending.set(id, { entry, timer });
      bound(pending, (k) => pending.get(k)?.timer.cancel());
      return entry;
    },

    resolve(id) {
      const held = pending.get(id);
      if (held) {
        held.timer.cancel();
        pending.delete(id);
        return { entry: held.entry, waitedMs: now() - held.entry.firstSeenAt, late: false };
      }
      const lost = givenUp.get(id);
      if (lost) {
        givenUp.delete(id);
        return { entry: lost, waitedMs: now() - lost.firstSeenAt, late: true };
      }
      return null;
    },

    delivered(id) {
      if (!id) return;
      deliveredIds.delete(id);
      deliveredIds.add(id);
      bound(deliveredIds);
    },

    pendingCount() {
      return pending.size;
    },
  };
}

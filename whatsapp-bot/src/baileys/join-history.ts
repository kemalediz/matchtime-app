/**
 * The history WhatsApp shares when the bot is added to a group, held per
 * group for the few minutes the bot-added flow needs it.
 *
 * ── Why this is not the replay buffer ───────────────────────────────
 * `replay.ts` holds what the socket delivered live, and feeds the restart
 * catch-up, which hands messages to the analyzer. Shared history must
 * never go there: it is other people's old messages, it is read once (by
 * the setup reading after a club is approved) and then dropped.
 *
 * ── The gate ────────────────────────────────────────────────────────
 * A group has an entry here ONLY because the driver saw the bot being
 * added to it, and only for `JOIN_HISTORY_WINDOW_MS`. Everything else asks
 * `joined()` first. A history bundle that turns up in an established group
 * (somebody else was added with the switch on) finds no entry and is not
 * downloaded.
 *
 * ── How long a reader waits ─────────────────────────────────────────
 * The bundle arrives about a second after the join and then has to be
 * downloaded on a Pi. `wait()` gives a group with NO sign of shared
 * history `JOIN_HISTORY_QUIET_WAIT_MS` (what the old three-attempt loop
 * spent sleeping), and a group where a history notice or bundle WAS seen
 * `JOIN_HISTORY_MAX_WAIT_MS`. So the switch being off costs nothing extra.
 *
 * Memory only, bounded, pure: no Baileys import, no I/O, no logging.
 */
import { isGroupJid } from "./jid.js";

export const JOIN_HISTORY_WINDOW_MS = 5 * 60 * 1000;
export const MAX_JOIN_HISTORY_GROUPS = 20;
/** No notice and no bundle by now: the switch was off. */
export const JOIN_HISTORY_QUIET_WAIT_MS = 8000;
/** A notice or bundle was seen: give the download this long in total. */
export const JOIN_HISTORY_MAX_WAIT_MS = 25_000;
/** A first read that fails may be followed by one more bundle, not a stream of them. */
export const MAX_BUNDLE_ATTEMPTS = 2;

export type JoinHistoryOutcome =
  /** A bundle was read; `take()` has it. */
  | "captured"
  /** A bundle arrived and could not be read. */
  | "failed"
  /** No sign of shared history for this group. */
  | "none"
  /** A notice or bundle was seen and nothing was ready in time. */
  | "timeout";

export interface JoinHistory<T> {
  /** We were added to this group now. False if it is already open, not a group, or the store is full. */
  opened(chat: string | null | undefined): boolean;
  /** Whether this group is inside its join window. THE gate. */
  joined(chat: string | null | undefined): boolean;
  /** A history notice or bundle was seen for this group. Ignored unless joined. */
  announce(chat: string): void;
  /** A bundle is about to be read. False means: do not read it. */
  begin(chat: string): boolean;
  resolve(chat: string, value: T): void;
  fail(chat: string): void;
  wait(
    chat: string,
    opts: { sleep(ms: number): Promise<void>; quietMs?: number; maxMs?: number },
  ): Promise<JoinHistoryOutcome>;
  /** What was captured, once. It is forgotten as it is handed over. */
  take(chat: string): T | null;
  /** Drop every entry whose window has passed. */
  sweep(): void;
  size(): number;
}

interface Entry<T> {
  openedAt: number;
  announced: boolean;
  reading: boolean;
  attempts: number;
  failed: boolean;
  value: T | null;
  /** Read by the bot-added flow: nothing more is accepted for this join. */
  taken: boolean;
  waiters: Array<() => void>;
}

export function createJoinHistory<T>(
  opts: { now?: () => number; windowMs?: number; maxGroups?: number } = {},
): JoinHistory<T> {
  const now = opts.now ?? Date.now;
  const windowMs = opts.windowMs ?? JOIN_HISTORY_WINDOW_MS;
  const maxGroups = opts.maxGroups ?? MAX_JOIN_HISTORY_GROUPS;
  const entries = new Map<string, Entry<T>>();

  function sweep(): void {
    for (const [chat, e] of [...entries]) {
      if (now() - e.openedAt < windowMs) continue;
      entries.delete(chat);
      e.value = null;
      wake(e);
    }
  }

  function live(chat: string | null | undefined): Entry<T> | null {
    if (!chat) return null;
    const e = entries.get(chat);
    if (!e) return null;
    if (now() - e.openedAt >= windowMs) {
      entries.delete(chat);
      e.value = null;
      wake(e);
      return null;
    }
    return e;
  }

  function wake(e: Entry<T>): void {
    const waiting = e.waiters.splice(0);
    for (const w of waiting) w();
  }

  function settled(e: Entry<T>): JoinHistoryOutcome | null {
    if (e.value !== null) return "captured";
    if (e.failed && !e.reading) return "failed";
    return null;
  }

  return {
    opened(chat) {
      if (!chat || !isGroupJid(chat)) return false;
      sweep();
      if (entries.has(chat)) return false;
      if (entries.size >= maxGroups) return false;
      entries.set(chat, {
        openedAt: now(),
        announced: false,
        reading: false,
        attempts: 0,
        failed: false,
        value: null,
        taken: false,
        waiters: [],
      });
      return true;
    },

    joined: (chat) => live(chat) !== null,

    announce(chat) {
      const e = live(chat);
      if (!e || e.announced) return;
      e.announced = true;
      wake(e);
    },

    begin(chat) {
      const e = live(chat);
      if (!e || e.taken || e.reading || e.value !== null || e.attempts >= MAX_BUNDLE_ATTEMPTS) return false;
      e.attempts++;
      e.reading = true;
      e.failed = false;
      e.announced = true;
      wake(e);
      return true;
    },

    resolve(chat, value) {
      const e = live(chat);
      if (!e || !e.reading) return;
      e.reading = false;
      if (!e.taken) e.value = value;
      wake(e);
    },

    fail(chat) {
      const e = live(chat);
      if (!e || !e.reading) return;
      e.reading = false;
      e.failed = true;
      wake(e);
    },

    async wait(chat, { sleep, quietMs = JOIN_HISTORY_QUIET_WAIT_MS, maxMs = JOIN_HISTORY_MAX_WAIT_MS }) {
      const startedAt = now();
      // Counted as well as measured, so a sleep that returns without the
      // clock moving (a test stub) still ends the wait.
      let slept = 0;
      for (;;) {
        const e = live(chat);
        if (!e) return "none";
        const done = settled(e);
        if (done) return done;
        const elapsed = Math.max(now() - startedAt, slept);
        const limit = e.announced ? maxMs : quietMs;
        if (elapsed >= limit) return e.announced ? "timeout" : "none";
        const remaining = limit - elapsed;
        let woken = false;
        await Promise.race([
          new Promise<void>((r) =>
            e.waiters.push(() => {
              woken = true;
              r();
            }),
          ),
          sleep(remaining),
        ]);
        if (!woken) slept += remaining;
      }
    },

    take(chat) {
      const e = live(chat);
      if (!e) return null;
      const value = e.value;
      e.value = null;
      e.taken = true;
      return value;
    },

    sweep,
    size: () => entries.size,
  };
}

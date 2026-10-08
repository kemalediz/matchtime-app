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
 * One entry is ONE join. Being removed drops it (`closed`), and a join
 * notice over an entry that was already read opens a fresh one, so a
 * remove and re-add inside the window gets its own history instead of
 * finding the door shut.
 *
 * ── How long a reader waits ─────────────────────────────────────────
 * The bundle arrives about a second after the join and then has to be
 * downloaded on a Pi.
 *
 *   no sign of shared history   until `JOIN_HISTORY_QUIET_AFTER_JOIN_MS`
 *                               after the JOIN (not after the reader
 *                               asked). The reader asks a few seconds in,
 *                               once the roster has been read, so this is
 *                               about the 8 s the old three-attempt loop
 *                               slept, and it gives a slow bundle longer
 *                               without the flow taking longer.
 *   a notice or bundle was seen `JOIN_HISTORY_MAX_WAIT_MS` from when the
 *                               reader asked.
 *
 * A reader that gives up empty-handed does NOT close the door: a bundle
 * that lands later in the window is still read and kept for whoever asks
 * next (`gaveUp` lets the driver say so in the log).
 *
 * Memory only, bounded, pure: no Baileys import, no I/O, no logging.
 */
import { isGroupJid } from "./jid.js";

export const JOIN_HISTORY_WINDOW_MS = 5 * 60 * 1000;
export const MAX_JOIN_HISTORY_GROUPS = 20;
/** No notice and no bundle this long after the join: the switch was off. */
export const JOIN_HISTORY_QUIET_AFTER_JOIN_MS = 10_000;
/** A notice or bundle was seen: give the download this long from when the reader asked. */
export const JOIN_HISTORY_MAX_WAIT_MS = 25_000;
/** One bundle is read per join. A failed read is not retried with another. */
export const MAX_BUNDLE_ATTEMPTS = 1;
/**
 * A join is announced more than one way (its notice, a participants
 * update, a new-group event). A join signal with no notice id is the SAME
 * join for this long; after that it is a new stay. Mirrors the driver's
 * own de-duplication of self-adds.
 */
export const SAME_JOIN_MS = 2 * 60 * 1000;
/** A notice id arriving for an entry that has none yet is that entry's own notice for this long. */
export const NOTICE_ADOPT_MS = 30_000;

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
  /**
   * We were added to this group now. False if this very join is already
   * open, it is not a group, or the store is full.
   *
   * `joinKey` identifies the join notice when there is one. A notice with
   * a DIFFERENT id from the one that opened the entry is a new stay (we
   * were removed and added again, and may never have seen the removal):
   * the old entry is discarded with whatever it held, read or not, and a
   * fresh one opened. So is any join over an entry already read, and a
   * keyless join signal more than `SAME_JOIN_MS` after the entry opened.
   */
  opened(chat: string | null | undefined, joinKey?: string | null): boolean;
  /** We were removed from this group: its entry is dropped. */
  closed(chat: string | null | undefined): void;
  /** Whether this group is inside its join window. THE gate. */
  joined(chat: string | null | undefined): boolean;
  /** A history notice or bundle was seen for this group. Ignored unless joined. */
  announce(chat: string): void;
  /** Whether `begin` would say yes, without beginning. */
  canBegin(chat: string): boolean;
  /** A bundle is about to be read. False means: do not read it. */
  begin(chat: string): boolean;
  /**
   * Which stay this group's entry is, or null. A read remembers it and
   * passes it back, so a read that outlives its stay (a re-add, a
   * deadline) cannot write into the next one.
   */
  stay(chat: string): number | null;
  resolve(chat: string, value: T, stay?: number | null): void;
  fail(chat: string, stay?: number | null): void;
  /** Resolves as soon as the outcome is known. Its timer is cancelled and its waiter dropped when it does. */
  wait(
    chat: string,
    opts: {
      schedule(fn: () => void, ms: number): { cancel(): void };
      quietAfterJoinMs?: number;
      maxMs?: number;
    },
  ): Promise<JoinHistoryOutcome>;
  /** What was captured, without forgetting it. */
  peek(chat: string): T | null;
  /** What was captured, once: forgotten as it is handed over. Taking nothing changes nothing. */
  take(chat: string): T | null;
  /** A reader already asked for this join and left with nothing. */
  gaveUp(chat: string): boolean;
  /** Readers currently waiting on this group. */
  waiting(chat: string): number;
  /** Drop every entry whose window has passed. */
  sweep(): void;
  size(): number;
}

interface Entry<T> {
  stay: number;
  joinKey: string | null;
  openedAt: number;
  announced: boolean;
  reading: boolean;
  attempts: number;
  failed: boolean;
  value: T | null;
  /** Read by the bot-added flow: nothing more is accepted for this join. */
  taken: boolean;
  gaveUp: boolean;
  /** Set when the entry is dropped (removed, expired, replaced). */
  gone: boolean;
  waiters: Set<() => void>;
}

export function createJoinHistory<T>(
  opts: { now?: () => number; windowMs?: number; maxGroups?: number } = {},
): JoinHistory<T> {
  const now = opts.now ?? Date.now;
  const windowMs = opts.windowMs ?? JOIN_HISTORY_WINDOW_MS;
  const maxGroups = opts.maxGroups ?? MAX_JOIN_HISTORY_GROUPS;
  const entries = new Map<string, Entry<T>>();
  let stays = 0;

  function isNewStay(e: Entry<T>, joinKey: string | null): boolean {
    if (e.taken) return true;
    const age = now() - e.openedAt;
    if (!joinKey) return age >= SAME_JOIN_MS;
    if (e.joinKey) return e.joinKey !== joinKey;
    return age >= NOTICE_ADOPT_MS;
  }

  function wake(e: Entry<T>): void {
    for (const w of [...e.waiters]) w();
  }

  function drop(chat: string, e: Entry<T>): void {
    if (entries.get(chat) === e) entries.delete(chat);
    e.value = null;
    e.gone = true;
    wake(e);
  }

  function sweep(): void {
    for (const [chat, e] of [...entries]) {
      if (now() - e.openedAt >= windowMs) drop(chat, e);
    }
  }

  function live(chat: string | null | undefined): Entry<T> | null {
    if (!chat) return null;
    const e = entries.get(chat);
    if (!e) return null;
    if (now() - e.openedAt >= windowMs) {
      drop(chat, e);
      return null;
    }
    return e;
  }

  function settled(e: Entry<T>): JoinHistoryOutcome | null {
    if (e.gone) return "none";
    if (e.value !== null) return "captured";
    if (e.failed && !e.reading) return "failed";
    return null;
  }

  return {
    opened(chat, joinKey = null) {
      if (!chat || !isGroupJid(chat)) return false;
      sweep();
      const existing = entries.get(chat);
      if (existing) {
        if (!isNewStay(existing, joinKey)) {
          // The same join seen again (it is announced more than one way).
          if (joinKey && !existing.joinKey) existing.joinKey = joinKey;
          return false;
        }
        // A new stay: whatever the earlier one held or was doing is gone.
        drop(chat, existing);
      }
      if (entries.size >= maxGroups) return false;
      entries.set(chat, {
        stay: ++stays,
        joinKey,
        openedAt: now(),
        announced: false,
        reading: false,
        attempts: 0,
        failed: false,
        value: null,
        taken: false,
        gaveUp: false,
        gone: false,
        waiters: new Set(),
      });
      return true;
    },

    closed(chat) {
      const e = chat ? entries.get(chat) : undefined;
      if (chat && e) drop(chat, e);
    },

    joined: (chat) => live(chat) !== null,

    announce(chat) {
      const e = live(chat);
      if (!e || e.announced) return;
      e.announced = true;
      wake(e);
    },

    canBegin(chat) {
      const e = live(chat);
      return !!e && !e.taken && !e.reading && e.value === null && e.attempts < MAX_BUNDLE_ATTEMPTS;
    },

    stay: (chat) => live(chat)?.stay ?? null,

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

    resolve(chat, value, stay) {
      const e = live(chat);
      if (!e || !e.reading) return;
      if (stay !== undefined && stay !== e.stay) return;
      e.reading = false;
      if (!e.taken) e.value = value;
      wake(e);
    },

    fail(chat, stay) {
      const e = live(chat);
      if (!e || !e.reading) return;
      if (stay !== undefined && stay !== e.stay) return;
      e.reading = false;
      e.failed = true;
      wake(e);
    },

    wait(chat, { schedule, quietAfterJoinMs = JOIN_HISTORY_QUIET_AFTER_JOIN_MS, maxMs = JOIN_HISTORY_MAX_WAIT_MS }) {
      const first = live(chat);
      if (!first) return Promise.resolve<JoinHistoryOutcome>("none");
      const e = first;
      const askedAt = now();
      return new Promise<JoinHistoryOutcome>((resolve) => {
        let timer: { cancel(): void } | null = null;
        let over = false;
        const finish = (outcome: JoinHistoryOutcome) => {
          if (over) return;
          over = true;
          timer?.cancel();
          timer = null;
          e.waiters.delete(check);
          if (outcome !== "captured" && !e.gone) e.gaveUp = true;
          resolve(outcome);
        };
        /** `due`: the timer for the current deadline has fired. */
        function check(due = false): void {
          if (over) return;
          const done = settled(e);
          if (done) return finish(done);
          const deadline = e.announced ? askedAt + maxMs : e.openedAt + quietAfterJoinMs;
          const remaining = deadline - now();
          // `due` also ends it when a stubbed clock did not move.
          if (remaining <= 0 || (due && armedFor === deadline)) return finish(e.announced ? "timeout" : "none");
          if (armedFor === deadline) return;
          timer?.cancel();
          armedFor = deadline;
          timer = schedule(() => check(true), remaining);
        }
        let armedFor: number | null = null;
        e.waiters.add(check);
        check();
      });
    },

    peek(chat) {
      return live(chat)?.value ?? null;
    },

    take(chat) {
      const e = live(chat);
      if (!e || e.value === null) return null;
      const value = e.value;
      e.value = null;
      e.taken = true;
      return value;
    },

    gaveUp: (chat) => live(chat)?.gaveUp === true,
    waiting: (chat) => entries.get(chat)?.waiters.size ?? 0,
    sweep,
    size: () => entries.size,
  };
}

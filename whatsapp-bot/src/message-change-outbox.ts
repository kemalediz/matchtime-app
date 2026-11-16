/**
 * THE DURABLE OUTBOX FOR DELETES AND EDITS (2026-11-15, round 2).
 *
 * A delete the server never takes is a member's words kept for a week, so
 * one failed post (the server down, a deploy, a Pi that came up before the
 * server learnt the route) must not lose it. Every change is written here
 * BEFORE it is posted, retried with backoff until the server answers ok,
 * and read back after a restart.
 *
 * The same file is the Pi's own record across a restart: a change the
 * server has taken is kept a day more, so a late copy of the message (a
 * replay after a reconnect) is still held to it (`smart-analysis.ts`).
 *
 * The file is the dm-pacer's kind (`dm-pacer.ts`): JSON beside the bot,
 * written atomically, 0600, gitignored, never touched by `deploy-pi.sh`'s
 * `git pull`. It holds ids and phones, and an edit's new words until the
 * day is out. Bounded: OUTBOX_MAX entries (the oldest taken changes go
 * first), and a change the server has not taken in GIVE_UP_MS is dropped
 * with a CRITICAL line naming its id. Logs carry ids only.
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { JsonIO } from "./baileys/json-file.js";
import type { LocalMessageChange } from "./message-change.js";

export const OUTBOX_MAX = 500;
/** A change the server has taken stays this long, for late copies after a restart. */
export const KEEP_TAKEN_MS = 24 * 60 * 60 * 1000;
/** A change the server has not taken after this long is given up. */
export const GIVE_UP_MS = 7 * 24 * 60 * 60 * 1000;
const FIRST_RETRY_MS = 15_000;
const MAX_RETRY_MS = 15 * 60_000;

const BOT_DIR = fileURLToPath(new URL("..", import.meta.url));
/** Beside `.dm-pacing.json`, gitignored. */
export const DEFAULT_OUTBOX_FILE = ".message-changes.json";

/** Where the outbox lives: `MESSAGE_CHANGES_STATE_PATH`, else beside the bot; nowhere under vitest. */
export function outboxPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env.MESSAGE_CHANGES_STATE_PATH?.trim();
  return override || (env.VITEST ? null : join(BOT_DIR, DEFAULT_OUTBOX_FILE));
}

/** 15s, 30s, 1m, 2m ... at most 15 minutes. */
export function backoffMs(attempts: number): number {
  return Math.min(FIRST_RETRY_MS * 2 ** Math.max(0, attempts - 1), MAX_RETRY_MS);
}

interface Entry {
  key: string;
  change: LocalMessageChange;
  recordedAt: number;
  takenAt: number | null;
  attempts: number;
  nextAt: number;
}

export interface MessageChangeOutbox {
  /** Read the file: every change in it, oldest first (for the Pi's own record). */
  load(): LocalMessageChange[];
  /** Keep a change (written at once) and return its key. Not posted yet. */
  record(change: LocalMessageChange): string;
  /** Post it now. True when the server took it; otherwise it waits for its backoff. */
  attempt(key: string): Promise<boolean>;
  /** Post every change whose retry is due. Returns how many were taken. */
  drainDue(): Promise<number>;
  /** Changes the server has not taken yet. */
  pending(): number;
  start(intervalMs?: number): void;
  stop(): void;
}

function isChange(v: unknown): v is LocalMessageChange {
  const c = v as LocalMessageChange | null;
  return (
    !!c &&
    (c.kind === "revoke" || c.kind === "edit") &&
    typeof c.groupId === "string" &&
    typeof c.messageId === "string" &&
    Array.isArray(c.senderJids)
  );
}

function readEntries(raw: unknown): Entry[] {
  const list = (raw as { entries?: unknown } | null)?.entries;
  if (!Array.isArray(list)) return [];
  return list.flatMap((e) => {
    const x = e as Partial<Entry> | null;
    if (!x || typeof x.key !== "string" || !isChange(x.change) || typeof x.recordedAt !== "number") return [];
    return [{ key: x.key, change: x.change, recordedAt: x.recordedAt, takenAt: typeof x.takenAt === "number" ? x.takenAt : null, attempts: Number(x.attempts) || 0, nextAt: Number(x.nextAt) || 0 }];
  });
}

export function createMessageChangeOutbox(deps: {
  io: JsonIO | null;
  now(): number;
  post(change: LocalMessageChange): Promise<boolean>;
  log(line: string): void;
  error(line: string): void;
}): MessageChangeOutbox {
  let entries: Entry[] = [];
  let seq = 0;
  let timer: NodeJS.Timeout | null = null;
  let draining = false;

  const tag = (e: Entry) => `${e.change.kind === "revoke" ? "delete" : "edit"} of ${e.change.messageId} in ${e.change.groupId}`;

  function tidy(): void {
    const now = deps.now();
    entries = entries.filter((e) => {
      if (e.takenAt !== null) return now - e.takenAt <= KEEP_TAKEN_MS;
      if (now - e.recordedAt > GIVE_UP_MS) {
        deps.error(`CRITICAL: [message-change] ${tag(e)}: the server never took it in 7 days; gave up`);
        return false;
      }
      return true;
    });
    // Over the cap: the oldest taken first, then (only if it must) the oldest not taken.
    while (entries.length > OUTBOX_MAX) {
      const i = entries.findIndex((e) => e.takenAt !== null);
      const [gone] = entries.splice(i >= 0 ? i : 0, 1);
      if (gone.takenAt === null) deps.error(`CRITICAL: [message-change] ${tag(gone)}: dropped, the outbox is full`);
    }
  }

  function save(): void {
    if (!deps.io) return;
    try {
      deps.io.save({ v: 1, entries });
    } catch (err) {
      deps.error(`[message-change] outbox not saved: ${err instanceof Error ? err.message : "failed"}`);
    }
  }

  async function send(e: Entry): Promise<boolean> {
    e.attempts++;
    let ok = false;
    try {
      ok = await deps.post(e.change);
    } catch {
      ok = false;
    }
    if (ok) {
      e.takenAt = deps.now();
      if (e.attempts > 1) deps.log(`[message-change] ${tag(e)}: taken on attempt ${e.attempts}`);
    } else {
      e.nextAt = deps.now() + backoffMs(e.attempts);
      deps.error(`[message-change] ${tag(e)}: not taken (attempt ${e.attempts}); retrying in ${Math.round(backoffMs(e.attempts) / 1000)}s`);
    }
    save();
    return ok;
  }

  return {
    load() {
      entries = deps.io ? readEntries(deps.io.load()) : [];
      tidy();
      return entries.map((e) => e.change);
    },
    record(change) {
      const now = deps.now();
      const key = `${now}-${++seq}-${change.kind}-${change.messageId}`;
      entries.push({ key, change, recordedAt: now, takenAt: null, attempts: 0, nextAt: now });
      tidy();
      save();
      return key;
    },
    async attempt(key) {
      const e = entries.find((x) => x.key === key);
      if (!e) return false;
      if (e.takenAt !== null) return true;
      return send(e);
    },
    async drainDue() {
      if (draining) return 0;
      draining = true;
      let taken = 0;
      try {
        tidy();
        const now = deps.now();
        for (const e of entries.filter((x) => x.takenAt === null && x.nextAt <= now)) {
          if (await send(e)) taken++;
        }
        save();
      } finally {
        draining = false;
      }
      return taken;
    },
    pending() {
      return entries.filter((e) => e.takenAt === null).length;
    },
    start(intervalMs = FIRST_RETRY_MS) {
      if (timer) return;
      timer = setInterval(() => {
        void this.drainDue().catch((err) => deps.error(`[message-change] retry failed: ${err instanceof Error ? err.message : "failed"}`));
      }, intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

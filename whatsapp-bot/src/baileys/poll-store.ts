/**
 * The polls we sent, on disk. Plan §2.12, Phase 4.
 *
 * A vote on a poll arrives encrypted with a key derived from the poll's
 * own `messageSecret`, which exists in exactly one place: the poll message
 * we sent. Man of the Match votes keep arriving for a day and a half after
 * kickoff. Held only in memory (`sent-store.ts`), every vote after a
 * deploy or a crash in that window would be undecryptable. So every poll
 * is also written here, and read back at start.
 *
 * What is stored: the poll message itself, protobuf-encoded as base64
 * (question, options, secret), with its chat and when it was sent. The
 * codec lives in `polls.ts`; this module keeps strings and stays pure
 * apart from the injected IO.
 *
 * Bounded twice: at most `max` polls, and nothing older than
 * `POLL_ARCHIVE_MAX_AGE_MS`. A poll older than a fortnight has no vote
 * worth counting, and its secret has no reason to stay on disk.
 *
 * Polls sent by whatsapp-web.js before the cutover are NOT here and never
 * can be: their secrets live in the old browser profile. Votes on those go
 * to the log as undecryptable (plan §2.12, "degrades to app-only voting").
 */
import type { JsonIO } from "./json-file.js";

export type PollArchiveIO = JsonIO;

export const POLL_ARCHIVE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
export const DEFAULT_POLL_ARCHIVE_MAX = 200;

interface ArchivedPoll {
  id: string;
  chat: string;
  message: string;
  sentAtMs: number;
}

export interface PollArchive {
  /** Keep a poll we just sent. Saved at once: the next crash may be seconds away. */
  remember(id: string, chat: string, messageB64: string): void;
  /** The encoded poll message, or undefined. */
  get(id: string | null | undefined): string | undefined;
  size(): number;
}

function isPoll(v: unknown): v is ArchivedPoll {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    r.id.length > 0 &&
    typeof r.chat === "string" &&
    typeof r.message === "string" &&
    r.message.length > 0 &&
    typeof r.sentAtMs === "number" &&
    Number.isFinite(r.sentAtMs)
  );
}

export function createPollArchive(opts: {
  io: PollArchiveIO;
  max?: number;
  maxAgeMs?: number;
  now?: () => number;
  error?(line: string): void;
}): PollArchive {
  const max = opts.max ?? DEFAULT_POLL_ARCHIVE_MAX;
  const maxAge = opts.maxAgeMs ?? POLL_ARCHIVE_MAX_AGE_MS;
  const now = opts.now ?? Date.now;
  const error = opts.error ?? ((l: string) => console.error(l));
  const polls = new Map<string, ArchivedPoll>();

  let raw: unknown = null;
  try {
    raw = opts.io.load();
  } catch {
    raw = null;
  }
  const list = raw && typeof raw === "object" ? (raw as { polls?: unknown }).polls : null;
  if (Array.isArray(list)) {
    for (const p of list) if (isPoll(p) && now() - p.sentAtMs <= maxAge) polls.set(p.id, p);
  }
  trim();

  function trim(): void {
    while (polls.size > max) {
      const oldest = polls.keys().next().value;
      if (oldest === undefined) break;
      polls.delete(oldest);
    }
  }

  function save(): void {
    try {
      opts.io.save({ polls: [...polls.values()] });
    } catch (err) {
      error(
        `[baileys][poll] could not save the poll archive (${err instanceof Error ? err.message : String(err)}); ` +
          "votes on this poll will be lost if the bot restarts before they arrive",
      );
    }
  }

  return {
    remember(id, chat, messageB64) {
      if (!id || !messageB64) return;
      polls.delete(id);
      polls.set(id, { id, chat, message: messageB64, sentAtMs: now() });
      trim();
      save();
    },
    get(id) {
      if (!id) return undefined;
      const p = polls.get(id);
      if (!p) return undefined;
      if (now() - p.sentAtMs > maxAge) return undefined;
      return p.message;
    },
    size() {
      return polls.size;
    },
  };
}

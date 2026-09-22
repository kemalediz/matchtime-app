/**
 * Small JSON files kept beside the Baileys auth state (Phase 4): the
 * harvested contact directory and the archive of polls we sent.
 *
 * Why beside the auth state. It is already the one directory that is
 * `0700`, never deleted by a deploy (`deploy-pi.sh` must not touch it, per
 * plan §2.1), and moved aside as a unit on a re-pair. These files hold
 * names, phone numbers and poll secrets, so each is written `0600`.
 *
 * Written atomically: a temp file in the same directory, then a rename,
 * so a power cut on the Pi's SD card leaves the old file or the new one,
 * never half of either. Read defensively: a missing or corrupt file is
 * `null`, never a crash, because losing a name cache must not stop a bot.
 *
 * Nothing here deletes a file.
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";

export interface JsonIO {
  /** The parsed file, or null when it is missing or unreadable. */
  load(): unknown;
  save(value: unknown): void;
}

export function jsonFileIO(path: string): JsonIO {
  return {
    load() {
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch {
        return null;
      }
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return null;
      }
    },
    save(value) {
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
      renameSync(tmp, path);
    },
  };
}

export interface DebouncedWriter {
  /** Something changed: write within `delayMs`, once, however many changes. */
  markDirty(): void;
  /** Write now if anything is pending. Called on every close. */
  flush(): void;
}

/**
 * Coalesce a stream of small changes into one write per `delayMs`. A busy
 * group teaches the directory something on most messages; rewriting a
 * file on the SD card for each would be wasteful for no gain.
 */
export function createDebouncedWriter(
  write: () => void,
  opts: {
    delayMs: number;
    schedule?(fn: () => void, ms: number): { cancel(): void };
    error?(line: string): void;
  },
): DebouncedWriter {
  const schedule =
    opts.schedule ??
    ((fn: () => void, ms: number) => {
      const t = setTimeout(fn, ms);
      t.unref?.();
      return { cancel: () => clearTimeout(t) };
    });
  const error = opts.error ?? ((l: string) => console.error(l));
  let dirty = false;
  let pending: { cancel(): void } | null = null;

  function flush(): void {
    pending?.cancel();
    pending = null;
    if (!dirty) return;
    try {
      write();
      dirty = false;
    } catch (err) {
      // Stays dirty: the next change or the next close tries again.
      error(`[baileys] could not save state to disk: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    markDirty() {
      dirty = true;
      if (!pending) pending = schedule(flush, opts.delayMs);
    },
    flush,
  };
}

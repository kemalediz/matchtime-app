/**
 * libsignal's session dumps, kept out of bot.log (2026-10-15).
 *
 * The manager found libsignal session records in the Pi's bot.log: a
 * "Closing session" line followed by an object dump with `rootKey`,
 * `baseKey` and chain keys as Buffers. They do NOT come through Baileys'
 * logger (baileys/logging.ts redacts those): `libsignal` (a Baileys
 * dependency, node_modules/libsignal/src/session_record.js and
 * session_builder.js) calls `console.info("Closing session:", session)`,
 * `console.info("Opening session:", session)`,
 * `console.info("Removing old closed session:", oldestSession)`,
 * `console.warn("Session already closed", session)` and a few more
 * directly. No logger level reaches them.
 *
 * So the bot wraps `console.info`, `console.log` and `console.warn` ONCE at
 * start: a call whose FIRST argument is exactly one of libsignal's own
 * session strings is printed as one line naming the event, without any of
 * its arguments. Every other call goes through untouched, so nothing of
 * ours is hidden. Errors (`console.error`) are not wrapped: libsignal's
 * error lines ("Failed to decrypt message with any known session...",
 * "Session error:" with a stack) carry no session object and are real
 * failure signals.
 */

/** libsignal's exact first arguments (rc14's libsignal 6.x). */
const SESSION_LINES = new Set([
  "Closing session:",
  "Opening session:",
  "Removing old closed session:",
  "Session already closed",
  "Session already open",
  "Migrating session to:",
  "Closing open session in favor of incoming prekey bundle",
  "Closing stale open session for new outgoing prekey bundle",
  "Decrypted message with closed session.",
]);

/** The replacement line, or null when this is not one of libsignal's. */
export function libsignalSummary(args: readonly unknown[]): string | null {
  const first = args[0];
  if (typeof first !== "string" || !SESSION_LINES.has(first)) return null;
  const event = first.replace(/[:.]$/, "");
  return `[libsignal] ${event} (details suppressed)`;
}

const INSTALLED = Symbol.for("matchtime.libsignalConsoleFilter");
type Method = "info" | "log" | "warn";

/** Wrap once; returns a function that puts the originals back. */
export function installLibsignalConsoleFilter(target: Console = console): () => void {
  const marked = target as Console & { [INSTALLED]?: () => void };
  if (marked[INSTALLED]) return marked[INSTALLED] as () => void;
  const originals: Partial<Record<Method, (...a: unknown[]) => void>> = {};
  for (const m of ["info", "log", "warn"] as const) {
    const orig = target[m] as (...a: unknown[]) => void;
    if (typeof orig !== "function") continue;
    originals[m] = orig;
    target[m] = ((...args: unknown[]) => {
      let line: string | null = null;
      try {
        line = libsignalSummary(args);
      } catch {
        line = null;
      }
      if (line !== null) orig.call(target, line);
      else orig.apply(target, args);
    }) as Console[Method];
  }
  const uninstall = () => {
    for (const [m, fn] of Object.entries(originals)) (target as unknown as Record<string, unknown>)[m] = fn;
    delete marked[INSTALLED];
  };
  marked[INSTALLED] = uninstall;
  return uninstall;
}

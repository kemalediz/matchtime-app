/**
 * The logger we hand to Baileys, and the redaction that makes it safe.
 *
 * ── Why this is not a one-liner ─────────────────────────────────────
 * Baileys logs pino-style: `logger.warn(someObject, "some message")`. Some
 * of those objects are THE WHOLE MULTI-DEVICE AUTH STATE: noise keys,
 * Signal sessions, ratchet chain keys, the registration id, raw buffers.
 * HomeTenant's first attempt stringified them with only Buffers shortened,
 * and the result was:
 *
 *   - key material sitting in a root-owned log file on the Pi, and in any
 *     backup or paste of it;
 *   - thousands of characters per reconnect, so the line that mattered
 *     scrolled past inside a session dump;
 *   - a log that grows fast enough to matter on an SD card. Their bot.log
 *     reached 48 MB before rotation existed.
 *
 * So every object is walked and capped before it is printed, and anything
 * that looks like key material is replaced rather than shortened.
 *
 * ── The one deliberate exception ────────────────────────────────────
 * The field named exactly `key` is NOT redacted. In Baileys that is the
 * MESSAGE key, `{ remoteJid, id, fromMe, participant }`, which is the
 * single most useful thing in an inbound log line and is not a secret.
 * Everything whose name ENDS in `key`, `keys`, `keyPair` or `secret` is.
 *
 * ── Why the logger is hand-rolled rather than pino ──────────────────
 * Baileys' `ILogger` is structural and not re-exported from the package
 * root, so a plain object with `level`, a `child()` that returns itself,
 * and the six level methods satisfies it. That keeps pino out of our
 * imports and keeps every line going through the redactor above.
 */

export const LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
export type LogLevel = (typeof LEVELS)[number];

/** Caps. A capped line is readable; an uncapped one hides the next one. */
export const MAX_LOG_LINE = 600;
const MAX_STRING = 120;
const MAX_ARRAY = 6;
const MAX_DEPTH = 4;
const MAX_FIELDS = 20;

/** Field names that are key material whatever their shape. */
const REDACT_EXACT = new Set([
  "keys",
  "creds",
  "session",
  "sessions",
  "registrationid",
  "advsecretkey",
  "signalidentities",
  "prekeys",
  "appstatesynckeys",
  "secret",
  "token",
  "password",
]);

/** Suffixes that mark a field as key material, at a word boundary. */
const REDACT_SUFFIXES = ["keypair", "keys", "key", "secret"] as const;

/**
 * Is this field name key material?
 *
 * `key` alone is exempt on purpose: see the header.
 *
 * The suffix must begin at a word boundary, meaning it starts with a
 * capital (`noiseKey`, `signedIdentityKey`, `clientSecret`) or follows an
 * underscore, a dash or a digit (`app_secret`). A bare lowercase suffix
 * does NOT count, or `monkey` and `donkey` would be redacted, which is
 * both silly and a way to lose a field that mattered.
 */
export function isKeyishFieldName(name: string): boolean {
  const n = name.toLowerCase();
  if (n === "key") return false;
  if (REDACT_EXACT.has(n)) return true;
  for (const suffix of REDACT_SUFFIXES) {
    if (!n.endsWith(suffix)) continue;
    const start = name.length - suffix.length;
    if (start === 0) return true;
    if (/[A-Z]/.test(name[start]) || /[_\-0-9]/.test(name[start - 1])) return true;
  }
  return false;
}

function byteCount(v: unknown): number | null {
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(v)) return v.length;
  if (v instanceof Uint8Array) return v.length;
  const o = v as { type?: unknown; data?: unknown } | null;
  if (o && o.type === "Buffer" && Array.isArray(o.data)) return o.data.length;
  return null;
}

/**
 * A log-safe copy: key material replaced, buffers counted, strings and
 * arrays and depth capped, cycles tolerated, throwing getters survived.
 *
 * A getter that throws is not hypothetical. It is exactly the shape that
 * made whatsapp-web.js's broken build so hard to diagnose, and a logger
 * that can be taken down by the thing it is trying to report is worse
 * than no logger.
 */
export function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;

  const bytes = byteCount(value);
  if (bytes !== null) return `<${bytes} bytes>`;

  const t = typeof value;
  if (t === "string") {
    const s = value as string;
    return s.length > MAX_STRING ? `${s.slice(0, MAX_STRING)}...(${s.length})` : s;
  }
  if (t === "number" || t === "boolean" || t === "bigint") return value;
  if (t === "function") return "<fn>";

  if (depth >= MAX_DEPTH) return "<...>";
  if (seen.has(value as object)) return "<cycle>";
  seen.add(value as object);

  if (Array.isArray(value)) {
    const head = value.slice(0, MAX_ARRAY).map((v) => redact(v, depth + 1, seen));
    return value.length > MAX_ARRAY ? [...head, `...(${value.length})`] : head;
  }

  if (value instanceof Error) return `${value.name}: ${value.message}`;

  const out: Record<string, unknown> = {};
  let n = 0;
  for (const name of Object.keys(value as object)) {
    if (n >= MAX_FIELDS) {
      out["..."] = "truncated";
      break;
    }
    n++;
    if (isKeyishFieldName(name)) {
      out[name] = "<redacted>";
      continue;
    }
    try {
      out[name] = redact((value as Record<string, unknown>)[name], depth + 1, seen);
    } catch {
      // A getter threw. Say so and carry on with the rest of the object.
      out[name] = "<unreadable>";
    }
  }
  return out;
}

/** One printable line, capped. */
export function formatLogLine(level: LogLevel, obj: unknown, msg?: string): string {
  const text = typeof msg === "string" && msg.length > 0 ? msg : "";
  let detail = "";
  if (obj !== undefined && obj !== null && typeof obj !== "string") {
    try {
      detail = JSON.stringify(redact(obj)) ?? "";
    } catch {
      detail = "<unserialisable>";
    }
  } else if (typeof obj === "string") {
    detail = obj;
  }
  const line = `[baileys ${level}] ${text}${detail ? ` ${detail}` : ""}`.trimEnd();
  return line.length > MAX_LOG_LINE ? `${line.slice(0, MAX_LOG_LINE - 3)}...` : line;
}

/**
 * Normal on a freshly linked device, repeats endlessly, and there is
 * nothing anyone can do about it. WhatsApp has not shared the app-state
 * sync key yet.
 */
const APP_STATE_PARKED = /blocked on missing key from v\d+, parking after \d+ attempts?/i;

/**
 * The level a line should really be logged at.
 *
 * Only ever quietens a known-noise pattern, and only when it arrived as a
 * warning. A real error keeps Baileys' own level, because the point of the
 * 2026-08-30 audit was that failure signals nobody reads are worth nothing.
 */
export function effectiveLevel(level: LogLevel, msg?: string, obj?: unknown): LogLevel {
  if (level !== "warn") return level;
  const text = typeof msg === "string" ? msg : typeof obj === "string" ? obj : "";
  return APP_STATE_PARKED.test(text) ? "debug" : level;
}

/** Baileys' `ILogger`, structurally. */
export interface BaileysLoggerLike {
  level: string;
  child: () => BaileysLoggerLike;
  trace: (obj: unknown, msg?: string) => void;
  debug: (obj: unknown, msg?: string) => void;
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
  fatal: (obj: unknown, msg?: string) => void;
}

/**
 * A logger for Baileys that redacts, caps, and drops anything below
 * `level`. Warnings and above go to stderr so `bot.err.log` keeps working
 * the way the existing runbooks assume.
 */
export function makeBaileysLogger(level: LogLevel): BaileysLoggerLike {
  const threshold = Math.max(0, LEVELS.indexOf(level));
  const emit =
    (lvl: LogLevel) =>
    (obj: unknown, msg?: string): void => {
      const real = effectiveLevel(lvl, msg, obj);
      if (LEVELS.indexOf(real) < threshold) return;
      const line = formatLogLine(real, obj, msg);
      if (LEVELS.indexOf(real) >= LEVELS.indexOf("warn")) console.error(line);
      else console.log(line);
    };
  const logger: BaileysLoggerLike = {
    level,
    child: () => logger,
    trace: emit("trace"),
    debug: emit("debug"),
    info: emit("info"),
    warn: emit("warn"),
    error: emit("error"),
    fatal: emit("fatal"),
  };
  return logger;
}

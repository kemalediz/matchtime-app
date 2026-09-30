/**
 * A MESSAGE THAT ARRIVES LATE IS NOT A REQUEST MADE NOW (2026-09-29).
 *
 * Sutton FC, match day. Just after a Pi restart the admin sent "@Match
 * Time generate the teams. Put me on red team." at about 11:30 UTC.
 * Baileys could not decrypt it. WhatsApp delivered a readable copy at
 * 22:00:38 UTC, ten and a half hours later and after the match had been
 * played, and the analyze route treated it as a fresh request: it ran the
 * balancer's gate, decided it was "not match day" by the London date, and
 * told the group "I'll build the teams on match day, just ask me then."
 *
 * ── The rule (Kemal approved) ─────────────────────────────────────────
 *
 * The age that counts is the message's ORIGINAL WhatsApp timestamp, which
 * the Pi forwards as `timestamp` on every path (the batch flush, the
 * immediate tagged flush, the restart catch-up and the undecryptable
 * recovery all build the same payload from `messageTimestamp`, the
 * sender's send time; the incident copy logged `age=37390s` against it).
 * When a message is MORE than 30 minutes old on arrival:
 *
 *   - ATTENDANCE (the attendance engine's four routes) is still recorded,
 *     because a player's IN or OUT is a fact that stays true however
 *     late it reaches us, and losing one is the worst thing this product
 *     does. It gets no reply, no DM and no squad post. The registration
 *     react (✅ / 🪑 / 👋) IS kept: it is attached to the player's own
 *     old message, it tells them and the group that it was counted, and
 *     it cannot be misread as MatchTime answering a question now.
 *   - EVERYTHING ELSE (team generation or clearing, questions, stats,
 *     scores, admin ops, fees and payments, the deterministic peels, the
 *     bench-prompt answer) is not executed and gets no reply. A command
 *     acted on hours after it was given acts on a world that has moved on.
 *   - Either way it is recorded as ONE `late-message` ops event per batch
 *     on /admin/health, with the delay. Never a DM.
 *
 * And one refinement the incident forces: a late attendance change is NOT
 * recorded when a match kicked off between the moment it was sent and
 * now. It was about that match, which has started or finished; recording
 * it now would land it on NEXT week's match instead (the registration
 * selector picks the soonest upcoming one). It is reported instead.
 *
 * ── The restart catch-up ─────────────────────────────────────────────
 *
 * After a restart the Pi replays the last 2 hours (`recoverGroupMessages`).
 * The server dedupes on `waMessageId`, so only messages it never saw are
 * analysed, and those keep their original timestamps. Under this rule a
 * replayed message under 30 minutes old behaves exactly as before; one
 * between 30 minutes and 2 hours old records attendance silently, which
 * is the catch-up's reason to exist (Ibrahim's "in" lost in a deploy on
 * 2026-06-06), and executes nothing else, which is consistent with a
 * late copy arriving any other way.
 *
 * Pure. The route does the I/O.
 */
import { ENGINE_ROUTES } from "./pipeline/gate";
import type { Route } from "./pipeline/types";

/** Older than this on arrival, and a message is late. */
export const LATE_MESSAGE_AFTER_MS = 30 * 60 * 1000;

/** `AnalyzedMessage.handledBy` for a late message nothing was executed for. */
export const LATE_HANDLED_BY = "late-message";

/** The reacts that describe the sender's own attendance row. */
const REGISTRATION_REACTS: ReadonlySet<string> = new Set(["✅", "🪑", "👋"]);

export interface LateInfo {
  /** Milliseconds between the original send and `now`. */
  ageMs: number;
  sentAt: Date;
  /** A match that kicked off in (sentAt, now], or null. When set, the
   *  message's attendance is not recorded either. */
  kickedOffAt: Date | null;
}

export interface LatePlan {
  late: Map<string, LateInfo>;
}

/** A WhatsApp timestamp as the Pi sends it (ISO), or as epoch seconds or
 *  milliseconds, to a Date. Null when unreadable. */
export function parseTimestamp(ts: unknown): Date | null {
  if (typeof ts === "number" && Number.isFinite(ts) && ts > 0) {
    // Seconds until the year 5138; anything bigger is milliseconds.
    return new Date(ts < 1e11 ? ts * 1000 : ts);
  }
  if (typeof ts === "string" && ts.trim().length > 0) {
    const n = Date.parse(ts);
    return Number.isFinite(n) ? new Date(n) : null;
  }
  return null;
}

/**
 * Which messages in a batch are late, and which of those were overtaken
 * by a kickoff. An unreadable or future timestamp is never late: that
 * fails open to exactly what the route did before this existed.
 */
export function planLateMessages(args: {
  messages: Array<{ waMessageId: string; timestamp: unknown }>;
  now: Date;
  /** Kickoffs of the club's non-cancelled matches, any order. */
  kickoffs: Date[];
  afterMs?: number;
}): LatePlan {
  const afterMs = args.afterMs ?? LATE_MESSAGE_AFTER_MS;
  const nowMs = args.now.getTime();
  const late = new Map<string, LateInfo>();
  for (const m of args.messages) {
    const sentAt = parseTimestamp(m.timestamp);
    if (!sentAt) continue;
    const ageMs = nowMs - sentAt.getTime();
    if (!(ageMs > afterMs)) continue;
    let kickedOffAt: Date | null = null;
    for (const k of args.kickoffs) {
      const t = k.getTime();
      if (t > sentAt.getTime() && t <= nowMs && (!kickedOffAt || t < kickedOffAt.getTime())) {
        kickedOffAt = k;
      }
    }
    late.set(m.waMessageId, { ageMs, sentAt, kickedOffAt });
  }
  return { late };
}

/**
 * May a late message on this route still do anything? Only attendance,
 * which is exactly the attendance engine's routes. Every other route
 * (and an unrouted message) is not executed.
 */
export function lateRouteAllowed(route: Route | undefined): boolean {
  return route !== undefined && ENGINE_ROUTES.includes(route);
}

/** A late message's result: no words, and a react only when it is the
 *  registration react for the sender's own row. */
export function silenceLateResult<T extends { react: string | null; reply: string | null }>(r: T): T {
  return {
    ...r,
    react: r.react !== null && REGISTRATION_REACTS.has(r.react) ? r.react : null,
    reply: null,
  };
}

/** "31m", "1h", "10h 30m", "1d 2h". */
export function formatDelay(ms: number): string {
  const totalMin = Math.floor(ms / 60_000);
  const days = Math.floor(totalMin / (24 * 60));
  const hours = Math.floor((totalMin % (24 * 60)) / 60);
  const mins = totalMin % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  return `${mins}m`;
}

export type LateOutcome =
  /** Attendance route, and the engine wrote a change. */
  | "attendance-recorded"
  /** Attendance route, and nothing changed (already in, unreadable, a failed write). */
  | "attendance-unchanged"
  /** Any other route: nothing executed. */
  | "not-executed"
  /** A match kicked off after it was sent: not even attendance was recorded. */
  | "match-kicked-off";

export interface LateEntry {
  waMessageId: string;
  authorName: string | null;
  body: string;
  ageMs: number;
  outcome: LateOutcome;
  route: Route | undefined;
}

const OUTCOME_TEXT: Record<LateOutcome, string> = {
  "attendance-recorded": "attendance recorded, no reply sent",
  "attendance-unchanged": "read as attendance, nothing changed, no reply sent",
  "not-executed": "not executed, no reply sent",
  "match-kicked-off": "not acted on: a match kicked off after it was sent",
};

/** The one ops event for a batch's late messages, or null for none. */
export function composeLateMessageAlert(
  entries: LateEntry[],
): { title: string; detail: string; dedupeKey: string } | null {
  if (entries.length === 0) return null;
  const n = entries.length;
  const title = `${n} message${n === 1 ? "" : "s"} arrived late and ${n === 1 ? "was" : "were"} not answered`;
  const lines = entries.map((e) => {
    const who = e.authorName?.trim() || "unknown sender";
    const words = e.body.replace(/\s+/g, " ").trim().slice(0, 160);
    const route = e.route ? ` (route ${e.route})` : "";
    return `- ${formatDelay(e.ageMs)} late, ${who}: "${words}"${route}. ${OUTCOME_TEXT[e.outcome]}.`;
  });
  const detail =
    `WhatsApp delivered ${n === 1 ? "this message" : "these messages"} more than ` +
    `${Math.round(LATE_MESSAGE_AFTER_MS / 60_000)} minutes after ${n === 1 ? "it was" : "they were"} sent ` +
    "(usually a copy that could not be decrypted at first, or a restart catch-up). " +
    "Attendance is still recorded silently; nothing else is acted on so late.\n" +
    lines.join("\n");
  const dedupeKey = `late:${[...entries.map((e) => e.waMessageId)].sort().join(",")}`.slice(0, 500);
  return { title, detail, dedupeKey };
}

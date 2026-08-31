/**
 * The honest-ack rule for attendance writes, as pure logic. (2026-08-31)
 *
 * THE GOLDEN RULE, the same one PR #18 put on the DM path
 * (`buildTentativeFollowupAck`) and `out-of-band-self-attendance.ts`:
 * never tell a player something happened unless it actually landed. A
 * failed write gets an honest, useful sentence, not a cheerful tick.
 *
 * This module is the GROUP-path half of that rule — roughly 20x the
 * traffic of the DM path, and the one place it was never applied: the
 * analyze route wrapped `registerAttendance` / `cancelAttendance` in a
 * bare try/catch, logged, and let the LLM's "you're in!" go out anyway.
 * The player turns up believing they're playing and nothing surfaces
 * anywhere.
 *
 * Deliberately pure so the wording, the no-op boundary and the stored
 * action are unit-testable with no DB (repo convention).
 *
 * WHAT COUNTS AS A FAILURE — only a write that THREW. Explicitly NOT:
 *   • an OUT from a player with no CONFIRMED/BENCH row (nothing to
 *     drop; the route returns before attempting any write),
 *   • an idempotent repeat IN from an already-confirmed player
 *     (registerAttendance returns CONFIRMED and throws nothing).
 * Both are normal, and apologising for them would be its own bug.
 */

export type AttendanceWriteAction = "IN" | "OUT" | "BENCH";

export interface AttendanceWriteFailure {
  /** What we were trying to do when it threw. */
  action: AttendanceWriteAction;
  /** null = the sender's own row. Otherwise the third party's name. */
  who: string | null;
  /** The thrown error, for the operator-facing log line. */
  error: string;
}

export interface AttendanceAckInput {
  /** Empty means every write either landed or was never attempted. */
  failures: AttendanceWriteFailure[];
  /** What the bot was about to react with. */
  react: string | null;
  /** What the bot was about to say. */
  reply: string | null;
  /** The sender's display name, for warmth. May be a raw phone number. */
  senderName: string | null;
}

export interface AttendanceAck {
  react: string | null;
  reply: string | null;
  /** True only when a write actually threw. Drives handledBy/action. */
  failed: boolean;
}

/** A pushname that is really just digits is never printed as a name. */
function usableFirstName(raw: string | null): string | null {
  const name = (raw ?? "").trim();
  if (!name) return null;
  if (!/\p{L}/u.test(name)) return null; // "447700900009"
  const first = name.split(/\s+/)[0];
  return first.length >= 2 ? first : null;
}

function joinNames(names: string[]): string {
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The single decision: does this verdict's ack survive contact with
 * what the database actually did?
 *
 * No failures → pass everything through untouched (a success and a
 * legitimate no-op are indistinguishable here, and both are fine).
 * Any failure → the react is dropped (a ✅ is as much a lie as a
 * sentence) and the reply is replaced with the truth.
 */
export function resolveAttendanceAck(input: AttendanceAckInput): AttendanceAck {
  if (input.failures.length === 0) {
    return { react: input.react, reply: input.reply, failed: false };
  }
  return {
    react: null,
    reply: buildAttendanceFailureReply(input.failures, input.senderName),
    failed: true,
  };
}

/**
 * What we say in the group when a write threw. Short, warm, and above
 * all TRUE: it states the state the squad is actually in, and gives one
 * concrete next step. House style: no em dashes, no slashes.
 */
export function buildAttendanceFailureReply(
  failures: AttendanceWriteFailure[],
  senderName: string | null,
): string {
  const self = failures.find((f) => f.who === null);
  const others = [...new Set(failures.filter((f) => f.who).map((f) => f.who as string))];
  const first = usableFirstName(senderName);
  const greeting = first ? `Sorry ${first}, ` : "Sorry, ";

  let clause: string;
  if (self && self.action === "OUT") {
    clause = "I couldn't save that just now, so you're still down as playing";
  } else if (self) {
    clause = "I couldn't save that just now, so you're not on the list yet";
  } else {
    clause = `I couldn't save that change for ${joinNames(others)} just now, so the squad hasn't changed`;
  }

  const extra =
    self && others.length > 0 ? ` I couldn't update ${joinNames(others)} either.` : "";

  return `${greeting}${clause}.${extra} Please send it again in a minute and I'll sort it 🙏`;
}

/**
 * What goes in `AnalyzedMessage.action`. The bug's quiet second half:
 * the row used to store the INTENDED action ("IN"), so a failed write
 * was invisible in the data as well as in the chat. This stores what
 * actually happened.
 */
export function attendanceFailureAction(failures: AttendanceWriteFailure[]): string {
  const parts = failures.map((f) => (f.who ? `${f.action}:${f.who}` : f.action));
  const joined = parts.join(",");
  const prefix = "attendance-failed:";
  return (prefix + joined).slice(0, 200);
}

/** The operator-facing log line. Read by whoever is on the incident. */
export function attendanceFailureLog(failures: AttendanceWriteFailure[]): string {
  const detail = failures
    .map((f) => `${f.action}${f.who ? ` for ${f.who}` : " (sender)"}: ${f.error}`)
    .join(" | ");
  return `CRITICAL: attendance write FAILED on the group path, nothing was saved and the player was told so. ${detail}`;
}

export interface ParsedAttendanceFailure {
  action: AttendanceWriteAction;
  /** null = the sender's own row. */
  who: string | null;
}

/**
 * Read `AnalyzedMessage.action` back into something an admin surface can
 * render. Tolerates the 200-char truncation by dropping any trailing
 * fragment it cannot understand rather than guessing.
 */
export function parseAttendanceFailureAction(
  action: string | null | undefined,
): ParsedAttendanceFailure[] {
  const prefix = "attendance-failed:";
  if (!action || !action.startsWith(prefix)) return [];
  const out: ParsedAttendanceFailure[] = [];
  for (const part of action.slice(prefix.length).split(",")) {
    const [verb, ...rest] = part.split(":");
    if (verb !== "IN" && verb !== "OUT" && verb !== "BENCH") continue;
    const who = rest.join(":").trim();
    out.push({ action: verb, who: who.length > 0 ? who : null });
  }
  return out;
}

/** One plain-English line for the admin queue. No jargon, no ids. */
export function describeAttendanceFailure(
  targets: ParsedAttendanceFailure[],
  senderName: string | null,
): string {
  const first = targets[0];
  if (!first) return "An attendance change failed";
  const who = (senderName ?? "").trim() || "Someone";
  if (first.who === null) {
    return first.action === "OUT" ? `${who} tried to drop out` : `${who} tried to join`;
  }
  const verb = first.action === "OUT" ? "drop" : first.action === "BENCH" ? "bench" : "add";
  return `${who} tried to ${verb} ${first.who}`;
}

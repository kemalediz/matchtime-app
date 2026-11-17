/**
 * THE ROW OF A "WHO IS THAT?" ABOUT A PLACE (2026-11-17, Sutton).
 *
 * MatchTime asked the sender "Do you mean Yoobie, or is Abu Ayoub a new
 * player?". The question is kept as a `SentNotification` (what MatchTime
 * sent; no migration), apart from the asking message's own
 * `AnalyzedMessage`, whose intent stays what happened. The shape, the
 * reader and the TTL are in `pipeline/awaiting-answer.ts`
 * (`AttendanceAskPayload`, `openAttendanceAsks`); the loader is
 * `loadOpenStatsClarifications`. Logs carry ids only.
 */
import { db } from "./db";
import {
  ATTENDANCE_ASK_KIND,
  attendanceAskKeyPrefix,
  parseAttendanceAsk,
  type AttendanceAskPayload,
} from "./pipeline/awaiting-answer";
import type { AttendanceAskRecord } from "./attendance-engine-batch";

/** Open the question. Idempotent per asking message (a Pi replay). */
export async function recordAttendanceAsk(
  orgId: string,
  askerName: string | null,
  a: AttendanceAskRecord,
): Promise<void> {
  const payload: AttendanceAskPayload = {
    v: 1,
    askerName,
    body: a.body,
    ref: a.ref,
    candidateIds: a.candidateIds,
    answeredAt: null,
  };
  const key = `${attendanceAskKeyPrefix(orgId)}${a.waMessageId}`;
  await db.sentNotification.upsert({
    where: { key },
    create: {
      key,
      kind: ATTENDANCE_ASK_KIND,
      matchId: a.matchId,
      targetUser: a.askerUserId,
      text: JSON.stringify(payload),
    },
    update: {},
  });
}

/** Close a question: its answer was read. */
export async function closeAttendanceAsk(id: string, now: Date = new Date()): Promise<void> {
  const row = await db.sentNotification.findUnique({ where: { id }, select: { text: true } });
  const p = parseAttendanceAsk(row?.text ?? null);
  if (!p || p.answeredAt) return;
  await db.sentNotification.update({
    where: { id },
    data: { text: JSON.stringify({ ...p, answeredAt: now.toISOString() }) },
  });
}

/**
 * Queue the group announcement for an OUT-OF-BAND attendance change
 * (a DM reply, or the web app). See out-of-band-attendance.ts for the why.
 *
 * Never throws at the caller: an announcement failing must never roll back
 * or mask a registration that already succeeded. Callers `.catch()` anyway.
 */
import { db } from "./db";
import { getOrgFeatures } from "./org-features";
import {
  buildOutOfBandAttendanceLine,
  shouldAnnounceAttendanceChange,
  withinOutOfBandAnnouncementCap,
  type AttendanceStatusLike,
  type OutOfBandSource,
  type OutOfBandStatus,
} from "./out-of-band-attendance";

const WINDOW_MS = 60 * 60 * 1000;

/** SentNotification.kind used as the rate ledger. Deliberately NOT one of
 *  dispatch-claim's GROUP_DIRECTED_KINDS, so these rows are never
 *  double-counted by the outbound circuit breaker. */
const LEDGER_KIND = "oob-attend";

export interface AnnounceOutOfBandInput {
  matchId: string;
  userId: string;
  /** Attendance status BEFORE the write (null = no row at all). */
  before: AttendanceStatusLike;
  /** Attendance status AFTER the write. */
  after: OutOfBandStatus | null;
  source: OutOfBandSource;
}

export interface AnnounceOutOfBandResult {
  announced: boolean;
  reason?: string;
  text?: string;
}

export async function announceOutOfBandAttendance(
  input: AnnounceOutOfBandInput,
): Promise<AnnounceOutOfBandResult> {
  // 1. Only a REAL state change is worth a post. A repeat "IN" from an
  //    already-confirmed player changed nothing, so the group hears nothing.
  if (!shouldAnnounceAttendanceChange(input.before, input.after)) {
    return { announced: false, reason: "no-state-change" };
  }
  const after = input.after as OutOfBandStatus;

  const match = await db.match.findUnique({
    where: { id: input.matchId },
    select: { id: true, maxPlayers: true, activity: { select: { orgId: true } } },
  });
  if (!match) return { announced: false, reason: "match-missing" };
  const orgId = match.activity.orgId;

  // 2. A MoM/ratings-only org has no squad to report a count for.
  const features = await getOrgFeatures(orgId);
  if (!features.attendance) return { announced: false, reason: "attendance-off" };

  // 3. Spam guard — see MAX_OUT_OF_BAND_ANNOUNCEMENTS_PER_HOUR.
  const recent = await db.sentNotification.count({
    where: {
      kind: LEDGER_KIND,
      key: { startsWith: `org-${orgId}:${LEDGER_KIND}:` },
      createdAt: { gte: new Date(Date.now() - WINDOW_MS) },
    },
  });
  if (!withinOutOfBandAnnouncementCap(recent)) {
    console.warn(
      `[oob-announce] org ${orgId}: ${recent} out-of-band announcements in the last hour — ` +
        `suppressing this one to protect the group-message budget. Registration still applied.`,
    );
    return { announced: false, reason: "rate-capped" };
  }

  // 4. The count comes from the DB, AFTER the write. Never an estimate.
  const confirmedCount = await db.attendance.count({
    where: { matchId: input.matchId, status: "CONFIRMED" },
  });
  const user = await db.user.findUnique({
    where: { id: input.userId },
    select: { name: true },
  });

  const text = buildOutOfBandAttendanceLine({
    playerName: user?.name ?? null,
    status: after,
    source: input.source,
    confirmedCount,
    maxPlayers: match.maxPlayers,
  });

  // 5. Ledger row FIRST so a crash between the two can only ever LOSE an
  //    announcement, never emit one that the cap cannot see.
  try {
    await db.sentNotification.create({
      data: {
        key: `org-${orgId}:${LEDGER_KIND}:${input.matchId}:${input.userId}:${Date.now()}`,
        kind: LEDGER_KIND,
        matchId: input.matchId,
        targetUser: input.userId,
      },
    });
  } catch (err) {
    console.error("[oob-announce] ledger write failed:", err);
    return { announced: false, reason: "ledger-failed" };
  }

  await db.botJob.create({ data: { orgId, kind: "group", text } });
  return { announced: true, text };
}

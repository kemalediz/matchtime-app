/**
 * Apply a player's OWN out-of-band in/out: write it, tell them, tell the
 * group. (2026-08-31)
 *
 * Extracted verbatim from the cold self-attendance block in
 * /api/whatsapp/dm-reply (PR #18) when the 👍-on-the-invite reaction was
 * added, so both entry points land on ONE implementation. Two code paths
 * that each "register a player" would drift on capacity rules, on ack
 * wording, and on when the group hears about it, and the DM one is
 * already live.
 *
 * THE GOLDEN RULE, preserved from PR #18: never tell a player something
 * happened unless it actually landed. A failed write gets an honest
 * apology, not a cheerful tick, and the group hears nothing.
 */
import { db } from "./db";
import { registerAttendance, cancelAttendance } from "./attendance";
import { announceOutOfBandAttendance } from "./out-of-band-announce";
import {
  shouldAnnounceAttendanceChange,
  type AttendanceStatusLike,
  type OutOfBandSource,
} from "./out-of-band-attendance";

export interface ApplyOutOfBandSelfAttendanceInput {
  userId: string;
  matchId: string;
  orgId: string;
  /** The player's own decision. Never a third party's. */
  decision: "in" | "out";
  matchName: string;
  /** "EEE d MMM, HH:mm" London. */
  matchWhen: string;
  /** How they told us. Drives the group line's wording. */
  source: OutOfBandSource;
  /** Where to send their personal confirmation, E.164 without the `+`.
   *  Null means we have no way to reply; the write still happens. */
  replyPhone: string | null;
}

export interface ApplyOutOfBandSelfAttendanceResult {
  /** Status AFTER the write, or null when nothing changed. */
  status: "CONFIRMED" | "BENCH" | "DROPPED" | null;
  /** Status BEFORE the write (null = no attendance row at all). */
  before: AttendanceStatusLike;
  /** True when the write threw. The ack says so and nothing is announced. */
  failed: boolean;
  /** The text DMed back to the player (queued only when replyPhone is set). */
  ack: string;
  /** Did we queue a group announcement? False for a no-op repeat. */
  announced: boolean;
}

export async function applyOutOfBandSelfAttendance(
  input: ApplyOutOfBandSelfAttendanceInput,
): Promise<ApplyOutOfBandSelfAttendanceResult> {
  const priorRow = await db.attendance.findUnique({
    where: { matchId_userId: { matchId: input.matchId, userId: input.userId } },
    select: { status: true },
  });
  const before: AttendanceStatusLike =
    priorRow?.status === "CONFIRMED" ||
    priorRow?.status === "BENCH" ||
    priorRow?.status === "DROPPED"
      ? priorRow.status
      : null;

  let status: ApplyOutOfBandSelfAttendanceResult["status"] = null;
  let failed = false;
  try {
    if (input.decision === "in") {
      // promoteFromBench: this is the player's OWN claim, so a bencher
      // saying IN moves up if a slot freed. Capacity is honoured by
      // registerAttendance exactly as in the group path — a full squad
      // puts them on the bench, it does NOT roll them onto a later match.
      const res = await registerAttendance(input.userId, input.matchId, {
        promoteFromBench: true,
        // A 1:1 DM to the bot. The player's own claim; the fact that
        // the group could not see it is `sourceRef`, not a new cause.
        event: {
          cause: "self-attendance",
          actorKind: "player",
          actorUserId: input.userId,
          sourceRef: "dm:self-attendance",
        },
      });
      status = res.status === "BENCH" ? "BENCH" : "CONFIRMED";
    } else if (before === "CONFIRMED" || before === "BENCH") {
      await cancelAttendance(input.userId, input.matchId, {
        cause: "self-attendance",
        actorKind: "player",
        actorUserId: input.userId,
        sourceRef: "dm:self-attendance",
      });
      status = "DROPPED";
    }
  } catch (err) {
    failed = true;
    console.error("[oob-self-attendance] write failed:", err);
  }

  const ack = buildSelfAttendanceAck({
    failed,
    status,
    matchName: input.matchName,
    matchWhen: input.matchWhen,
  });

  if (input.replyPhone) {
    await db.botJob
      .create({ data: { orgId: input.orgId, kind: "dm", phone: input.replyPhone, text: ack } })
      .catch((err) => console.error("[oob-self-attendance] ack DM queue failed:", err));
  }

  // Tell the GROUP: this registration is invisible to everyone else.
  // A repeat that changed nothing is not news — the announcer guards this
  // too, but checking here keeps the result honest and the test direct.
  let announced = false;
  if (!failed && shouldAnnounceAttendanceChange(before, status)) {
    announced = true;
    await announceOutOfBandAttendance({
      matchId: input.matchId,
      userId: input.userId,
      before,
      after: status,
      source: input.source,
    }).catch((err) => {
      console.error("[oob-self-attendance] group announce failed:", err);
    });
  }

  return { status, before, failed, ack, announced };
}

/**
 * The player's personal confirmation. Pure, so the wording is testable
 * and identical whether they replied or reacted.
 */
export function buildSelfAttendanceAck(input: {
  failed: boolean;
  status: "CONFIRMED" | "BENCH" | "DROPPED" | null;
  matchName: string;
  matchWhen: string;
}): string {
  const { matchName, matchWhen } = input;
  if (input.failed) {
    return (
      `Sorry, I couldn't update the squad just now. An admin will sort it — ` +
      `try again in a bit if you like 🙏`
    );
  }
  if (input.status === "CONFIRMED") {
    return `✅ You're in for *${matchName}* on ${matchWhen}. See you there ⚽`;
  }
  if (input.status === "BENCH") {
    return (
      `📋 Squad's full for *${matchName}* on ${matchWhen}, so I've put you ` +
      `first on the bench. I'll message you the moment a spot opens 🙏`
    );
  }
  if (input.status === "DROPPED") {
    return `👋 No worries, you're marked out for *${matchName}* on ${matchWhen}. Thanks for letting me know.`;
  }
  return `👍 Noted. You weren't down for *${matchName}* on ${matchWhen} anyway, so nothing's changed.`;
}

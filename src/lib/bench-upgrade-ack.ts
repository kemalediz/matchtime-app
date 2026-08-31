/**
 * The reply for a BENCH-shaped verdict that landed as a CONFIRMED write.
 *
 * A standing-offer conditional ("I'll be the 14th if you're short") is
 * classified as registerAttendance:"BENCH", and the LLM composes its
 * reply from that: "Thanks Erdal, putting you on the bench. If we drop
 * below 14 you're first up." That text is written BEFORE the server
 * knows the squad state. Since 2026-08-31 registerAttendance refuses to
 * create a bench row while slots are open (see lib/attendance.ts,
 * BenchIntent) and confirms the player instead, so that reply would tell
 * them the opposite of what happened.
 *
 * Same house rule as lib/attendance-write-outcome.ts: the bot never
 * announces something the database disagrees with.
 */

/** First whitespace-separated token, or null when we have no usable name. */
function firstName(name: string | null): string | null {
  const first = (name ?? "").trim().split(/\s+/)[0];
  return first ? first : null;
}

export function buildBenchUpgradeReply(args: {
  /** Display name of the player we just confirmed. */
  name: string | null;
  /** CONFIRMED count AFTER the write. */
  confirmedCount: number;
  maxPlayers: number;
}): string {
  const { confirmedCount, maxPlayers } = args;
  const who = firstName(args.name);
  const thanks = who ? `Thanks ${who} 🙌` : "Thanks 🙌";
  const count = `${confirmedCount}/${maxPlayers}`;

  // Their confirm took the last slot: don't imply there's still room.
  if (confirmedCount >= maxPlayers) {
    return `${thanks} You're in the squad, and that's us full at ${count}.`;
  }
  return `${thanks} We've got space, so you're straight in the squad: ${count}.`;
}

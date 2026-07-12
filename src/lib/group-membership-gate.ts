/**
 * APP SELF-IN GROUP-MEMBERSHIP GATE.
 *
 * Closes a loophole: a signed-in web user (matchtime.ai) could mark
 * THEMSELVES "in" on a match even if they were NOT part of the org's
 * WhatsApp group. Attendance is a group activity — self-IN from the app
 * must be reserved for real group members.
 *
 * This gate applies ONLY to the app's self-IN action (the `attendMatch`
 * server action → the "I'm in!" button). It does NOT touch:
 *   - the WhatsApp bot path (analyze route → registerAttendance),
 *   - guest-adds a member types from inside the WhatsApp group,
 *   - admin add-player from the dashboard,
 * all of which legitimately register people who may not (yet) be group
 * members and stay ungated.
 *
 * "LLM extracts, code decides" sibling: pure, DB-free logic. The caller
 * (attendMatch) fetches the Membership row for the match's org and feeds
 * the relevant fields in.
 */

export interface GateMembership {
  /** Non-null once the user has left / been removed from the org's
   *  WhatsApp group. Strongest deny signal — someone who left the group
   *  cannot self-IN, regardless of role. */
  leftAt: Date | null;
  /** Last time the bot saw this user in the org's WhatsApp group
   *  participant sync. Null = never confirmed in the group. */
  lastSeenInGroupAt: Date | null;
  role: "OWNER" | "ADMIN" | "PLAYER";
}

/**
 * May this user mark THEMSELVES in from the app?
 *
 * ALLOW only when the membership exists AND:
 *   - leftAt == null (still in the group), AND
 *   - lastSeenInGroupAt != null (bot confirmed them in the group sync)
 *     OR role is OWNER/ADMIN (admins/owners manage the roster and are
 *     exempt from the group-sync requirement — but NOT from leftAt).
 *
 * A null membership → false (not a member of the org at all).
 */
export function canSelfMarkIn(m: GateMembership | null): boolean {
  if (!m) return false;
  // A member who left the WhatsApp group can never self-IN — this is the
  // strongest signal and the admin exemption does NOT override it.
  if (m.leftAt !== null) return false;
  // Admins/owners manage the roster; they don't need a group-sync sighting.
  if (m.role === "OWNER" || m.role === "ADMIN") return true;
  // A plain player must have been confirmed in the group's participant sync.
  return m.lastSeenInGroupAt !== null;
}

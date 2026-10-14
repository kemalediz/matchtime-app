/**
 * WHO DID AN ADMIN ADD AS A MEMBER? (2026-10-14.)
 *
 * The rolling squad carries last week's players, but not a phoneless
 * placeholder: that is usually a one-off guest ("my mate Gary is in"),
 * who cannot be DMed, cannot say OUT himself, and was never asked. A
 * phoneless player an admin added AS A MEMBER is carried. The club
 * rehearsal found "Uncle", pasted in the admin group in week 1, dropped
 * from week 2 because nothing told the two apart.
 *
 * The durable marker is the append-only AttendanceEvent log, not a new
 * column. An admin actor put the player on a squad of THIS club
 * (toStatus CONFIRMED or BENCH) through one of exactly these paths:
 *
 *   cause "admin-message",  sourceRef "admin-group:<waMessageId>"
 *       the club's linked ADMIN GROUP: a pasted list's YES
 *       (`admin-group-paste.ts`) or a typed squad change
 *       (`admin-group-squad-change.ts`). Both writers stamp this prefix.
 *   cause "admin-squad-edit", sourceRef "admin:addPlayerToMatch"
 *       an admin's "Add to match" on the match page.
 *
 * NOT counted, on purpose:
 *   - an admin's third-party add in the PLAYERS' group ("my mate Gary is
 *     in"): cause "admin-message" too (`attendance-engine.ts`), but its
 *     sourceRef is the bare message id. That is a guest for one game;
 *     carried forever he could never say OUT;
 *   - promoting somebody already registered: move up from the bench,
 *     promote onto a team, reorder the waiting list, organiser pick;
 *   - "Carry over last squad" (cause "rolling-squad", actorKind admin),
 *     which carries whoever it carries.
 *
 * Admin-group events written before 2026-10-14 carry the bare message id
 * and so do not count: a placeholder an admin added then is treated as a
 * guest until an admin adds him again. The log is never updated or
 * deleted (a Postgres trigger), so once counted, always counted,
 * including the week after, when last week's row was written by the
 * seeding.
 */

/** The `sourceRef` prefix every admin-group squad write carries. */
export const ADMIN_GROUP_SOURCE_PREFIX = "admin-group:";

/** The `sourceRef` for a squad write made from the admin group. */
export function adminGroupSourceRef(waMessageId: string | null | undefined): string {
  const ref = waMessageId ?? "";
  return ref.startsWith(ADMIN_GROUP_SOURCE_PREFIX) ? ref : `${ADMIN_GROUP_SOURCE_PREFIX}${ref}`;
}

/** The paths that mean "an admin added this player as a member". */
export const ADMIN_ADD_PATHS = [
  { cause: "admin-message", sourceRef: { startsWith: ADMIN_GROUP_SOURCE_PREFIX } },
  { cause: "admin-squad-edit", sourceRef: "admin:addPlayerToMatch" },
] as const;

type AdminAddPath = { cause: string; sourceRef: string | { startsWith: string } };

/** The part of the Prisma client (or of a transaction) this reads through. */
export interface AdminAddedReadClient {
  attendanceEvent: {
    findMany(args: {
      where: {
        orgId: string;
        userId: { in: string[] };
        actorKind: "admin";
        toStatus: { in: Array<"CONFIRMED" | "BENCH"> };
        OR: AdminAddPath[];
      };
      select: { userId: true };
      distinct: ["userId"];
    }): Promise<Array<{ userId: string }>>;
  };
}

/** Of `userIds`, the ones an admin has added as members of `orgId`. */
export async function loadAdminAddedUserIds(
  client: AdminAddedReadClient,
  orgId: string,
  userIds: string[],
): Promise<Set<string>> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return new Set();
  const rows = await client.attendanceEvent.findMany({
    where: {
      orgId,
      userId: { in: ids },
      actorKind: "admin",
      toStatus: { in: ["CONFIRMED", "BENCH"] },
      OR: ADMIN_ADD_PATHS.map((p) => ({ ...p })),
    },
    select: { userId: true },
    distinct: ["userId"],
  });
  return new Set(rows.map((r) => r.userId));
}
